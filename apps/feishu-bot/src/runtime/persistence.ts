import {
  ConnectionRegistrationStore,
  ConnectionTargetStore,
  EnvironmentCacheStore,
} from "@t3tools/client-runtime/platform";
import { TokenStore } from "@t3tools/client-runtime/authorization";
import { CredentialStore, ProfileStore } from "@t3tools/client-runtime/connection";
import type { ConnectionCredential, ConnectionProfile } from "@t3tools/client-runtime/connection";
import type {
  CommandId,
  EnvironmentId,
  OrchestrationShellSnapshot,
  OrchestrationThread,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeOS from "node:os";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

/**
 * Entirely in-memory implementations of the connection persistence services.
 *
 * M0 has no durable storage requirement, so every store is a `Map` (or a
 * trivial empty/no-op effect). Persistence (SQLite/file) is deferred to a later
 * milestone. The shapes here mirror `apps/mobile/src/connection/storage.ts`,
 * minus the on-disk catalog machinery, and are all built once inside a single
 * `Layer.effectContext` so the backing maps are shared across the yielded
 * services.
 */
export const connectionStorageLayer: Layer.Layer<
  | ConnectionTargetStore
  | ConnectionRegistrationStore
  | ProfileStore.ConnectionProfileStore
  | CredentialStore.ConnectionCredentialStore
  | TokenStore.RemoteDpopAccessTokenStore
  | EnvironmentCacheStore
> = Layer.effectContext(
  Effect.sync(() => {
    const profileMap = new Map<string, ConnectionProfile>();
    const credentialMap = new Map<string, ConnectionCredential>();
    const remoteTokenMap = new Map<EnvironmentId, TokenStore.RemoteDpopAccessToken>();
    const shellMap = new Map<EnvironmentId, OrchestrationShellSnapshot>();
    const threadMap = new Map<string, OrchestrationThread>();

    const threadKey = (environmentId: EnvironmentId, threadId: ThreadId) =>
      `${environmentId}::${threadId}`;

    const targetStore = ConnectionTargetStore.of({
      list: Effect.succeed([]),
    });

    const registrationStore = ConnectionRegistrationStore.of({
      register: () => Effect.void,
      remove: () => Effect.void,
    });

    const profileStore = ProfileStore.make({
      get: (connectionId) =>
        Effect.sync(() => Option.fromUndefinedOr(profileMap.get(connectionId))),
      put: (profile) =>
        Effect.sync(() => {
          profileMap.set(profile.connectionId, profile);
        }),
      remove: (connectionId) =>
        Effect.sync(() => {
          profileMap.delete(connectionId);
        }),
    });

    const credentialStore = CredentialStore.make({
      get: (connectionId) =>
        Effect.sync(() => Option.fromUndefinedOr(credentialMap.get(connectionId))),
      put: (connectionId, credential) =>
        Effect.sync(() => {
          credentialMap.set(connectionId, credential);
        }),
      remove: (connectionId) =>
        Effect.sync(() => {
          credentialMap.delete(connectionId);
        }),
    });

    const remoteTokenStore = TokenStore.make({
      get: (environmentId) =>
        Effect.sync(() => Option.fromUndefinedOr(remoteTokenMap.get(environmentId))),
      put: (token) =>
        Effect.sync(() => {
          remoteTokenMap.set(token.environmentId, token);
        }),
      remove: (environmentId) =>
        Effect.sync(() => {
          remoteTokenMap.delete(environmentId);
        }),
    });

    const cacheStore = EnvironmentCacheStore.of({
      loadShell: (environmentId) =>
        Effect.sync(() => Option.fromUndefinedOr(shellMap.get(environmentId))),
      saveShell: (environmentId, snapshot) =>
        Effect.sync(() => {
          shellMap.set(environmentId, snapshot);
        }),
      loadThread: (environmentId, threadId) =>
        Effect.sync(() =>
          Option.fromUndefinedOr(threadMap.get(threadKey(environmentId, threadId))),
        ),
      saveThread: (environmentId, thread) =>
        Effect.sync(() => {
          threadMap.set(threadKey(environmentId, thread.id), thread);
        }),
      removeThread: (environmentId, threadId) =>
        Effect.sync(() => {
          threadMap.delete(threadKey(environmentId, threadId));
        }),
      clear: (environmentId) =>
        Effect.sync(() => {
          shellMap.delete(environmentId);
          const prefix = `${environmentId}::`;
          // Deleting during Map iteration is well-defined; entries removed after
          // the current position are simply not visited.
          for (const key of threadMap.keys()) {
            if (key.startsWith(prefix)) {
              threadMap.delete(key);
            }
          }
        }),
    });

    return Context.make(ConnectionTargetStore, targetStore).pipe(
      Context.add(ConnectionRegistrationStore, registrationStore),
      Context.add(ProfileStore.ConnectionProfileStore, profileStore),
      Context.add(CredentialStore.ConnectionCredentialStore, credentialStore),
      Context.add(TokenStore.RemoteDpopAccessTokenStore, remoteTokenStore),
      Context.add(EnvironmentCacheStore, cacheStore),
    );
  }),
);

// ───────────────────────────────────────────────────────────────────────────
// Durable file-backed stores (M1)
//
// The bot needs two pieces of state to survive a restart: the chat↔thread
// binding (so a returning chat re-uses its shared session) and the set of
// already-dispatched commandIds (so re-delivery stays idempotent locally,
// ahead of the server's own commandReceipt dedup).
//
// Both are exposed through small, intent-revealing service interfaces. The M1
// backend is an in-memory `Map` mirrored to a JSON file with atomic writes; M4
// can swap the backend for SQLite without touching any caller — they only ever
// see the service interfaces below.
// ───────────────────────────────────────────────────────────────────────────

/** Failure reading or writing one of the bot's durable JSON stores. */
export class FeishuBotPersistenceError extends Data.TaggedError("FeishuBotPersistenceError")<{
  /** Absolute path of the store file involved. */
  readonly path: string;
  /** Human-readable description of what failed. */
  readonly message: string;
  /** Underlying cause (usually a Node `fs` error). */
  readonly cause: unknown;
}> {}

/**
 * Backend contract shared by every durable store: load the whole record map
 * once, then persist the whole map atomically on every mutation. The map is a
 * plain string→value record so it serialises directly to JSON. M1 ships a
 * JSON-file backend ({@link jsonFileBackend}); M4 can provide a SQLite-backed
 * implementation of this same interface.
 */
export interface PersistenceBackend<V> {
  /** Read the persisted record map, or an empty map if the file is absent. */
  readonly load: Effect.Effect<Record<string, V>, FeishuBotPersistenceError>;
  /** Atomically replace the persisted record map with `next`. */
  readonly save: (next: Record<string, V>) => Effect.Effect<void, FeishuBotPersistenceError>;
}

/** Resolved platform services the JSON backend closes over (so its effects stay
 *  total — only `FeishuBotPersistenceError` in the error channel, no `R`). */
interface PlatformServices {
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
}

// JSON (de)serialisation via Schema rather than raw `JSON.parse`/`stringify`
// (the store record is opaque `unknown` at the schema boundary; callers narrow
// to `Record<string, V>` since the values are app-controlled brands/booleans).
const decodeJson = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);
const encodeJson = Schema.encodeUnknownEffect(Schema.UnknownFromJsonString);

