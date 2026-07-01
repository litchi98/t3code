/**
 * FeishuBotManager - server-side lifecycle supervisor for the feishu-bot child
 * process.
 *
 * The feishu-bot (`apps/feishu-bot`) is a resident headless client that bridges
 * Feishu chats into shared t3code sessions. Historically it is started by hand
 * (`node apps/feishu-bot/src/main.ts` with a hand-signed pairing token). This
 * service lets the server own that lifecycle instead: spawn the bot as an
 * isolated child process, keep it alive across crashes with capped exponential
 * backoff, and always tear it down (SIGTERM) when the server exits.
 *
 * It is deliberately a "dumb supervisor": it does not touch bot-internal state
 * (credential re-binding, Feishu reconnects, routing) — the bot handles those
 * itself. This PR provides only the service + `start`/`stop`/`snapshot`; the
 * binding-driven reconcile fiber and the `feishuBotManaged` toggle are a later
 * PR.
 *
 * Blueprint: `apps/desktop/src/backend/DesktopBackendManager.ts` (desktop's
 * server-child supervisor). Two deliberate departures:
 *  - Readiness is a *liveness timer* (survive N seconds ⇒ ready) rather than an
 *    HTTP probe — the bot exposes no HTTP endpoint.
 *  - Every spawn injects a freshly-signed one-time pairing token; the bot never
 *    persists a long-lived bearer, so a new credential is minted each launch.
 *
 * Red lines (see the milestone kickoff):
 *  - The child must be a *separate* process, never in-process: the bot installs
 *    global `unhandledRejection`/`uncaughtException` guards
 *    (`apps/feishu-bot/src/processGuard.ts`) that would otherwise swallow the
 *    server's own async failures.
 *  - No secret is ever *injected* by the manager, and the bot's config env is
 *    isolated from the server's. The child keeps `extendEnv: true` because the
 *    bot is an agent runtime that must inherit the system environment
 *    (PATH/HOME/…) to run user commands — but we explicitly *scrub* every env
 *    key the bot reads as config (see {@link FEISHU_BOT_SCRUBBED_ENV_KEYS}),
 *    so a stray `FEISHU_APP_SECRET`/`FEISHU_APP_ID`/… in the server operator's
 *    shell cannot leak in and silently pin the bot to a fixed app — which would
 *    hollow out the whole server-managed binding. Only the four keys we
 *    authoritatively own are set to a value (an injected value also overrides
 *    any inherited copy under `extendEnv`); the signed token is never logged.
 *
 * @module FeishuBotManager
 */
import { AuthStandardClientScopes } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ServerConfig from "../config.ts";
import * as PairingGrantStore from "../auth/PairingGrantStore.ts";

const INITIAL_RESTART_DELAY = Duration.millis(500);
const MAX_RESTART_DELAY = Duration.seconds(10);
/** Grace period after SIGTERM before the child is force-killed on teardown. */
const BOT_TERMINATE_GRACE = Duration.seconds(5);
/**
 * How long the child must survive after spawn before we treat it as "ready"
 * and reset the restart backoff. A bot that dies inside this window is counted
 * as a failed start (backoff keeps escalating); a bot that lives past it earns
 * a clean backoff reset so an occasional late crash does not accumulate delay.
 */
const READY_LIVENESS_DELAY = Duration.seconds(4);

/** Subject stamped on the one-time pairing token; matches the bot's own label. */
const FEISHU_BOT_TOKEN_SUBJECT = "feishu-bot";
/** State subdirectory handed to the bot under the server's state dir. */
const FEISHU_BOT_STATE_SUBDIR = "feishu-bot";
/**
 * Path from this module to the bot entry, resolved at runtime. dev runs the
 * `.ts` source directly via Node's native type-stripping (`node <abs .ts>`,
 * no loader flag). Production bundling is a separate milestone.
 */
const BOT_ENTRY_RELATIVE_PATH = "../../../feishu-bot/src/main.ts";

