/**
 * M-1: `ChatWorkspaceStore` (durable JSON store) + `WorkspaceState` (in-memory
 * authority) tests.
 *
 * Covers the store's read/write/remove/entries surface, restart persistence
 * (a second layer build over the same file sees the first build's writes), and
 * the state layer's memory-authoritative discipline (a persist failure is
 * absorbed — the selection is still readable).
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as NodeOS from "node:os";

import { WorkspaceState, workspaceStateLayer } from "./workspaceState.ts";
import {
  ChatWorkspaceStore,
  chatWorkspaceStoreLayer,
  FeishuBotPersistenceError,
} from "../runtime/persistence.ts";

const PROJECT_A = ProjectId.make("11111111-1111-4111-8111-111111111111");
const PROJECT_B = ProjectId.make("22222222-2222-4222-8222-222222222222");

/** Fresh per-test state dir under the OS tmpdir (never reused across tests). */
let stateDirCounter = 0;
const freshStateDir = (): string => {
  stateDirCounter += 1;
  return `${NodeOS.tmpdir()}/feishu-bot-workspace-test-${process.pid}-${stateDirCounter}`;
};

describe("ChatWorkspaceStore", () => {
  it.effect("gets, puts, removes and lists selections", () =>
    Effect.gen(function* () {
      const store = yield* ChatWorkspaceStore;

      assert.deepStrictEqual(yield* store.get("oc_chat"), Option.none());

      yield* store.put("oc_chat", PROJECT_A);
      yield* store.put("oc_chat:omt_topic", PROJECT_B);
      assert.deepStrictEqual(yield* store.get("oc_chat"), Option.some(PROJECT_A));
      assert.deepStrictEqual(yield* store.get("oc_chat:omt_topic"), Option.some(PROJECT_B));

      const entries = yield* store.entries;
      assert.deepStrictEqual(
        [...entries].sort((left, right) => left[0].localeCompare(right[0])),
        [
          ["oc_chat", PROJECT_A],
          ["oc_chat:omt_topic", PROJECT_B],
        ],
      );

      yield* store.remove("oc_chat");
      assert.deepStrictEqual(yield* store.get("oc_chat"), Option.none());
    }).pipe(
      Effect.provide(
        chatWorkspaceStoreLayer({ stateDir: freshStateDir() }).pipe(
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
  );

  it.effect("persists selections across a store rebuild (restart)", () =>
    Effect.gen(function* () {
      const stateDir = freshStateDir();
      const layerFor = () =>
        chatWorkspaceStoreLayer({ stateDir }).pipe(Layer.provide(NodeServices.layer));

      // First "process": write a selection.
      yield* ChatWorkspaceStore.pipe(
        Effect.flatMap((store) => store.put("oc_chat", PROJECT_A)),
        Effect.provide(layerFor()),
      );

      // Second "process": a fresh layer over the same file sees the write.
      const restored = yield* ChatWorkspaceStore.pipe(
        Effect.flatMap((store) => store.get("oc_chat")),
        Effect.provide(layerFor()),
      );
      assert.deepStrictEqual(restored, Option.some(PROJECT_A));
    }),
  );
});

describe("WorkspaceState", () => {
  it.effect("serves selections from memory and seeds from the store", () =>
    Effect.gen(function* () {
      const stateDir = freshStateDir();
      const storeLayer = chatWorkspaceStoreLayer({ stateDir }).pipe(
        Layer.provide(NodeServices.layer),
      );

      // Seed the durable store before the state layer builds.
      yield* ChatWorkspaceStore.pipe(
        Effect.flatMap((store) => store.put("oc_seeded", PROJECT_A)),
        Effect.provide(storeLayer),
      );

      yield* Effect.gen(function* () {
        const state = yield* WorkspaceState;
        // Seeded entry is visible.
        assert.strictEqual(yield* state.get("oc_seeded"), PROJECT_A);
        // Unknown chat has no selection.
        assert.strictEqual(yield* state.get("oc_other"), null);
        // Writes are immediately readable.
        yield* state.select("oc_other", PROJECT_B);
        assert.strictEqual(yield* state.get("oc_other"), PROJECT_B);
      }).pipe(Effect.provide(workspaceStateLayer.pipe(Layer.provideMerge(storeLayer))));
    }),
  );

  it.effect("keeps memory authoritative when the store persist fails", () =>
    Effect.gen(function* () {
      // A store whose writes always fail: `select` must still succeed (persist
      // is best-effort) and the selection must be readable from memory.
      const failing = ChatWorkspaceStore.of({
        get: () => Effect.succeed(Option.none()),
        put: () =>
          Effect.fail(
            new FeishuBotPersistenceError({
              path: "/nowhere/chat-workspace.json",
              message: "disk full",
              cause: null,
            }),
          ),
        remove: () => Effect.void,
        entries: Effect.succeed([]),
      });

      yield* Effect.gen(function* () {
        const state = yield* WorkspaceState;
        yield* state.select("oc_chat", PROJECT_A);
        assert.strictEqual(yield* state.get("oc_chat"), PROJECT_A);
      }).pipe(
        Effect.provide(
          workspaceStateLayer.pipe(Layer.provide(Layer.succeed(ChatWorkspaceStore, failing))),
        ),
      );
    }),
  );
});
