import type { FeishuChatDirectoryEntry } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as References from "effect/References";

import * as ServerConfig from "../config.ts";
import * as FeishuChatDirectory from "./FeishuChatDirectory.ts";

interface CapturedLog {
  readonly message: unknown;
  readonly annotations: Readonly<Record<string, unknown>>;
}

/**
 * Full store stack over a throwaway state dir: the store, its ServerConfig, and
 * the node platform services are all exposed so a test can read the resolved
 * `feishuChatDirectoryPath` and seed the file directly.
 */
const makeStoreLayer = () =>
  FeishuChatDirectory.layer.pipe(
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-feishu-chat-dir-test-" }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

const SAMPLE_CHATS: ReadonlyArray<FeishuChatDirectoryEntry> = [
  {
    chatId: "oc_group_a",
    name: "Group A",
    chatMode: "group",
    memberOpenIds: ["ou_alice", "ou_bob"],
    ownerOpenId: "ou_alice",
    memberCount: 2,
  },
  {
    chatId: "oc_topic_b",
    name: "Topic B",
    chatMode: "topic",
    memberOpenIds: [],
  },
];

describe("FeishuChatDirectory", () => {
  it.effect("reports an empty snapshot before anything is saved", () =>
    Effect.gen(function* () {
      const store = yield* FeishuChatDirectory.FeishuChatDirectory;
      const snapshot = yield* store.read;
      assert.deepEqual(snapshot, { chats: [] });
    }).pipe(Effect.provide(makeStoreLayer())),
  );

  it.effect("persists and reads back the roster, stamping reportedAt", () =>
    Effect.gen(function* () {
      const store = yield* FeishuChatDirectory.FeishuChatDirectory;
      yield* store.save(SAMPLE_CHATS);

      const snapshot = yield* store.read;
      assert.deepEqual(snapshot.chats, SAMPLE_CHATS);
      assert.isString(snapshot.reportedAt);
    }).pipe(Effect.provide(makeStoreLayer())),
  );

  it.effect("full-replaces the roster on a second save", () =>
    Effect.gen(function* () {
      const store = yield* FeishuChatDirectory.FeishuChatDirectory;
      yield* store.save(SAMPLE_CHATS);
      yield* store.save([SAMPLE_CHATS[1]!]);

      const snapshot = yield* store.read;
      assert.deepEqual(snapshot.chats, [SAMPLE_CHATS[1]!]);
    }).pipe(Effect.provide(makeStoreLayer())),
  );

  it.effect("survives a restart by re-reading the file", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      // First store instance writes; a second instance over the same path reads.
      yield* Effect.gen(function* () {
        const store = yield* FeishuChatDirectory.FeishuChatDirectory;
        yield* store.save(SAMPLE_CHATS);
      }).pipe(Effect.provide(FeishuChatDirectory.layer));

      const restored = yield* Effect.gen(function* () {
        const store = yield* FeishuChatDirectory.FeishuChatDirectory;
        return yield* store.read;
      }).pipe(Effect.provide(FeishuChatDirectory.layer));

      assert.deepEqual(restored.chats, SAMPLE_CHATS);
      assert.isString(config.feishuChatDirectoryPath);
    }).pipe(Effect.provide(makeStoreLayer())),
  );

  it.effect("treats a malformed roster file as empty and logs a warning", () => {
    const logs: CapturedLog[] = [];
    const logger = Logger.make(({ fiber, message }) => {
      logs.push({ message, annotations: fiber.getRef(References.CurrentLogAnnotations) });
    });

    return Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      yield* fileSystem.writeFileString(config.feishuChatDirectoryPath, "{not json");

      const store = yield* FeishuChatDirectory.FeishuChatDirectory;
      const snapshot = yield* store.read;

      assert.deepEqual(snapshot, { chats: [] });
      assert.equal(
        logs[0]?.message,
        `Failed to decode feishu chat directory at ${config.feishuChatDirectoryPath}.`,
      );
      assert.equal(logs[0]?.annotations.operation, "decode");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(makeStoreLayer(), Logger.layer([logger], { mergeWithExisting: false })),
      ),
    );
  });
});
