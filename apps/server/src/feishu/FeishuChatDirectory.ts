/**
 * Server-side store for the Feishu chat directory (M-0).
 *
 * The feishu-bot enumerates the group chats it belongs to via the Feishu IM API
 * and reports the roster (name / chat_mode / owner / member open_ids) through the
 * `feishu.reportChats` RPC; the web settings UI reads it back via
 * `feishu.listChats`. This store is the persistence for that roster.
 *
 * Deliberately an **independent JSON file** in the server state dir — NOT part of
 * `ServerSettings`/`settings.json`: the roster changes on its own cadence and
 * must never trip `subscribeServerConfig`'s full-settings broadcast or the
 * settings file-watcher churn. It therefore has no PubSub / fs.watch; it is a
 * plain read/write store that survives restarts (boot reads the file).
 *
 * Reliability: writes are atomic (temp + rename via {@link writeFileStringAtomically})
 * and the report is full-replace (the bot always sends its complete current
 * roster). Reads are boot-tolerant — a missing file yields an empty snapshot and
 * a malformed file is logged and treated as empty, so a corrupt roster never
 * breaks server boot or the settings UI.
 *
 * @module feishu/FeishuChatDirectory
 */
import type { FeishuChatDirectorySnapshot } from "@t3tools/contracts";
import { FeishuChatDirectoryEntry } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as ServerConfig from "../config.ts";

/**
 * On-disk format: the wire roster plus a `version` envelope so the format can
 * evolve. `reportedAt` is server-stamped on save (authoritative clock, avoids bot
 * clock skew).
 */
const PersistedFeishuChatDirectory = Schema.Struct({
  version: Schema.Literal(1),
  chats: Schema.Array(FeishuChatDirectoryEntry),
  reportedAt: Schema.String,
});
type PersistedFeishuChatDirectory = typeof PersistedFeishuChatDirectory.Type;

const PersistedFeishuChatDirectoryJson = Schema.fromJsonString(PersistedFeishuChatDirectory);
const decodePersistedFeishuChatDirectory = Schema.decodeUnknownEffect(
  PersistedFeishuChatDirectoryJson,
);
const encodePersistedFeishuChatDirectory = Schema.encodeEffect(PersistedFeishuChatDirectoryJson);

/** The snapshot returned before the bot has ever reported. */
const EMPTY_SNAPSHOT: FeishuChatDirectorySnapshot = { chats: [] };

export class FeishuChatDirectoryError extends Schema.TaggedErrorClass<FeishuChatDirectoryError>()(
  "FeishuChatDirectoryError",
  {
    operation: Schema.Literals(["persist", "read", "decode", "encode"]),
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} feishu chat directory at ${this.path}.`;
  }
}

export class FeishuChatDirectory extends Context.Service<
  FeishuChatDirectory,
  {
    /**
     * Persist the full roster (full-replace). Stamps `reportedAt` from the
     * server clock. Fails with {@link FeishuChatDirectoryError} on a write error
     * — the RPC handler catches and logs it (the report loop is best-effort).
     */
    readonly save: (
      chats: ReadonlyArray<FeishuChatDirectoryEntry>,
    ) => Effect.Effect<void, FeishuChatDirectoryError>;
    /**
     * Read the persisted roster. Boot-tolerant: a missing file yields an empty
     * snapshot; a malformed file is logged and also yields empty. Never fails.
     */
    readonly read: Effect.Effect<FeishuChatDirectorySnapshot>;
  }
>()("t3/feishu/FeishuChatDirectory") {}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const filePath = serverConfig.feishuChatDirectoryPath;

  // Serialize writes: RPC handlers run with unbounded concurrency and two bots on
  // one binding (an e2e norm) can report concurrently; without this, interleaved
  // encode + atomic-write could race. Mirrors serverSettings' write semaphore.
  const writeLock = yield* Semaphore.make(1);

  const save: FeishuChatDirectory["Service"]["save"] = (chats) =>
    writeLock
      .withPermits(1)(
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          const snapshot: PersistedFeishuChatDirectory = {
            version: 1,
            chats,
            reportedAt: DateTime.formatIso(now),
          };
          const encoded = yield* encodePersistedFeishuChatDirectory(snapshot).pipe(
            Effect.mapError(
              (cause) =>
                new FeishuChatDirectoryError({ operation: "encode", path: filePath, cause }),
            ),
          );
          yield* writeFileStringAtomically({ filePath, contents: `${encoded}\n` }).pipe(
            Effect.mapError(
              (cause) =>
                new FeishuChatDirectoryError({ operation: "persist", path: filePath, cause }),
            ),
          );
        }),
      )
      .pipe(
        // `writeFileStringAtomically` pulls FileSystem + Path from context; feed it
        // the captured instances so the method stays self-contained (`R = never`),
        // mirroring ServerSecretStore.
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.withSpan("FeishuChatDirectory.save"),
      );

  const read: Effect.Effect<FeishuChatDirectorySnapshot> = Effect.gen(function* () {
    const raw = yield* fileSystem.readFileString(filePath).pipe(
      Effect.matchEffect({
        onFailure: (cause) =>
          cause.reason._tag === "NotFound"
            ? Effect.succeed(Option.none<string>())
            : Effect.fail(
                new FeishuChatDirectoryError({ operation: "read", path: filePath, cause }),
              ),
        onSuccess: (contents) => Effect.succeed(Option.some(contents)),
      }),
    );
    if (Option.isNone(raw)) {
      return EMPTY_SNAPSHOT;
    }
    const trimmed = raw.value.trim();
    if (trimmed.length === 0) {
      return EMPTY_SNAPSHOT;
    }
    const decoded = yield* decodePersistedFeishuChatDirectory(trimmed).pipe(
      Effect.mapError(
        (cause) => new FeishuChatDirectoryError({ operation: "decode", path: filePath, cause }),
      ),
    );
    return { chats: decoded.chats, reportedAt: decoded.reportedAt };
  }).pipe(
    Effect.catchTag("FeishuChatDirectoryError", (error) =>
      Effect.logWarning(error.message).pipe(
        Effect.annotateLogs({ operation: error.operation, path: error.path, cause: error }),
        Effect.as(EMPTY_SNAPSHOT),
      ),
    ),
    Effect.withSpan("FeishuChatDirectory.read"),
  );

  return FeishuChatDirectory.of({ save, read });
});

export const layer = Layer.effect(FeishuChatDirectory, make);
