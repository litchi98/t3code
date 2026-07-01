import * as NodeServices from "@effect/platform-node/NodeServices";
import { AuthStandardClientScopes } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import * as FeishuBotManager from "./FeishuBotManager.ts";
import * as ServerConfig from "../config.ts";
import * as PairingGrantStore from "../auth/PairingGrantStore.ts";

const CHILD_PID = 4321;
const TEST_PORT = 8123;
const READY_LIVENESS_MS = 4000;

interface RecordedTokenIssue {
  readonly input: Parameters<
    PairingGrantStore.PairingGrantStore["Service"]["issueOneTimeToken"]
  >[0];
  readonly credential: string;
}

function makeProcess(options?: {
  readonly exitCode?: Effect.Effect<ChildProcessSpawner.ExitCode>;
  readonly kill?: ChildProcessSpawner.ChildProcessHandle["kill"];
}): ChildProcessSpawner.ChildProcessHandle {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(CHILD_PID),
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    exitCode: options?.exitCode ?? Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(false),
    kill: options?.kill ?? (() => Effect.void),
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
}

/**
 * A fake `PairingGrantStore` that records every `issueOneTimeToken` call and
 * hands back a distinct credential each time (so tests can prove a fresh token
 * is signed per spawn). All other methods are unexpected in these tests.
 */
function makePairingGrantStoreLayer(record: (issue: RecordedTokenIssue) => void) {
  let count = 0;
  return Layer.succeed(
    PairingGrantStore.PairingGrantStore,
    PairingGrantStore.PairingGrantStore.of({
      issueOneTimeToken: (input) =>
        Effect.gen(function* () {
          count += 1;
          const credential = `pairing-token-${count}`;
          record({ input, credential });
          const now = yield* DateTime.now;
          return {
            id: `pairing-link-${count}`,
            credential,
            expiresAt: now,
          } satisfies PairingGrantStore.IssuedBootstrapCredential;
        }),
      listActive: () => Effect.die("unexpected listActive"),
      streamChanges: Stream.empty,
      revoke: () => Effect.die("unexpected revoke"),
      consume: () => Effect.die("unexpected consume"),
    }),
  );
}

const serverConfigLayer = (port: number) =>
  Layer.effect(
    ServerConfig.ServerConfig,
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      return { ...config, port } satisfies ServerConfig.ServerConfig["Service"];
    }),
  ).pipe(
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-feishu-bot-manager-" })),
  );

function makeManagerLayer(input: {
  readonly spawnerLayer: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>;
  readonly pairingGrantStoreLayer: Layer.Layer<PairingGrantStore.PairingGrantStore>;
  readonly port?: number;
}) {
  const deps = Layer.mergeAll(
    input.spawnerLayer,
    input.pairingGrantStoreLayer,
    serverConfigLayer(input.port ?? TEST_PORT),
  ).pipe(Layer.provideMerge(NodeServices.layer));
  return FeishuBotManager.layer.pipe(Layer.provide(deps));
}