/**
 * Every environment variable the bot reads as *configuration* that we are NOT
 * authoritatively injecting. These are scrubbed (set to `undefined`, which
 * Node's spawn drops from the merged env) so the server operator's shell cannot
 * leak config into the child via `extendEnv: true`.
 *
 * Derivation: the exhaustive list of keys the bot resolves is `FLAG_BY_ENV` in
 * `apps/feishu-bot/src/config.ts` (11 keys). Subtract the four we set with a
 * value (`T3_PAIRING_TOKEN`, `T3_HTTP_BASE_URL`, `T3_STATE_DIR`,
 * `T3_WORKSPACE_ROOT`) and the remaining seven are scrubbed here. Keep this in
 * lockstep with the bot config if a new `T3_*`/`FEISHU_*` knob is added there.
 *
 * `FEISHU_APP_ID`/`FEISHU_APP_SECRET` are the critical pair: if inherited they
 * hit the bot's dev-override branch (`config.ts` `resolveFeishuAppConfig`) and
 * silently pin it to a fixed app, skipping the server credential RPC.
 * (`T3_WORKSPACE_ROOT` is NOT scrubbed — it is injected as a value; see
 * `buildChildEnv`.)
 */
export const FEISHU_BOT_SCRUBBED_ENV_KEYS = [
  "T3_WS_BASE_URL",
  "T3_MODEL",
  "FEISHU_APP_ID",
  "FEISHU_APP_SECRET",
  "FEISHU_TENANT",
  "FEISHU_OWNER_OPEN_IDS",
  "FEISHU_GROUP_CHAT_DENSITY",
] as const;

/**
 * Build the child env for one spawn. `extendEnv: true` at the spawn site brings
 * the server's system env (PATH/HOME/…) — which the agent runtime needs — while
 * the scrubbed keys (value `undefined`) remove any inherited copy of the bot's
 * config knobs. Only the four keys below carry a value.
 *
 * `T3_WORKSPACE_ROOT = serverConfig.cwd` is injected as a bare-server fallback:
 * a headless `serve` — the target deployment for the server-managed bot — is
 * forced to `autoBootstrapProjectFromCwd=false` by the `isHeadlessStartup` gate
 * in `apps/server/src/cli/config.ts` (~:295/:321), so the server may have NO
 * project. Bot project resolution (`apps/feishu-bot/src/bot.ts:170-195`) is
 * snapshot-first: when the server already has a project the bot inherits it and
 * ignores this value (no side effect); when the server is bare the bot uses
 * `T3_WORKSPACE_ROOT` to create one (at the server's own cwd — semantically
 * correct) instead of `Effect.die`-ing in a reconnect loop. Injecting it (not
 * scrubbing) also means `extendEnv` cannot leak the operator shell's value: the
 * bot's workspace is wholly manager-controlled = `serverConfig.cwd`.
 *
 * Pure (no services) so the scrub/injection is unit-testable without a spawner.
 */
export const buildChildEnv = (input: {
  readonly credential: string;
  readonly httpBaseUrl: string;
  readonly stateDir: string;
  readonly workspaceRoot: string;
}): Record<string, string | undefined> => ({
  ...Object.fromEntries(FEISHU_BOT_SCRUBBED_ENV_KEYS.map((key) => [key, undefined])),
  T3_PAIRING_TOKEN: input.credential,
  T3_HTTP_BASE_URL: input.httpBaseUrl,
  T3_STATE_DIR: input.stateDir,
  T3_WORKSPACE_ROOT: input.workspaceRoot,
});

interface BotProcessContext {
  readonly executablePath: string;
  readonly entryPath: string;
  readonly cwd: string;
}

const botProcessContextSchema = {
  executablePath: Schema.String,
  entryPath: Schema.String,
  cwd: Schema.String,
};

class FeishuBotProcessSpawnError extends Schema.TaggedErrorClass<FeishuBotProcessSpawnError>()(
  "FeishuBotProcessSpawnError",
  {
    ...botProcessContextSchema,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to spawn feishu-bot entry ${this.entryPath} with ${this.executablePath}.`;
  }
}

class FeishuBotProcessExitStatusError extends Schema.TaggedErrorClass<FeishuBotProcessExitStatusError>()(
  "FeishuBotProcessExitStatusError",
  {
    ...botProcessContextSchema,
    pid: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to read the exit status of feishu-bot process ${this.pid}.`;
  }
}

class FeishuBotRestartError extends Schema.TaggedErrorClass<FeishuBotRestartError>()(
  "FeishuBotRestartError",
  {
    reason: Schema.String,
    delayMs: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `feishu-bot restart failed after a scheduled ${this.delayMs}ms delay.`;
  }
}

type BotProcessError = FeishuBotProcessSpawnError | FeishuBotProcessExitStatusError;

const LOG_COMPONENT = "feishu-bot-manager";

const logInfo = (message: string, data?: Record<string, unknown>) =>
  Effect.logInfo(message, data).pipe(Effect.annotateLogs({ component: LOG_COMPONENT }));