/**
 * JSON-file {@link PersistenceBackend}: reads/writes a single file at `path`.
 *
 * - `load` returns `{}` when the file does not yet exist (cold start), and
 *   fails only on genuine IO/parse errors.
 * - `save` writes atomically: serialise → write to a temp sibling → `rename`
 *   over the target, so a crash mid-write can never leave a truncated file.
 *
 * The parent directory is created on first save. Built from already-resolved
 * `FileSystem`/`Path` services so the returned effects carry no requirements.
 */
export const jsonFileBackend = <V>(
  filePath: string,
  platform: PlatformServices,
): PersistenceBackend<V> => {
  const { fs, path } = platform;
  const dir = path.dirname(filePath);
  const fail = (message: string) => (cause: unknown) =>
    new FeishuBotPersistenceError({ path: filePath, message, cause });

  return {
    load: Effect.gen(function* () {
      const present = yield* fs
        .exists(filePath)
        .pipe(Effect.mapError(fail("Could not load store file.")));
      if (!present) {
        // Cold start: no file yet.
        return {} as Record<string, V>;
      }
      const raw = yield* fs
        .readFileString(filePath, "utf8")
        .pipe(Effect.mapError(fail("Could not load store file.")));
      const parsed = yield* decodeJson(raw).pipe(
        Effect.mapError(fail("Store file is not valid JSON.")),
      );
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return yield* new FeishuBotPersistenceError({
          path: filePath,
          message: "Store file is not a JSON object.",
          cause: parsed,
        });
      }
      return parsed as Record<string, V>;
    }),
    save: (next) =>
      Effect.gen(function* () {
        yield* fs
          .makeDirectory(dir, { recursive: true })
          .pipe(Effect.mapError(fail("Could not save store file.")));
        const serialised = yield* encodeJson(next).pipe(
          Effect.mapError(fail("Could not serialise store contents.")),
        );
        // Unique temp sibling: pid + monotonic-enough clock millis. `Clock`
        // (an Effect reference with a runtime default) replaces `Date.now()`.
        const stamp = yield* Clock.currentTimeMillis;
        const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${stamp}.tmp`);
        yield* fs
          .writeFileString(tmp, serialised)
          .pipe(Effect.mapError(fail("Could not save store file.")));
        yield* fs.rename(tmp, filePath).pipe(Effect.mapError(fail("Could not save store file.")));
      }),
  };
};

/**
 * How a chat became bound to its thread.
 *
 * - `"self-created"`: the bot minted the thread on first contact
 *   (deterministic id from `chatId`; see `bridge/chatThreadMap.deriveThreadId`).
 * - `"resumed"`: an operator/user took over a thread that another end created,
 *   via `/resume` (M2a). The thread id is *not* derived from `chatId` in this
 *   case, so the origin must be persisted to drive recovery decisions.
 */
export type ChatBindingOrigin = "self-created" | "resumed";

/**
 * The *current* binding for a Feishu chat (M2a).
 *
 * M1 stored a bare {@link ThreadId} per chat. M2a promotes this to a mutable
 * "current binding" record so a chat can be re-pointed at a different thread
 * (`/resume` taking over another end's thread) and so the binding `origin`
 * survives a restart. The JSON value is this object; legacy bare-string values
 * are migrated on load (see {@link loadBackedMap}).
 */
export interface ChatBinding {
  /** The t3code thread this chat is currently bound to. */
  readonly threadId: ThreadId;
  /** How the binding was established (drives recovery; see {@link ChatBindingOrigin}). */
  readonly origin: ChatBindingOrigin;
}

/**
 * Persistent map of Feishu `chat_id` → current {@link ChatBinding}.
 *
 * The first message from a chat creates a thread and records the binding here;
 * every later message re-uses it, which is what makes the conversation a true
 * shared session across restarts. Keyed by `chat_id` (Feishu private chats are
 * 1:1, so one chat ↔ one binding). M2a stores the full {@link ChatBinding}
 * (threadId + origin), migrating M1's bare-`ThreadId` JSON on load.
 */
export class ChatThreadMapStore extends Context.Service<
  ChatThreadMapStore,
  {
    /** Resolve the binding for `chatId`, if any. */
    readonly get: (
      chatId: string,
    ) => Effect.Effect<Option.Option<ChatBinding>, FeishuBotPersistenceError>;
    /** Bind `chatId` to `binding` (overwrites any existing binding). */
    readonly put: (
      chatId: string,
      binding: ChatBinding,
    ) => Effect.Effect<void, FeishuBotPersistenceError>;
    /** Drop the binding for `chatId` (no-op if absent). */
    readonly remove: (chatId: string) => Effect.Effect<void, FeishuBotPersistenceError>;
    /** Snapshot every `[chatId, binding]` pair (e.g. for warm-up logging). */
    readonly entries: Effect.Effect<
      ReadonlyArray<readonly [string, ChatBinding]>,
      FeishuBotPersistenceError
    >;
  }
>()("@t3tools/feishu-bot/runtime/persistence/ChatThreadMapStore") {}

/**
 * Persistent set of already-dispatched `commandId`s, for local idempotency.
 *
 * Before dispatching a `ThreadTurnStart`/`createThread` the bridge derives a
 * stable commandId and checks `has`; on success it records it via `add`. This
 * is the first line of dedup against re-delivery after a crash — the server's
 * commandReceipt store is the authoritative second line.
 */
export class SentCommandStore extends Context.Service<
  SentCommandStore,
  {
    /** Whether `commandId` has already been dispatched. */
    readonly has: (commandId: CommandId) => Effect.Effect<boolean, FeishuBotPersistenceError>;
    /** Record `commandId` as dispatched (idempotent). */
    readonly add: (commandId: CommandId) => Effect.Effect<void, FeishuBotPersistenceError>;
  }
>()("@t3tools/feishu-bot/runtime/persistence/SentCommandStore") {}

/**
 * Build an in-memory map hydrated from `backend` plus a `persist` effect that
 * snapshots the current map back through `backend.save`. Shared construction
 * for the concrete stores below: each mutation updates the map then persists.
 *
 * `normalize` runs on every loaded value before it enters the in-memory map,
 * which is how a store migrates an older on-disk shape forward (e.g. M1's bare
 * `ThreadId` string → M2a's {@link ChatBinding} object — see
 * {@link chatThreadMapStoreLayer}). The backend is typed at the *new* value
 * shape `V`; `normalize` receives the raw loaded value as `unknown` so it can
 * discriminate legacy vs. current encodings. Omit it for stores whose on-disk
 * shape has never changed (identity).
 */
const loadBackedMap = <V>(
  backend: PersistenceBackend<V>,
  normalize: (raw: unknown) => V = (raw) => raw as V,
) =>
  Effect.gen(function* () {
    const initial = yield* backend.load;
    const map = new Map<string, V>(
      Object.entries(initial).map(([key, value]) => [key, normalize(value)]),
    );
    const persist = Effect.suspend(() => backend.save(Object.fromEntries(map)));
    return { map, persist } as const;
  });

/**
 * Migrate a raw on-disk binding value forward to the current {@link ChatBinding}
 * shape. M1 persisted a bare `ThreadId` string per chat; M2a persists the full
 * object. A legacy string is read as a `self-created` binding (the only origin
 * M1 ever produced); a current object is narrowed to the two live fields
 * (`threadId`, `origin`), dropping any extraneous keys an older M2a build may
 * have written (e.g. the now-removed `lastSequence`). Pure; runs once per entry
 * at load time.
 */
const migrateChatBinding = (raw: unknown): ChatBinding => {
  if (typeof raw === "string") {
    return { threadId: raw as ThreadId, origin: "self-created" };
  }
  const binding = raw as ChatBinding;
  return { threadId: binding.threadId, origin: binding.origin };
};

/**
 * {@link ChatThreadMapStore} layer backed by a JSON file at
 * `<stateDir>/chat-thread-map.json` (override the full path via `filePath`).
 *
 * Loads both M1 (bare-`ThreadId` string) and M2a ({@link ChatBinding} object)
 * on-disk shapes via {@link migrateChatBinding}; the first mutation rewrites the
 * file in the M2a shape (atomic tmp+rename, as for every store here).
 */
export const chatThreadMapStoreLayer = (options: {
  readonly stateDir: string;
  readonly filePath?: string;
}): Layer.Layer<ChatThreadMapStore, FeishuBotPersistenceError, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(
    ChatThreadMapStore,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const file = options.filePath ?? path.join(options.stateDir, "chat-thread-map.json");
      const backend = jsonFileBackend<ChatBinding>(file, { fs, path });
      const { map, persist } = yield* loadBackedMap(backend, migrateChatBinding);
      return ChatThreadMapStore.of({
        get: (chatId) => Effect.sync(() => Option.fromUndefinedOr(map.get(chatId))),
        put: (chatId, binding) =>
          Effect.suspend(() => {
            map.set(chatId, binding);
            return persist;
          }),
        remove: (chatId) =>
          Effect.suspend(() => {
            if (!map.delete(chatId)) {
              return Effect.void;
            }
            return persist;
          }),
        entries: Effect.sync(
          () => Array.from(map.entries()) as ReadonlyArray<readonly [string, ChatBinding]>,
        ),
      });
    }),
  );

/**
 * {@link SentCommandStore} layer backed by a JSON file at
 * `<stateDir>/sent-commands.json` (override the full path via `filePath`).
 *
 * The JSON shape is `{ [commandId]: true }`; the boolean payload is unused but
 * keeps the generic {@link jsonFileBackend} record contract uniform.
 */
export const sentCommandStoreLayer = (options: {
  readonly stateDir: string;
  readonly filePath?: string;
}): Layer.Layer<SentCommandStore, FeishuBotPersistenceError, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(
    SentCommandStore,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const file = options.filePath ?? path.join(options.stateDir, "sent-commands.json");
      const backend = jsonFileBackend<true>(file, { fs, path });
      const { map, persist } = yield* loadBackedMap(backend);
      return SentCommandStore.of({
        has: (commandId) => Effect.sync(() => map.has(commandId)),
        add: (commandId) =>
          Effect.suspend(() => {
            if (map.has(commandId)) {
              return Effect.void;
            }
            map.set(commandId, true);
            return persist;
          }),
      });
    }),
  );

/**
 * Convenience: both durable stores wired to JSON files under `stateDir`.
 * `bot.ts` provides this once at startup.
 */
export const fileStoresLayer = (options: {
  readonly stateDir: string;
}): Layer.Layer<
  ChatThreadMapStore | SentCommandStore,
  FeishuBotPersistenceError,
  FileSystem.FileSystem | Path.Path
> => Layer.merge(chatThreadMapStoreLayer(options), sentCommandStoreLayer(options));

/** Default per-user state directory (`~/.t3tools/feishu-bot`). */
export const defaultStateDir = (): string => `${NodeOS.homedir()}/.t3tools/feishu-bot`;
