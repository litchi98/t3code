import {
  ConnectionRegistrationStore,
  ConnectionTargetStore,
  EnvironmentCacheStore,
} from "@t3tools/client-runtime/platform";
import { TokenStore } from "@t3tools/client-runtime/authorization";
import { CredentialStore, ProfileStore } from "@t3tools/client-runtime/connection";
import type { ConnectionCredential, ConnectionProfile } from "@t3tools/client-runtime/connection";
import type { NonceProbe } from "../bridge/callbackAuth.js";
// Type-only: erased at compile time, so no runtime import cycle with the renderer.
import type { RenderDensity } from "../bridge/eventRenderer.js";
import type {
  CommandId,
  EnvironmentId,
  OrchestrationShellSnapshot,
  OrchestrationThread,
  ProjectId,
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
  /**
   * A message id belonging to this topic thread (the trigger/command message),
   * for paths that have no inbound trigger message of their own (shellWatcher
   * chained approval / observe fresh) to reuse as the `replyTo` anchor of
   * `reply_in_thread`. Feishu `reply_in_thread` accepts only a *message id*, not
   * an `omt_` thread id, so a message id must be stored. Optional: absent on p2p
   * / plain-group bindings and on legacy on-disk entries (→ `undefined`).
   */
  readonly topicAnchorMessageId?: string;
  /**
   * The render density fixed at bind time from the `chatType`, read by the
   * `driveTurn`/`observe` placeholder first frame so the placeholder does not
   * jump density when the real frame arrives. Optional: absent on legacy on-disk
   * entries (→ `undefined`, callers fall back to their computed default).
   */
  readonly density?: RenderDensity;
}

/**
 * Persistent map of a Feishu conversation key → current {@link ChatBinding}.
 *
 * The first message from a conversation creates a thread and records the binding
 * here; every later message re-uses it, which is what makes the conversation a
 * true shared session across restarts. M2a stored the full {@link ChatBinding}
 * (threadId + origin), migrating M1's bare-`ThreadId` JSON on load.
 *
 * M3a: the key is the composite `chatId[:larkThreadId]` produced by the bridge's
 * `compositeChatKey` — a group *topic* (`omt_…`) backs its own thread, so the
 * key distinguishes topics within one `chat_id`. p2p / plain-group keys have no
 * `larkThreadId` and so are a bare `chat_id` with no `:`, byte-identical to the
 * pre-M3a key. This store is key-agnostic (the value is opaque `string`), so old
 * on-disk entries (key = `chat_id`) are the natural degenerate form and load
 * with no migration. The `get`/`put`/`remove`/`entries` signatures are unchanged
 * (still `string`); only the key *content* may now contain a single `:`.
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
 * Persistent map of a Feishu conversation key → the {@link ProjectId} the chat
 * has explicitly selected via `/workspace` (M-1, per-chat-config milestone).
 *
 * This is the *selection state* behind the "no thread without a selected
 * workspace" gate: a chat must pick a workspace before its first message may
 * create a thread, and `/resume` only lists/accepts threads belonging to the
 * chat's selected project. Deliberately a separate store from
 * {@link ChatThreadMapStore} — a selection exists *before* any thread does
 * (`ChatBinding.threadId` is required), and it survives `/release` (releasing a
 * session does not un-choose the workspace).
 *
 * Key: the composite `chatId[:larkThreadId]` (`compositeChatKey`), NOT the bare
 * chat id — each topic in a topic group selects its workspace independently
 * (intentional; mirrors the binding-key granularity, see the kickoff §5A/§5B).
 */
export class ChatWorkspaceStore extends Context.Service<
  ChatWorkspaceStore,
  {
    /** Resolve the selected project for `chatKey`, if any. */
    readonly get: (
      chatKey: string,
    ) => Effect.Effect<Option.Option<ProjectId>, FeishuBotPersistenceError>;
    /** Select `projectId` for `chatKey` (overwrites any existing selection). */
    readonly put: (
      chatKey: string,
      projectId: ProjectId,
    ) => Effect.Effect<void, FeishuBotPersistenceError>;
    /** Drop the selection for `chatKey` (no-op if absent). */
    readonly remove: (chatKey: string) => Effect.Effect<void, FeishuBotPersistenceError>;
    /** Snapshot every `[chatKey, projectId]` pair (e.g. for warm-up logging). */
    readonly entries: Effect.Effect<
      ReadonlyArray<readonly [string, ProjectId]>,
      FeishuBotPersistenceError
    >;
  }