const logError = (message: string, data?: Record<string, unknown>) =>
  Effect.logError(message, data).pipe(Effect.annotateLogs({ component: LOG_COMPONENT }));

interface BotProcessExit {
  readonly code: Option.Option<number>;
  readonly reason: string;
}

/** Observable snapshot of the supervisor, for tests and diagnostics. */
export interface FeishuBotSnapshot {
  /** Whether the supervisor currently wants the bot running. */
  readonly desiredRunning: boolean;
  /** Whether the current child has survived the liveness window. */
  readonly ready: boolean;
  /** Whether a child process is currently spawned. */
  readonly running: boolean;
  /** PID of the current child, if one is spawned and has reported it. */
  readonly activePid: Option.Option<number>;
  /** Consecutive failed-start count driving the backoff. */
  readonly restartAttempt: number;
  /** Whether a delayed restart is currently pending. */
  readonly restartScheduled: boolean;
}

export class FeishuBotManager extends Context.Service<
  FeishuBotManager,
  {
    /** Mark the bot as desired and ensure a child process is running. */
    readonly start: Effect.Effect<void>;
    /** Mark the bot as not desired and SIGTERM any running child. */
    readonly stop: (options?: { readonly timeout?: Duration.Duration }) => Effect.Effect<void>;
    /** Current supervisor state, for observation and testing. */
    readonly snapshot: Effect.Effect<FeishuBotSnapshot>;
  }
>()("t3/feishu/FeishuBotManager") {}

interface ActiveBotRun {
  readonly id: number;
  readonly scope: Scope.Closeable;
  readonly fiber: Option.Option<Fiber.Fiber<void, never>>;
  readonly pid: Option.Option<number>;
}

interface BotManagerState {
  readonly desiredRunning: boolean;
  readonly ready: boolean;
  readonly active: Option.Option<ActiveBotRun>;
  readonly restartAttempt: number;
  readonly restartFiber: Option.Option<Fiber.Fiber<void, never>>;
  readonly nextRunId: number;
}

const initialState: BotManagerState = {
  desiredRunning: false,
  ready: false,
  active: Option.none(),
  restartAttempt: 0,
  restartFiber: Option.none(),
  nextRunId: 1,
};

const activePid = (active: Option.Option<ActiveBotRun>): Option.Option<number> =>
  Option.flatMap(active, (run) => run.pid);

const withActiveRun =
  (runId: number, f: (run: ActiveBotRun) => ActiveBotRun) =>
  (state: BotManagerState): BotManagerState => ({
    ...state,
    active: Option.map(state.active, (run) => (run.id === runId ? f(run) : run)),
  });

const calculateRestartDelay = (attempt: number): Duration.Duration =>
  Duration.min(Duration.times(INITIAL_RESTART_DELAY, 2 ** attempt), MAX_RESTART_DELAY);

const closeRun = (
  run: ActiveBotRun,
  options?: { readonly timeout?: Duration.Duration },
): Effect.Effect<void> => {
  const waitForFiber = Option.match(run.fiber, {
    onNone: () => Effect.void,
    onSome: (fiber) => Fiber.await(fiber).pipe(Effect.asVoid),
  });
  const close = Scope.close(run.scope, Exit.void).pipe(Effect.andThen(waitForFiber));

  return (
    options?.timeout ? close.pipe(Effect.timeoutOption(options.timeout), Effect.asVoid) : close
  ).pipe(Effect.ignore);
};

interface RunBotProcessOptions extends BotProcessContext {
  readonly env: Record<string, string | undefined>;
  readonly readinessDelay: Duration.Duration;
  readonly onStarted?: (pid: ChildProcessSpawner.ProcessId) => Effect.Effect<void>;
  readonly onReady?: () => Effect.Effect<void>;
}

/**
 * Spawn the bot and block until it exits. Readiness is signalled from a scoped
 * fiber that fires `onReady` only after the child has survived `readinessDelay`.
 * If the child exits first, the run scope closes and interrupts that fiber, so
 * `onReady` never runs against an already-dead process.
 */
