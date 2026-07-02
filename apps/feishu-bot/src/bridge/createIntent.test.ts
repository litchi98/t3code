/**
 * M-1 review fixes A/B/C②: dispositions of a buffered first-contact create
 * intent at flush time (`runOfflineCreateFlush`).
 *
 * The invariant under test: a failure while the environment is READY is
 * terminal — the intent is consumed (run SUCCEEDS so the outbound queue clears
 * the ⏳ and never carries it over), the pending-create dedup is released, and
 * the user gets an honest notice; only a genuine "environment dropped again"
 * raises `OfflineRetry` (the queue keeps the intent for the next reconnect
 * edge). A stale workspace selection (fix C②) is always a terminal drop.
 */
import { assert, describe, it } from "@effect/vitest";
import { type ModelSelection, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import {
  createRejectedNoticeText,
  noProviderNoticeText,
  type OfflineCreateFlushDeps,
  runOfflineCreateFlush,
  staleSelectionNoticeText,
  workspaceCollisionOutlet,
} from "./createIntent.ts";

const PROJECT = ProjectId.make("11111111-1111-4111-8111-111111111111");
const OTHER_PROJECT = ProjectId.make("22222222-2222-4222-8222-222222222222");

const MODEL: ModelSelection = Schema.decodeUnknownSync(
  Schema.Struct({ instanceId: Schema.String, model: Schema.String }),
)({
  instanceId: "claude",
  model: "claude-fable-5",
}) as ModelSelection;

interface FlushHarness {
  readonly deps: OfflineCreateFlushDeps;
  readonly notices: Effect.Effect<ReadonlyArray<string>>;
  readonly created: Effect.Effect<number>;
  readonly bound: Effect.Effect<boolean>;
  readonly pendingCleared: Effect.Effect<boolean>;
}

interface FlushOptions {
  /** Selection at flush time (default: still this intent's project). */
  readonly selectedProject?: ProjectId | null;
  /** Environment readiness re-read after a failure (default: ready). */
  readonly envReady?: boolean;
  /** Make the model resolution die (a provider-less/offline resolve). */
  readonly resolveFails?: boolean;
  /** Make the createThread dispatch die (server rejection / env drop). */
  readonly createFails?: boolean;
}

const makeFlushHarness = (options: FlushOptions = {}): Effect.Effect<FlushHarness> =>
  Effect.gen(function* () {
    const notices = yield* Ref.make<ReadonlyArray<string>>([]);
    const created = yield* Ref.make(0);
    const bound = yield* Ref.make(false);
    const pendingCleared = yield* Ref.make(false);

    const deps: OfflineCreateFlushDeps = {
      chatKey: "oc_chat",
      chatType: "p2p",
      replyToMessageId: "om_msg",
      projectId: PROJECT,
      getSelectedProject: Effect.succeed(
        options.selectedProject === undefined ? PROJECT : options.selectedProject,
      ),
      resolveModel:
        options.resolveFails === true
          ? Effect.die(new Error("no ready provider"))
          : Effect.succeed(MODEL),
      dispatchCreate: () =>
        options.createFails === true
          ? Effect.die(new Error("requireThreadAbsent: thread already exists"))
          : Ref.update(created, (n) => n + 1),
      bindChat: Ref.set(bound, true),
      isEnvReady: Effect.succeed(options.envReady ?? true),
      clearPendingCreate: Ref.set(pendingCleared, true),
      sendNotice: (_chatKey, text) => Ref.update(notices, (all) => [...all, text]),
    };

    return {
      deps,
      notices: Ref.get(notices),
      created: Ref.get(created),
      bound: Ref.get(bound),
      pendingCleared: Ref.get(pendingCleared),
    } satisfies FlushHarness;
  });

describe("runOfflineCreateFlush", () => {
  it.effect("happy path: resolves, creates, binds — no notice, dedup kept", () =>
    Effect.gen(function* () {
      const harness = yield* makeFlushHarness();
      const exit = yield* Effect.exit(runOfflineCreateFlush(harness.deps));
      assert.isTrue(Exit.isSuccess(exit));
      assert.strictEqual(yield* harness.created, 1);
      assert.isTrue(yield* harness.bound);
      assert.deepStrictEqual(yield* harness.notices, []);
      assert.isFalse(yield* harness.pendingCleared);
    }),
  );

  it.effect("C②: a stale selection drops the intent with a notice (no create)", () =>
    Effect.gen(function* () {
      const harness = yield* makeFlushHarness({ selectedProject: OTHER_PROJECT });
      const exit = yield* Effect.exit(runOfflineCreateFlush(harness.deps));
      assert.isTrue(Exit.isSuccess(exit)); // consumed, never carried over
      assert.strictEqual(yield* harness.created, 0);
      assert.isFalse(yield* harness.bound);
      assert.isTrue(yield* harness.pendingCleared);
      assert.deepStrictEqual(yield* harness.notices, [staleSelectionNoticeText]);
    }),
  );

  it.effect("A: resolve fails while READY → terminal drop + honest notice", () =>
    Effect.gen(function* () {
      const harness = yield* makeFlushHarness({ resolveFails: true, envReady: true });
      const exit = yield* Effect.exit(runOfflineCreateFlush(harness.deps));
      assert.isTrue(Exit.isSuccess(exit)); // consumed — never an eternal carry-over
      assert.strictEqual(yield* harness.created, 0);
      assert.isTrue(yield* harness.pendingCleared);
      assert.deepStrictEqual(yield* harness.notices, [noProviderNoticeText]);
    }),
  );

  it.effect("A: resolve fails while NOT ready → OfflineRetry (kept for next flush)", () =>
    Effect.gen(function* () {
      const harness = yield* makeFlushHarness({ resolveFails: true, envReady: false });
      const exit = yield* Effect.exit(runOfflineCreateFlush(harness.deps));
      assert.isTrue(Exit.isFailure(exit)); // queue keeps intent + ⏳
      assert.isFalse(yield* harness.pendingCleared);
      assert.deepStrictEqual(yield* harness.notices, []);
    }),
  );

  it.effect("B: create rejected while READY → terminal drop + collision notice", () =>
    Effect.gen(function* () {
      const harness = yield* makeFlushHarness({ createFails: true, envReady: true });
      const exit = yield* Effect.exit(runOfflineCreateFlush(harness.deps));
      assert.isTrue(Exit.isSuccess(exit));
      assert.isFalse(yield* harness.bound);
      assert.isTrue(yield* harness.pendingCleared);
      assert.deepStrictEqual(yield* harness.notices, [createRejectedNoticeText("p2p")]);
    }),
  );

  it.effect("B: create fails while NOT ready → OfflineRetry (kept for next flush)", () =>
    Effect.gen(function* () {
      const harness = yield* makeFlushHarness({ createFails: true, envReady: false });
      const exit = yield* Effect.exit(runOfflineCreateFlush(harness.deps));
      assert.isTrue(Exit.isFailure(exit));
      assert.isFalse(yield* harness.bound);
      assert.isFalse(yield* harness.pendingCleared);
      assert.deepStrictEqual(yield* harness.notices, []);
    }),
  );
});

describe("collision outlet text (F)", () => {
  it("points p2p at the web end and groups at a fresh topic", () => {
    assert.include(workspaceCollisionOutlet("p2p"), "web 端");
    assert.notInclude(workspaceCollisionOutlet("p2p"), "新话题");
    assert.include(workspaceCollisionOutlet("group"), "新话题");
  });
});