>()("@t3tools/feishu-bot/runtime/persistence/ChatWorkspaceStore") {}

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
export const loadBackedMap = <V>(
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
 * M1 ever produced); a current object is narrowed to the live fields (`threadId`,
 * `origin`, plus the M3b-optional `topicAnchorMessageId` / `density`), dropping
 * any extraneous keys an older build may have written (e.g. the now-removed
 * `lastSequence`). The two M3b fields are optional: legacy entries that pre-date
 * them simply carry `undefined`, preserving the M3a "zero re-bind" invariant
 * (`threadId`/`origin` are never lost). Pure; runs once per entry at load time.
 */
const migrateChatBinding = (raw: unknown): ChatBinding => {
  if (typeof raw === "string") {
    // Legacy M1 bare-string: the M3b optional fields are simply absent.
    return { threadId: raw as ThreadId, origin: "self-created" };
  }
  const binding = raw as ChatBinding;
  // Narrow to the live fields, dropping any extraneous on-disk keys. The two
  // M3b optionals are carried through only when present: under
  // `exactOptionalPropertyTypes` an optional field is "absent or string", so an
  // entry that pre-dates them must omit the key rather than set it `undefined`.
  return {
    threadId: binding.threadId,
    origin: binding.origin,
    ...(binding.topicAnchorMessageId !== undefined
      ? { topicAnchorMessageId: binding.topicAnchorMessageId }
      : {}),
    ...(binding.density !== undefined ? { density: binding.density } : {}),
  };
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
 * {@link ChatWorkspaceStore} layer backed by a JSON file at
 * `<stateDir>/chat-workspace.json` (override the full path via `filePath`).
 *
 * The JSON shape is `{ [chatKey]: projectId }` — a flat string map, so no
 * migration/normalisation is needed (identity load).
 */
export const chatWorkspaceStoreLayer = (options: {
  readonly stateDir: string;
  readonly filePath?: string;
}): Layer.Layer<ChatWorkspaceStore, FeishuBotPersistenceError, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(
    ChatWorkspaceStore,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const file = options.filePath ?? path.join(options.stateDir, "chat-workspace.json");
      const backend = jsonFileBackend<ProjectId>(file, { fs, path });
      const { map, persist } = yield* loadBackedMap(backend);
      return ChatWorkspaceStore.of({
        get: (chatKey) => Effect.sync(() => Option.fromUndefinedOr(map.get(chatKey))),
        put: (chatKey, projectId) =>
          Effect.suspend(() => {
            map.set(chatKey, projectId);
            return persist;
          }),
        remove: (chatKey) =>
          Effect.suspend(() => {
            if (!map.delete(chatKey)) {
              return Effect.void;
            }
            return persist;
          }),
        entries: Effect.sync(
          () => Array.from(map.entries()) as ReadonlyArray<readonly [string, ProjectId]>,
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

// ───────────────────────────────────────────────────────────────────────────
// Interaction-kernel stores (M2b-1)
//
// Three more durable stores back the cardAction → respond loop:
//   - CallbackNonceStore: single-use guard for signed callback tokens.
//   - AuditStore: append-only, immutable record of every routed command.
//   - CardHandleStore: chat → latest interaction-card handle, for re-render.
// All three reuse the same `loadBackedMap` + `jsonFileBackend` machinery as the
// M1 stores above; M4 can swap the backend for SQLite without touching callers.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Persisted state of a single callback nonce.
 *
 * - `state`: `"used"` once a token bearing this nonce has been consumed (so a
 *   replayed click is rejected), or `"revoked"` to pre-emptively kill a token.
 * - `exp`: the token's expiry (epoch millis). Records whose `exp` is already in
 *   the past are dropped on load — they can never authenticate a live token
 *   again, so the file does not grow without bound.
 */
export interface NonceRecord {
  readonly state: "used" | "revoked";
  readonly exp: number;
}

/**
 * Persistent single-use guard for signed callback tokens (M2b-1).
 *
 * `CallbackAuth.verify` needs a *synchronous* view of nonce state (it returns a
 * plain result, no Effect), so the store exposes {@link probe}: a one-shot
 * effect yielding a stable {@link NonceProbe} that reads the live in-memory map.
 * `runBoundSession` yields it once at start-up and hands it to `CallbackAuth`; because
 * the underlying `Map` is mutated in place, the probe always reflects the latest
 * state without re-fetching.
 *
 * Durable consumption is driven by the cardAction handler, not by `verify`:
 * `verify` only *reads* nonce state via the probe (no write). After a token
 * verifies, the handler awaits {@link consume} — the single authoritative writer
 * — which marks the nonce in memory *and* persists before the command is routed,
 * closing the crash-replay window (orchestrator adjustment 1).
 */
export class CallbackNonceStore extends Context.Service<
  CallbackNonceStore,
  {
    /** Mark `nonce` used and persist; `false` if it was already used/revoked. */
    readonly consume: (
      nonce: string,
      exp: number,
    ) => Effect.Effect<boolean, FeishuBotPersistenceError>;
    /** Pre-emptively revoke `nonce` (persisted); idempotent. */
    readonly revoke: (nonce: string, exp: number) => Effect.Effect<void, FeishuBotPersistenceError>;
    /** One-shot effect yielding a stable, synchronous view of the live map. */
    readonly probe: Effect.Effect<NonceProbe, FeishuBotPersistenceError>;
  }
>()("@t3tools/feishu-bot/runtime/persistence/CallbackNonceStore") {}

/**
 * Immutable audit entry for one routed interaction command (M2b-1).
 *
 * `command` is the token action that was routed (`approval:accept` /
 * `approval:decline` / `user-input:submit`, or `turn.start` for the turn path);
 * `operatorOpenId` is the Feishu open_id that actually clicked.
 */
export interface AuditEntry {
  readonly operatorOpenId: string;
  readonly chatId: string;
  readonly threadId: string;
  readonly command: string;
  readonly ts: number;
  /**
   * The Feishu topic (`omt_…`) the command was routed within, for audit
   * completeness in group topics. Optional: non-empty in a group topic, absent
   * (→ `undefined`) for p2p / plain-group commands and for legacy on-disk
   * entries written before this field existed. The {@link AuditStore} loads
   * entries with identity normalisation, so old entries lacking it decode
   * unchanged.
   */
  readonly larkThreadId?: string;
}

/**
 * Append-only audit log keyed by `commandId` (M2b-1).
 *
 * Because the server sees the bot as a single principal and cannot attribute
 * individual operators, the bridge is the system of record for *who did what*.
 * {@link append} is write-once per `commandId`: a repeated id (e.g. a retried
 * dispatch) is ignored so the log stays an immutable, idempotent ledger.
 */
export class AuditStore extends Context.Service<
  AuditStore,
  {
    /** Record `entry` under `commandId`; ignored if `commandId` already exists. */
    readonly append: (
      commandId: string,
      entry: AuditEntry,
    ) => Effect.Effect<void, FeishuBotPersistenceError>;
  }
>()("@t3tools/feishu-bot/runtime/persistence/AuditStore") {}

/**
 * Persisted per-thread notification-memory for the shellWatcher (M2b-2).
 *
 * Tracks whether an outstanding approval/user-input was already notified to the
 * Feishu chat across a bot restart, and the last turn-id that ended in a failure
 * so recovery can skip re-sending the same failure card.
 *
 * - `approvalNotified`: `true` once the bot has sent the card for the current
 *   pending approval/user-input; prevents a duplicate card on recovery.
 * - `lastFailedTurnId`: the `turnId` of the last turn whose failure card was
 *   sent, or `null` if no failure has been notified yet. Recovery skips
 *   re-sending a failure card when the current turn matches this value.
 */
export interface PersistedNoticeMemory {
  readonly approvalNotified: boolean;
  readonly lastFailedTurnId: string | null;
}

/**
 * Handle to the latest interaction card a chat is showing (M2b-1).
 *
 * - `messageId`: the Feishu message id of the card (target of `updateCard`).
 * - `pendingRequestId`: the approval/user-input request the card is soliciting,
 *   or `null` when the card has none outstanding.
 * - `lastSequence`: the thread snapshot sequence the card was rendered from, so
 *   recovery can tell whether a newer snapshot needs a re-render. (M2a wrote and
 *   then removed a `lastSequence` on the binding; M2b re-introduces it here.)
 * - `operatorOpenId`: the Feishu `open_id` of the user who triggered the
 *   approval/user-input interaction (M2b-2). Used by M18 restart recovery to
 *   re-sign approval buttons with the real operator rather than a placeholder.
 *   Older persisted handles that pre-date this field are migrated to `""` (empty
 *   string = unknown operator) on load.
 */
export interface CardHandle {
  readonly messageId: string;
  readonly pendingRequestId: string | null;
  readonly lastSequence: number;
  readonly operatorOpenId: string;
}

/**
 * Persistent map of Feishu `ThreadId` → {@link PersistedNoticeMemory} (M2b-2).
 *
 * The shellWatcher reads this on startup to avoid re-sending notification cards
 * for events already delivered before a restart, and writes it each time the
 * notification state transitions.
 */
export class NoticeMemoryStore extends Context.Service<
  NoticeMemoryStore,
  {
    /** Resolve the notice memory for `threadId`, if any. */
    readonly get: (
      threadId: ThreadId,
    ) => Effect.Effect<Option.Option<PersistedNoticeMemory>, FeishuBotPersistenceError>;
    /** Record `state` for `threadId` (overwrites any existing state). */
    readonly put: (
      threadId: ThreadId,
      state: PersistedNoticeMemory,
    ) => Effect.Effect<void, FeishuBotPersistenceError>;
    /** Drop the state for `threadId` (no-op if absent). */
    readonly remove: (threadId: ThreadId) => Effect.Effect<void, FeishuBotPersistenceError>;
  }
>()("@t3tools/feishu-bot/runtime/persistence/NoticeMemoryStore") {}

/**
 * Persistent map of a Feishu conversation key → latest {@link CardHandle} (M2b-1).
 *
 * The turn path records a handle after rendering an interaction card; M2b-2
 * recovery reads it back to re-render an outstanding approval card across a
 * restart. M2b-1 only defines the store and writes handles.
 *
 * M3a: like {@link ChatThreadMapStore}, the key is the bridge's composite
 * `chatId[:larkThreadId]` so a group topic keeps its own card handle. The key is
 * opaque `string` here; p2p / plain-group keys carry no `:` and so are
 * byte-identical to the pre-M3a `chat_id` key (old entries load unchanged). The
 * `get`/`put`/`remove` signatures are unchanged — only the key content may now
 * contain a single `:`.
 */
export class CardHandleStore extends Context.Service<
  CardHandleStore,
  {
    /** Resolve the handle for `chatId`, if any. */
    readonly get: (
      chatId: string,
    ) => Effect.Effect<Option.Option<CardHandle>, FeishuBotPersistenceError>;
    /** Record `handle` for `chatId` (overwrites any existing handle). */
    readonly put: (
      chatId: string,
      handle: CardHandle,
    ) => Effect.Effect<void, FeishuBotPersistenceError>;
    /** Drop the handle for `chatId` (no-op if absent). */
    readonly remove: (chatId: string) => Effect.Effect<void, FeishuBotPersistenceError>;
  }
>()("@t3tools/feishu-bot/runtime/persistence/CardHandleStore") {}

/**
 * {@link CallbackNonceStore} layer backed by a JSON file at
 * `<stateDir>/callback-nonces.json` (override the full path via `filePath`).
 *
 * Records whose `exp` is already past are pruned on load. The {@link NonceProbe}
 * returned by `probe` is built once and closes over the live `Map`, so its
 * reference is stable while always reflecting the current state.
 */
export const callbackNonceStoreLayer = (options: {
  readonly stateDir: string;
  readonly filePath?: string;
}): Layer.Layer<CallbackNonceStore, FeishuBotPersistenceError, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(
    CallbackNonceStore,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const file = options.filePath ?? path.join(options.stateDir, "callback-nonces.json");
      const backend = jsonFileBackend<NonceRecord>(file, { fs, path });
      const { map, persist } = yield* loadBackedMap(backend);
      // Drop already-expired records once at start-up: they can never
      // authenticate a live token again, so they only bloat the file.
      const now = yield* Clock.currentTimeMillis;
      for (const [nonce, record] of map) {
        if (record.exp < now) {
          map.delete(nonce);
        }
      }
      // Stable, synchronous read view of the live map for CallbackAuth.verify.
      // Built once; its reference never changes because the backing `Map` is
      // mutated in place. The probe is read-only (`state`) — durable
      // consumption is the store's `consume` effect, the single authoritative
      // writer, awaited by the handler after verify succeeds and before routing.
      const probe: NonceProbe = {
        state: (nonce: string) => map.get(nonce)?.state,
      };
      return CallbackNonceStore.of({
        consume: (nonce, exp) =>
          Effect.suspend(() => {
            if (map.has(nonce)) {
              return Effect.succeed(false);
            }
            map.set(nonce, { state: "used", exp });
            return persist.pipe(Effect.as(true));
          }),
        revoke: (nonce, exp) =>
          Effect.suspend(() => {
            map.set(nonce, { state: "revoked", exp });
            return persist;
          }),
        probe: Effect.succeed(probe),
      });
    }),
  );

/**
 * {@link AuditStore} layer backed by a JSON file at `<stateDir>/audit-log.json`
 * (override the full path via `filePath`). Keyed by `commandId`; append-only.
 */
export const auditStoreLayer = (options: {
  readonly stateDir: string;
  readonly filePath?: string;
}): Layer.Layer<AuditStore, FeishuBotPersistenceError, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(
    AuditStore,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const file = options.filePath ?? path.join(options.stateDir, "audit-log.json");
      const backend = jsonFileBackend<AuditEntry>(file, { fs, path });
      const { map, persist } = yield* loadBackedMap(backend);
      return AuditStore.of({
        append: (commandId, entry) =>
          Effect.suspend(() => {
            if (map.has(commandId)) {
              return Effect.void;
            }
            map.set(commandId, entry);
            return persist;
          }),
      });
    }),
  );

/**
 * Migrate a raw on-disk card-handle value forward to the current
 * {@link CardHandle} shape. M2b-1 persisted handles without `operatorOpenId`;
 * M2b-2 adds the field. Missing values are defaulted to `""` (unknown operator).
 * Pure; runs once per entry at load time.
 */
const migrateCardHandle = (raw: unknown): CardHandle => {
  const handle = raw as CardHandle;
  return {
    messageId: handle.messageId,
    pendingRequestId: handle.pendingRequestId,
    lastSequence: handle.lastSequence,
    operatorOpenId: handle.operatorOpenId ?? "",
  };
};

/**
 * {@link CardHandleStore} layer backed by a JSON file at
 * `<stateDir>/card-handles.json` (override the full path via `filePath`).
 */
export const cardHandleStoreLayer = (options: {
  readonly stateDir: string;
  readonly filePath?: string;
}): Layer.Layer<CardHandleStore, FeishuBotPersistenceError, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(
    CardHandleStore,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const file = options.filePath ?? path.join(options.stateDir, "card-handles.json");
      const backend = jsonFileBackend<CardHandle>(file, { fs, path });
      const { map, persist } = yield* loadBackedMap(backend, migrateCardHandle);
      return CardHandleStore.of({
        get: (chatId) => Effect.sync(() => Option.fromUndefinedOr(map.get(chatId))),
        put: (chatId, handle) =>
          Effect.suspend(() => {
            map.set(chatId, handle);
            return persist;
          }),
        remove: (chatId) =>
          Effect.suspend(() => {
            if (!map.delete(chatId)) {
              return Effect.void;
            }
            return persist;
          }),
      });
    }),
  );