const runBotProcess = Effect.fn("feishu.botManager.runBotProcess")(function* (
  options: RunBotProcessOptions,
): Effect.fn.Return<
  BotProcessExit,
  BotProcessError,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const command = ChildProcess.make(options.executablePath, [options.entryPath], {
    cwd: options.cwd,
    env: options.env,
    // Inherit the server's system env (PATH/HOME/…) — the agent runtime needs
    // it — but `options.env` scrubs the bot's config keys (see buildChildEnv).
    extendEnv: true,
    stdin: "ignore",
    // Inherit the bot's stdout/stderr so its logs surface alongside the
    // server's in dev; the bot owns its own structured logging.
    stdout: "inherit",
    stderr: "inherit",
    killSignal: "SIGTERM",
    forceKillAfter: BOT_TERMINATE_GRACE,
  });

  const handle = yield* spawner.spawn(command).pipe(
    Effect.mapError(
      (cause) =>
        new FeishuBotProcessSpawnError({
          executablePath: options.executablePath,
          entryPath: options.entryPath,
          cwd: options.cwd,
          cause,
        }),
    ),
  );

  yield* options.onStarted?.(handle.pid) ?? Effect.void;

  yield* Effect.sleep(options.readinessDelay).pipe(
    Effect.andThen(options.onReady?.() ?? Effect.void),
    Effect.forkScoped,
  );

  const exitCode = yield* handle.exitCode.pipe(
    Effect.mapError(
      (cause) =>
        new FeishuBotProcessExitStatusError({
          executablePath: options.executablePath,
          entryPath: options.entryPath,
          cwd: options.cwd,
          pid: Number(handle.pid),
          cause,
        }),
    ),
  );
  return {
    code: Option.some(exitCode),
    reason: `code=${exitCode}`,
  } satisfies BotProcessExit;
});