describe("FeishuBotManager", () => {
  it.effect("spawns the bot once and is idempotent while already running", () =>
    Effect.gen(function* () {
      const starts = yield* Queue.unbounded<number>();
      const issues: Array<RecordedTokenIssue> = [];

      // Keep the child alive so a second `start` finds an active run.
      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          Effect.gen(function* () {
            const scope = yield* Scope.Scope;
            const closed = yield* Deferred.make<void>();
            const close = Deferred.succeed(closed, void 0).pipe(Effect.asVoid);
            yield* Scope.addFinalizer(scope, close);
            yield* Queue.offer(starts, CHILD_PID);
            return makeProcess({
              exitCode: Deferred.await(closed).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
              kill: () => close,
            });
          }),
        ),
      );

      const managerLayer = makeManagerLayer({
        spawnerLayer,
        pairingGrantStoreLayer: makePairingGrantStoreLayer((issue) => issues.push(issue)),
      });

      yield* Effect.gen(function* () {
        const manager = yield* FeishuBotManager.FeishuBotManager;
        yield* manager.start;
        assert.equal(yield* Queue.take(starts), CHILD_PID);

        const running = yield* manager.snapshot;
        assert.isTrue(running.running);
        assert.isTrue(running.desiredRunning);
        assert.deepEqual(running.activePid, Option.some(CHILD_PID));

        // Second start while active must not spawn again.
        yield* manager.start;
        assert.equal(yield* Queue.size(starts), 0);
        assert.equal(issues.length, 1);

        yield* manager.stop();
      }).pipe(Effect.provide(managerLayer));
    }),
  );

  it.effect("signs a fresh one-time token and injects only the three allowed env keys", () =>
    Effect.gen(function* () {
      const starts = yield* Queue.unbounded<number>();
      const issues: Array<RecordedTokenIssue> = [];
      let spawnedCommand: ChildProcess.Command | undefined;

      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            spawnedCommand = command;
            // Stay alive so no restart is scheduled during the assertions; the
            // scoped finalizer releases the exit so `stop` can complete.
            const scope = yield* Scope.Scope;
            const closed = yield* Deferred.make<void>();
            const close = Deferred.succeed(closed, void 0).pipe(Effect.asVoid);
            yield* Scope.addFinalizer(scope, close);
            yield* Queue.offer(starts, CHILD_PID);
            return makeProcess({
              exitCode: Deferred.await(closed).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
              kill: () => close,
            });
          }),
        ),
      );

      const managerLayer = makeManagerLayer({
        spawnerLayer,
        pairingGrantStoreLayer: makePairingGrantStoreLayer((issue) => issues.push(issue)),
      });

      yield* Effect.gen(function* () {
        const manager = yield* FeishuBotManager.FeishuBotManager;
        yield* manager.start;
        yield* Queue.take(starts);

        assert.equal(issues.length, 1);
        assert.strictEqual(issues[0]?.input?.scopes, AuthStandardClientScopes);
        assert.equal(issues[0]?.input?.subject, "feishu-bot");

        assert.isDefined(spawnedCommand);
        if (spawnedCommand._tag !== "StandardCommand") {
          throw new Error("Expected the bot to spawn a standard command.");
        }

        assert.equal(spawnedCommand.command, process.execPath);
        assert.equal(spawnedCommand.args.length, 1);
        assert.isTrue(spawnedCommand.args[0]?.endsWith("apps/feishu-bot/src/main.ts"));
        assert.isTrue(spawnedCommand.options.cwd?.endsWith("apps/feishu-bot"));
        assert.equal(spawnedCommand.options.extendEnv, true);
        assert.equal(spawnedCommand.options.stdin, "ignore");
        assert.equal(spawnedCommand.options.stdout, "inherit");
        assert.equal(spawnedCommand.options.stderr, "inherit");
        assert.equal(spawnedCommand.options.killSignal, "SIGTERM");
        assert.isDefined(spawnedCommand.options.forceKillAfter);
        assert.equal(
          Duration.toMillis(Duration.fromInputUnsafe(spawnedCommand.options.forceKillAfter)),
          5_000,
        );

        const env = spawnedCommand.options.env ?? {};
        // Only the four keys we own carry a value; every bot config key we do
        // not own is present-and-undefined so extendEnv drops any inherited copy.
        const definedKeys = Object.entries(env)
          .filter(([, value]) => value !== undefined)
          .map(([key]) => key)
          .sort();
        assert.deepEqual(definedKeys, [
          "T3_HTTP_BASE_URL",
          "T3_PAIRING_TOKEN",
          "T3_STATE_DIR",
          "T3_WORKSPACE_ROOT",
        ]);
        assert.equal(env.T3_PAIRING_TOKEN, "pairing-token-1");
        assert.equal(env.T3_HTTP_BASE_URL, `http://127.0.0.1:${TEST_PORT}`);
        assert.isTrue(env.T3_STATE_DIR?.endsWith("feishu-bot"));
        assert.isTrue(env.T3_STATE_DIR?.includes("userdata"));
        // Bare-server fallback: the bot's workspace root is the server's own cwd.
        assert.equal(env.T3_WORKSPACE_ROOT, process.cwd());
        // The bot's config keys are scrubbed (present-and-undefined), so a stray
        // value in the server operator's shell cannot leak into the child.
        for (const key of FeishuBotManager.FEISHU_BOT_SCRUBBED_ENV_KEYS) {
          assert.isTrue(key in env, `expected ${key} to be scrubbed`);
          assert.isUndefined(env[key]);
        }
        // System env is inherited via extendEnv, not injected by us.
        assert.isFalse("PATH" in env);

        yield* manager.stop();
      }).pipe(Effect.provide(managerLayer));
    }),
  );

  it.effect("signs a distinct token for every spawn across a crash restart", () =>
    Effect.gen(function* () {
      const starts = yield* Queue.unbounded<number>();
      const issues: Array<RecordedTokenIssue> = [];
      const commands: Array<ChildProcess.Command> = [];

      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            commands.push(command);
            yield* Queue.offer(starts, commands.length);
            // Exit immediately so a restart is scheduled.
            return makeProcess({ exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)) });
          }),
        ),
      );

      const managerLayer = makeManagerLayer({
        spawnerLayer,
        pairingGrantStoreLayer: makePairingGrantStoreLayer((issue) => issues.push(issue)),
      });

      yield* Effect.gen(function* () {
        const manager = yield* FeishuBotManager.FeishuBotManager;
        yield* manager.start;
        assert.equal(yield* Queue.take(starts), 1);

        yield* TestClock.adjust(Duration.millis(500));
        assert.equal(yield* Queue.take(starts), 2);

        assert.equal(issues.length, 2);
        assert.notEqual(issues[0]?.credential, issues[1]?.credential);

        const firstEnv = commands[0]?._tag === "StandardCommand" ? commands[0].options.env : {};
        const secondEnv = commands[1]?._tag === "StandardCommand" ? commands[1].options.env : {};
        assert.equal(firstEnv?.T3_PAIRING_TOKEN, issues[0]?.credential);
        assert.equal(secondEnv?.T3_PAIRING_TOKEN, issues[1]?.credential);

        yield* manager.stop();
      }).pipe(Effect.provide(Layer.merge(TestClock.layer(), managerLayer)));
    }),
  );

  it.effect("restarts a crashed bot with capped exponential backoff", () =>
    Effect.gen(function* () {
      const starts = yield* Queue.unbounded<number>();
      let startCount = 0;

      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          Effect.gen(function* () {
            startCount += 1;
            yield* Queue.offer(starts, startCount);
            return makeProcess({ exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)) });
          }),
        ),
      );

      const managerLayer = makeManagerLayer({
        spawnerLayer,
        pairingGrantStoreLayer: makePairingGrantStoreLayer(() => {}),
      });

      const expectSpawnAfter = (delayMs: number, expected: number) =>
        Effect.gen(function* () {
          if (delayMs > 1) {
            yield* TestClock.adjust(Duration.millis(delayMs - 1));
            assert.equal(yield* Queue.size(starts), 0);
          }
          yield* TestClock.adjust(Duration.millis(1));
          assert.equal(yield* Queue.take(starts), expected);
        });

      yield* Effect.gen(function* () {
        const manager = yield* FeishuBotManager.FeishuBotManager;
        yield* manager.start;
        assert.equal(yield* Queue.take(starts), 1);

        // 500ms, 1s, 2s, 4s, 8s, then capped at 10s.
        yield* expectSpawnAfter(500, 2);
        yield* expectSpawnAfter(1000, 3);
        yield* expectSpawnAfter(2000, 4);
        yield* expectSpawnAfter(4000, 5);
        yield* expectSpawnAfter(8000, 6);
        yield* expectSpawnAfter(10000, 7);
        yield* expectSpawnAfter(10000, 8);

        yield* manager.stop();
      }).pipe(Effect.provide(Layer.merge(TestClock.layer(), managerLayer)));
    }),
  );

  it.effect("resets the backoff after the liveness window, then backs off from 500ms again", () =>
    Effect.gen(function* () {
      const starts = yield* Queue.unbounded<number>();
      let startCount = 0;
      const survivorExit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();

      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          Effect.gen(function* () {
            startCount += 1;
            yield* Queue.offer(starts, startCount);
            if (startCount === 3) {
              // The survivor: exits only when we release it, after liveness.
              return makeProcess({ exitCode: Deferred.await(survivorExit) });
            }
            return makeProcess({ exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)) });
          }),
        ),
      );

      const managerLayer = makeManagerLayer({
        spawnerLayer,
        pairingGrantStoreLayer: makePairingGrantStoreLayer(() => {}),
      });

      yield* Effect.gen(function* () {
        const manager = yield* FeishuBotManager.FeishuBotManager;
        yield* manager.start;
        assert.equal(yield* Queue.take(starts), 1);

        // Two immediate crashes escalate the backoff to attempt=2.
        yield* TestClock.adjust(Duration.millis(500));
        assert.equal(yield* Queue.take(starts), 2);
        yield* TestClock.adjust(Duration.millis(1000));
        assert.equal(yield* Queue.take(starts), 3);
        assert.equal((yield* manager.snapshot).restartAttempt, 2);

        // The survivor lives past the liveness window → backoff resets.
        yield* TestClock.adjust(Duration.millis(READY_LIVENESS_MS));
        const readySnapshot = yield* manager.snapshot;
        assert.isTrue(readySnapshot.ready);
        assert.equal(readySnapshot.restartAttempt, 0);

        // Now crash the survivor: the next restart must be a fresh 500ms, not 4s.
        yield* Deferred.succeed(survivorExit, ChildProcessSpawner.ExitCode(1));
        let restartScheduled = false;
        while (!restartScheduled) {
          restartScheduled = (yield* manager.snapshot).restartScheduled;
          if (!restartScheduled) {
            yield* Effect.yieldNow;
          }
        }
        yield* TestClock.adjust(Duration.millis(499));
        assert.equal(yield* Queue.size(starts), 0);
        yield* TestClock.adjust(Duration.millis(1));
        assert.equal(yield* Queue.take(starts), 4);

        yield* manager.stop();
      }).pipe(Effect.provide(Layer.merge(TestClock.layer(), managerLayer)));
    }),
  );

  it.effect("stop marks the bot undesired, SIGTERMs the child, and does not restart", () =>
    Effect.gen(function* () {
      const starts = yield* Queue.unbounded<number>();
      const closes = yield* Queue.unbounded<void>();
      let spawnedCommand: ChildProcess.Command | undefined;

      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            spawnedCommand = command;
            const scope = yield* Scope.Scope;
            const closed = yield* Deferred.make<void>();
            const close = Deferred.succeed(closed, void 0).pipe(
              Effect.andThen(Queue.offer(closes, void 0)),
              Effect.asVoid,
            );
            yield* Scope.addFinalizer(scope, close);
            yield* Queue.offer(starts, CHILD_PID);
            return makeProcess({
              exitCode: Deferred.await(closed).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
              kill: () => close,
            });
          }),
        ),
      );

      const managerLayer = makeManagerLayer({
        spawnerLayer,
        pairingGrantStoreLayer: makePairingGrantStoreLayer(() => {}),
      });

      yield* Effect.gen(function* () {
        const manager = yield* FeishuBotManager.FeishuBotManager;
        yield* manager.start;
        assert.equal(yield* Queue.take(starts), CHILD_PID);

        yield* manager.stop();
        yield* Queue.take(closes);

        const stopped = yield* manager.snapshot;
        assert.isFalse(stopped.desiredRunning);
        assert.isFalse(stopped.running);
        assert.isFalse(stopped.ready);
        assert.isTrue(Option.isNone(stopped.activePid));

        // The teardown signal was SIGTERM (+ forceKillAfter).
        if (spawnedCommand?._tag === "StandardCommand") {
          assert.equal(spawnedCommand.options.killSignal, "SIGTERM");
        }

        // No restart is ever scheduled after stop.
        yield* TestClock.adjust(Duration.seconds(30));
        assert.equal(yield* Queue.size(starts), 0);
      }).pipe(Effect.provide(Layer.merge(TestClock.layer(), managerLayer)));
    }),
  );

  it.effect("closes the child when the layer scope is finalized", () =>
    Effect.gen(function* () {
      const starts = yield* Queue.unbounded<number>();
      const closes = yield* Queue.unbounded<void>();

      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          Effect.gen(function* () {
            const scope = yield* Scope.Scope;
            const closed = yield* Deferred.make<void>();
            const close = Deferred.succeed(closed, void 0).pipe(
              Effect.andThen(Queue.offer(closes, void 0)),
              Effect.asVoid,
            );
            yield* Scope.addFinalizer(scope, close);
            yield* Queue.offer(starts, CHILD_PID);
            return makeProcess({
              exitCode: Deferred.await(closed).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
              kill: () => close,
            });
          }),
        ),
      );

      const managerLayer = makeManagerLayer({
        spawnerLayer,
        pairingGrantStoreLayer: makePairingGrantStoreLayer(() => {}),
      });

      const scope = yield* Scope.make();
      const context = yield* Layer.build(managerLayer).pipe(Scope.provide(scope));
      const manager = Context.get(context, FeishuBotManager.FeishuBotManager);
      yield* manager.start;
      assert.equal(yield* Queue.take(starts), CHILD_PID);

      // Closing the manager's scope runs the finalizer, which stops the child.
      yield* Scope.close(scope, Exit.void);
      yield* Queue.take(closes);
    }),
  );

  it.effect("stop during the restart backoff cancels the pending restart", () =>
    Effect.gen(function* () {
      const starts = yield* Queue.unbounded<number>();
      let startCount = 0;

      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          Effect.gen(function* () {
            startCount += 1;
            yield* Queue.offer(starts, startCount);
            // Exit immediately so a backoff restart is scheduled.
            return makeProcess({ exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)) });
          }),
        ),
      );

      const managerLayer = makeManagerLayer({
        spawnerLayer,
        pairingGrantStoreLayer: makePairingGrantStoreLayer(() => {}),
      });

      yield* Effect.gen(function* () {
        const manager = yield* FeishuBotManager.FeishuBotManager;
        yield* manager.start;
        assert.equal(yield* Queue.take(starts), 1);

        // Wait until the crashed run has armed its backoff sleep.
        let scheduled = false;
        while (!scheduled) {
          scheduled = (yield* manager.snapshot).restartScheduled;
          if (!scheduled) {
            yield* Effect.yieldNow;
          }
        }

        // Stop while the restart fiber is sleeping: it must be cancelled, and no
        // further spawn may happen even after the delay elapses.
        yield* manager.stop();
        const stopped = yield* manager.snapshot;
        assert.isFalse(stopped.desiredRunning);
        assert.isFalse(stopped.restartScheduled);

        yield* TestClock.adjust(Duration.seconds(30));
        assert.equal(yield* Queue.size(starts), 0);
        assert.isFalse((yield* manager.snapshot).desiredRunning);
      }).pipe(Effect.provide(Layer.merge(TestClock.layer(), managerLayer)));
    }),
  );

  it.effect("restarts after an exit-status defect instead of wedging", () =>
    Effect.gen(function* () {
      const starts = yield* Queue.unbounded<number>();
      let startCount = 0;

      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          Effect.gen(function* () {
            startCount += 1;
            yield* Queue.offer(starts, startCount);
            // First run dies with a defect (not a typed failure) — this must still
            // route through finalizeRun and schedule a restart, not wedge `active`.
            if (startCount === 1) {
              return makeProcess({ exitCode: Effect.die("exit-status defect") });
            }
            return makeProcess({ exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)) });
          }),
        ),
      );

      const managerLayer = makeManagerLayer({
        spawnerLayer,
        pairingGrantStoreLayer: makePairingGrantStoreLayer(() => {}),
      });

      yield* Effect.gen(function* () {
        const manager = yield* FeishuBotManager.FeishuBotManager;
        yield* manager.start;
        assert.equal(yield* Queue.take(starts), 1);

        yield* TestClock.adjust(Duration.millis(500));
        assert.equal(yield* Queue.take(starts), 2);

        yield* manager.stop();
      }).pipe(Effect.provide(Layer.merge(TestClock.layer(), managerLayer)));
    }),
  );

  it("buildChildEnv injects the four controlled keys and scrubs the rest", () => {
    const env = FeishuBotManager.buildChildEnv({
      credential: "the-token",
      httpBaseUrl: "http://127.0.0.1:9999",
      stateDir: "/state/feishu-bot",
      workspaceRoot: "/srv/project",
      electronRunAsNode: false,
    });

    assert.equal(env.T3_PAIRING_TOKEN, "the-token");
    assert.equal(env.T3_HTTP_BASE_URL, "http://127.0.0.1:9999");
    assert.equal(env.T3_STATE_DIR, "/state/feishu-bot");
    assert.equal(env.T3_WORKSPACE_ROOT, "/srv/project");

    // T3_WORKSPACE_ROOT is injected, not scrubbed.
    assert.isFalse(
      (FeishuBotManager.FEISHU_BOT_SCRUBBED_ENV_KEYS as ReadonlyArray<string>).includes(
        "T3_WORKSPACE_ROOT",
      ),
    );
    // Every scrubbed key is present-and-undefined, so it overrides (and Node
    // drops) any inherited copy from the parent shell.
    for (const key of FeishuBotManager.FEISHU_BOT_SCRUBBED_ENV_KEYS) {
      assert.isTrue(key in env, `expected ${key} to be scrubbed`);
      assert.isUndefined(env[key]);
    }
    assert.isTrue("FEISHU_APP_SECRET" in env);
    assert.isUndefined(env.FEISHU_APP_SECRET);
    assert.isFalse("PATH" in env);

    // Simulate the extendEnv merge {...parentEnv, ...patch}: an operator shell's
    // secret / workspace root must be overridden by our patch — scrubbed keys
    // become undefined (Node drops them) and T3_WORKSPACE_ROOT takes our
    // injected value, never the operator's; system env (PATH) survives.
    const merged = {
      FEISHU_APP_SECRET: "operator-secret",
      T3_WORKSPACE_ROOT: "/operator/rogue",
      PATH: "/usr/bin",
      ...env,
    };
    assert.isUndefined(merged.FEISHU_APP_SECRET);
    assert.equal(merged.T3_WORKSPACE_ROOT, "/srv/project");
    assert.equal(merged.PATH, "/usr/bin");

    // Headless (node) server: the electron-as-node key is omitted entirely — not
    // set to undefined — so it never scrubs an inherited value.
    assert.isFalse("ELECTRON_RUN_AS_NODE" in env);
  });

  it("buildChildEnv sets ELECTRON_RUN_AS_NODE only for the desktop electron-as-node tree", () => {
    const env = FeishuBotManager.buildChildEnv({
      credential: "the-token",
      httpBaseUrl: "http://127.0.0.1:9999",
      stateDir: "/state/feishu-bot",
      workspaceRoot: "/srv/project",
      electronRunAsNode: true,
    });

    // The one new key, only for desktop: electron then executes dist/main.mjs as Node.
    assert.equal(env.ELECTRON_RUN_AS_NODE, "1");

    // The desktop branch must not disturb the four injected keys or the scrub set.
    assert.equal(env.T3_PAIRING_TOKEN, "the-token");
    assert.equal(env.T3_HTTP_BASE_URL, "http://127.0.0.1:9999");
    assert.equal(env.T3_STATE_DIR, "/state/feishu-bot");
    assert.equal(env.T3_WORKSPACE_ROOT, "/srv/project");
    for (const key of FeishuBotManager.FEISHU_BOT_SCRUBBED_ENV_KEYS) {
      assert.isTrue(key in env, `expected ${key} to be scrubbed`);
      assert.isUndefined(env[key]);
    }
  });

  it("chooseBotEntry: dev→dev entry, prod→bundle, prod-missing→prod-source fallback (not the dev path)", () => {
    // Distinct sentinels for the two source paths: in a real run both resolve to
    // the same src/main.ts, but from DIFFERENT dirs (dev dir vs the packed dist
    // dir), so the constants carry different `../` depths. Keeping them distinct
    // here proves the packed fallback returns the prod-dir-relative source, never
    // the dev one — the layout bug that spawned a missing path and looped.
    const devEntryPath = "/dev-frame/feishu-bot/src/main.ts";
    const prodEntryPath = "/prod-frame/feishu-bot/dist/main.mjs";
    const prodSourceEntryPath = "/prod-frame/feishu-bot/src/main.ts";

    // dev (unpacked): always the dev source — never a prod path, even if a stale dist exists.
    assert.deepStrictEqual(
      FeishuBotManager.chooseBotEntry({
        packed: false,
        devEntryPath,
        prodEntryPath,
        prodSourceEntryPath,
        prodEntryExists: true,
      }),
      { entryPath: devEntryPath, usedSourceFallback: false },
    );

    // prod build with its bundle present: spawn the bundle.
    assert.deepStrictEqual(
      FeishuBotManager.chooseBotEntry({
        packed: true,
        devEntryPath,
        prodEntryPath,
        prodSourceEntryPath,
        prodEntryExists: true,
      }),
      { entryPath: prodEntryPath, usedSourceFallback: false },
    );

    // prod build but bundle missing: degrade to the PROD source, flag the fallback.
    const fallback = FeishuBotManager.chooseBotEntry({
      packed: true,
      devEntryPath,
      prodEntryPath,
      prodSourceEntryPath,
      prodEntryExists: false,
    });
    assert.deepStrictEqual(fallback, { entryPath: prodSourceEntryPath, usedSourceFallback: true });
    // Guards the layout bug: fallback must NOT be the dev-dir source path.
    assert.notEqual(fallback.entryPath, devEntryPath);
  });
});