/**
 * {@link NoticeMemoryStore} layer backed by a JSON file at
 * `<stateDir>/notice-memory.json` (override the full path via `filePath`).
 *
 * Keyed by `ThreadId`; values are {@link PersistedNoticeMemory} objects.
 */
export const noticeMemoryStoreLayer = (options: {
  readonly stateDir: string;
  readonly filePath?: string;
}): Layer.Layer<NoticeMemoryStore, FeishuBotPersistenceError, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(
    NoticeMemoryStore,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const file = options.filePath ?? path.join(options.stateDir, "notice-memory.json");
      const backend = jsonFileBackend<PersistedNoticeMemory>(file, { fs, path });
      const { map, persist } = yield* loadBackedMap(backend);
      return NoticeMemoryStore.of({
        get: (threadId) => Effect.sync(() => Option.fromUndefinedOr(map.get(threadId))),
        put: (threadId, state) =>
          Effect.suspend(() => {
            map.set(threadId, state);
            return persist;
          }),
        remove: (threadId) =>
          Effect.suspend(() => {
            if (!map.delete(threadId)) {
              return Effect.void;
            }
            return persist;
          }),
      });
    }),
  );

/**
 * Convenience: every durable store wired to JSON files under `stateDir`.
 * `bot.ts` provides this once at startup.
 */
export const fileStoresLayer = (options: {
  readonly stateDir: string;
}): Layer.Layer<
  | ChatThreadMapStore
  | ChatWorkspaceStore
  | SentCommandStore
  | CallbackNonceStore
  | AuditStore
  | CardHandleStore
  | NoticeMemoryStore,
  FeishuBotPersistenceError,
  FileSystem.FileSystem | Path.Path
> =>
  Layer.mergeAll(
    chatThreadMapStoreLayer(options),
    chatWorkspaceStoreLayer(options),
    sentCommandStoreLayer(options),
    callbackNonceStoreLayer(options),
    auditStoreLayer(options),
    cardHandleStoreLayer(options),
    noticeMemoryStoreLayer(options),
  );

/** Default per-user state directory (`~/.t3tools/feishu-bot`). */
export const defaultStateDir = (): string => `${NodeOS.homedir()}/.t3tools/feishu-bot`;