export const make = Effect.gen(function* () {
  const parentScope = yield* Scope.Scope;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const pairingGrants = yield* PairingGrantStore.PairingGrantStore;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const state = yield* Ref.make(initialState);
  // Serialises start / restart-spawn / stop so a "should we spawn?" decision and
  // the spawn itself are one atomic critical section (see `scheduleRestart`).
  const mutex = yield* Semaphore.make(1);

  // The bot entry + its package dir. The entry is absolute, so cwd does not
  // affect module resolution; we point cwd at the bot package for cleanliness.
  const executablePath = process.execPath;
  const entryPath = path.resolve(import.meta.dirname, BOT_ENTRY_RELATIVE_PATH);
  const cwd = path.dirname(path.dirname(entryPath));

  // Static child-env pieces (the per-spawn one-time token is added at spawn time).
  // Loopback + serverConfig.port is the local server the bot bootstraps against
  // (this manager only runs alongside a loopback-served server; a non-loopback
  // host would need the bound host threaded through, out of scope for this PR).
  const httpBaseUrl = `http://127.0.0.1:${serverConfig.port}`;
  const stateDir = path.join(serverConfig.stateDir, FEISHU_BOT_STATE_SUBDIR);

  const updateActiveRun = (runId: number, f: (run: ActiveBotRun) => ActiveBotRun) =>
    Ref.update(state, withActiveRun(runId, f));

  const snapshot = Ref.get(state).pipe(
    Effect.map(
      (current): FeishuBotSnapshot => ({
        desiredRunning: current.desiredRunning,
        ready: current.ready,
        running: Option.isSome(current.active),
        activePid: activePid(current.active),
        restartAttempt: current.restartAttempt,
        restartScheduled: Option.isSome(current.restartFiber),
      }),
    ),
  );

  const cancelRestart = Effect.gen(function* () {
    const restartFiber = yield* Ref.modify(state, (current) => [
      current.restartFiber,
      {
        ...current,
        restartFiber: Option.none(),
      },
    ]);

    yield* Option.match(restartFiber, {
      onNone: () => Effect.void,
      onSome: (fiber) => Fiber.interrupt(fiber).pipe(Effect.asVoid),
    });
  });

  /**
   * Spawn one bot run. MUST be called while holding `mutex`, and only spawns
   * when the bot is still desired and none is already active — so the caller's
   * desired-state decision and the spawn are one atomic critical section. Does
   * NOT set `desiredRunning` (the caller owns that), which is what lets the
   * restart fiber re-check desired-state under the lock without a TOCTOU window.
   */
  const spawnRunLocked: Effect.Effect<void> = Effect.gen(function* () {
    const current = yield* Ref.get(state);
    if (Option.isSome(current.active) || !current.desiredRunning) {
      return;
    }

    // Freshly sign a one-time pairing token for this launch. Never logged; it is
    // written only into the child env below. Equivalent to
    // `EnvironmentAuth.createPairingLink`, which internally calls this very
    // `PairingGrantStore.issueOneTimeToken` and only adds error wrapping / return
    // reshaping — no extra security constraint — so the direct call is safe (see
    // kickoff §4 decision B). A signing failure (e.g. a transient store error) is
    // treated as a failed start and retried through the normal backoff.
    const issued = yield* pairingGrants
      .issueOneTimeToken({
        scopes: AuthStandardClientScopes,
        subject: FEISHU_BOT_TOKEN_SUBJECT,
      })
      .pipe(
        Effect.tapError((cause) => logError("failed to issue feishu-bot pairing token", { cause })),
        Effect.option,
      );
    if (Option.isNone(issued)) {
      yield* scheduleRestart("failed to issue feishu-bot pairing token");
      return;
    }

    const runScope = yield* Scope.make("sequential");
    const runId = yield* Ref.modify(state, (latest) => [
      latest.nextRunId,
      {
        ...latest,
        // A freshly spawned run is not ready until it survives the liveness
        // window (`onReady` flips this true). Resetting here — rather than in
        // `start` — means a re-bind's no-op start leaves a live run's `ready`
        // intact.
        ready: false,
        active: Option.some({
          id: latest.nextRunId,
          scope: runScope,
          fiber: Option.none(),
          pid: Option.none(),
        } satisfies ActiveBotRun),
        nextRunId: latest.nextRunId + 1,
      },
    ]);

    const finalizeRun = Effect.fn("feishu.botManager.finalizeRun")(function* (
      reason: string,
      failure: Option.Option<Cause.Cause<BotProcessError>>,
    ) {
      yield* mutex.withPermits(1)(
        Effect.gen(function* () {
          const { isCurrentRun, desiredRunning } = yield* Ref.modify(
            state,
            (
              latest,
            ): readonly [
              { readonly isCurrentRun: boolean; readonly desiredRunning: boolean },
              BotManagerState,
            ] => {
              const currentRun = Option.getOrUndefined(latest.active);
              if (currentRun?.id !== runId) {
                return [
                  { isCurrentRun: false, desiredRunning: latest.desiredRunning },
                  latest,
                ] as const;
              }
              return [
                { isCurrentRun: true, desiredRunning: latest.desiredRunning },
                { ...latest, active: Option.none<ActiveBotRun>(), ready: false },
              ] as const;
            },
          );

          // Superseded, or intentionally stopped (stop cleared `active` and set
          // desiredRunning=false first): a clean teardown, stay quiet.
          if (!isCurrentRun || !desiredRunning) {
            return;
          }
          // Unexpected exit while still desired. Log the underlying failure/defect
          // if any (a plain non-zero exit is not an internal error — scheduleRestart
          // logs that), then back off and restart.
          if (Option.isSome(failure)) {
            yield* logError("feishu-bot process terminated abnormally", {
              reason,
              cause: failure.value,
            });
          }
          yield* scheduleRestart(reason);
        }),
      );
    });

    const program = runBotProcess({
      executablePath,
      entryPath,
      cwd,
      env: buildChildEnv({
        credential: issued.value.credential,
        httpBaseUrl,
        stateDir,
        workspaceRoot: serverConfig.cwd,
      }),
      readinessDelay: READY_LIVENESS_DELAY,
      onStarted: Effect.fn("feishu.botManager.onStarted")(function* (pid) {
        yield* updateActiveRun(runId, (run) => ({
          ...run,
          pid: Option.some(Number(pid)),
        }));
        yield* logInfo("feishu-bot process started", { pid: Number(pid) });
      }),
      onReady: Effect.fn("feishu.botManager.onReady")(function* () {
        const wasCurrentRun = yield* Ref.modify(state, (latest) => {
          const activeRun = Option.getOrUndefined(latest.active);
          if (activeRun?.id !== runId) {
            return [false, latest] as const;
          }
          return [true, { ...latest, restartAttempt: 0, ready: true }] as const;
        });
        if (wasCurrentRun) {
          yield* logInfo("feishu-bot process ready");
        }
      }),
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Scope.provide(runScope),
      // matchCauseEffect (not matchEffect) so a defect from spawn / exitCode is
      // also funnelled through finalizeRun — otherwise a defect would leave the
      // run stuck `active` and never restart. Pure interruption (parent scope
      // teardown) just closes the scope via `ensuring`.
      Effect.matchCauseEffect({
        onFailure: (cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : finalizeRun("feishu-bot process failed", Option.some(cause)),
        onSuccess: (exit) => finalizeRun(exit.reason, Option.none()),
      }),
      Effect.ensuring(Scope.close(runScope, Exit.void).pipe(Effect.ignore)),
    );

    const fiber = yield* Effect.forkIn(program, parentScope);
    yield* updateActiveRun(runId, (run) => ({
      ...run,
      fiber: Option.some(fiber),
    }));
  });

  const start: Effect.Effect<void> = Effect.suspend(() =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        yield* cancelRestart;
        // Do NOT reset `ready` here: a redundant `start` while a run is already
        // active (e.g. a re-bind) is a no-op in `spawnRunLocked`, and must not
        // clobber the live process's `ready` flag. `ready` is reset only where a
        // fresh (not-yet-lived) run is actually created, below.
        yield* Ref.update(state, (latest) => ({
          ...latest,
          desiredRunning: true,
        }));
        yield* spawnRunLocked;
      }),
    ),
  ).pipe(Effect.withSpan("feishu.botManager.start"));

  const scheduleRestart = Effect.fn("feishu.botManager.scheduleRestart")(function* (
    reason: string,
  ) {
    const scheduled = yield* Ref.modify(state, (latest) => {
      if (!latest.desiredRunning || Option.isSome(latest.restartFiber)) {
        return [Option.none<Duration.Duration>(), latest] as const;
      }

      const delay = calculateRestartDelay(latest.restartAttempt);
      return [
        Option.some(delay),
        {
          ...latest,
          restartAttempt: latest.restartAttempt + 1,
        },
      ] as const;
    });

    yield* Option.match(scheduled, {
      onNone: () => Effect.void,
      onSome: Effect.fn("feishu.botManager.scheduleRestartFiber")(function* (delay) {
        yield* logError("feishu-bot exited unexpectedly; restart scheduled", {
          reason,
          delayMs: Duration.toMillis(delay),
        });
        const restartFiber = yield* Effect.forkIn(
          Effect.sleep(delay).pipe(
            Effect.andThen(
              // Re-decide and (maybe) spawn inside the SAME mutex `stop` uses, so
              // there is no window where stop flips desiredRunning=false after we
              // decide to restart but before we spawn. Whoever takes the lock
              // first wins: if stop wins it sets desiredRunning=false and we skip
              // the spawn (spawnRunLocked re-checks); if we win we spawn and stop,
              // which runs next, finds the active run and closes it. Clearing our
              // own `restartFiber` here is safe because stop runs under this lock.
              mutex.withPermits(1)(
                Effect.gen(function* () {
                  yield* Ref.update(state, (latest) => ({
                    ...latest,
                    restartFiber: Option.none(),
                  }));
                  yield* spawnRunLocked;
                }),
              ),
            ),
            Effect.catchCause((cause) => {
              if (Cause.hasInterruptsOnly(cause)) {
                return Effect.void;
              }
              const error = new FeishuBotRestartError({
                reason,
                delayMs: Duration.toMillis(delay),
                cause,
              });
              return logError(error.message, { error });
            }),
          ),
          parentScope,
        );
        yield* Ref.update(state, (latest) =>
          Option.isNone(latest.restartFiber)
            ? {
                ...latest,
                restartFiber: Option.some(restartFiber),
              }
            : latest,
        );
      }),
    });
  });

  const stop = Effect.fn("feishu.botManager.stop")(function* (options?: {
    readonly timeout?: Duration.Duration;
  }) {
    const { active, restartFiber } = yield* mutex.withPermits(1)(
      Ref.modify(state, (latest) => [
        {
          active: latest.active,
          restartFiber: latest.restartFiber,
        },
        {
          ...latest,
          desiredRunning: false,
          ready: false,
          active: Option.none<ActiveBotRun>(),
          restartFiber: Option.none<Fiber.Fiber<void, never>>(),
        },
      ]),
    );

    yield* Option.match(restartFiber, {
      onNone: () => Effect.void,
      onSome: (fiber) => Fiber.interrupt(fiber).pipe(Effect.asVoid),
    });
    yield* Option.match(active, {
      onNone: () => Effect.void,
      onSome: (run) => closeRun(run, options),
    });
  });

  // Server exit must never leak the child: SIGTERM (+ forceKillAfter) it.
  yield* Effect.addFinalizer(() => stop());

  return FeishuBotManager.of({
    start,
    stop,
    snapshot,
  });
});

export const layer = Layer.effect(FeishuBotManager, make);
