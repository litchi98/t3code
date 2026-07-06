/**
 * Environment access helpers extracted from bot.ts.
 *
 * Keeps the session's environment-scoped RPC helpers explicit while preserving
 * the original bridge closure bodies.
 */
import {
  connectionProjectionPhase,
  type EnvironmentRegistry,
  type EnvironmentSupervisor,
} from "@t3tools/client-runtime/connection";
import * as EnvironmentRpc from "@t3tools/client-runtime/rpc";
import {
  type EnvironmentId,
  ORCHESTRATION_WS_METHODS,
  type OrchestrationThreadStreamItem,
  type ThreadId,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

/** Generate a branded id from a fresh UUIDv4 using the platform crypto service. */
export const makeBrandedId = <A>(brand: { readonly make: (value: string) => A }) =>
  Crypto.Crypto.pipe(
    Effect.flatMap((crypto) => crypto.randomUUIDv4),
    Effect.orDie,
    Effect.map((uuid) => brand.make(uuid)),
  );

/** Dependencies for constructing the session's environment access handle. */
export interface EnvAccessDeps {
  readonly registry: EnvironmentRegistry["Service"];
  readonly environmentId: EnvironmentId;
  readonly crypto: Crypto.Crypto;
}

/** Handle returned by {@link makeEnvAccess}. */
export interface EnvAccessHandle {
  readonly runOnEnv: <A, E>(
    operation: Effect.Effect<A, E, Crypto.Crypto | EnvironmentSupervisor>,
  ) => Effect.Effect<A>;
  readonly genId: <A>(brand: { readonly make: (value: string) => A }) => Effect.Effect<A>;
  readonly subscribeThread: (threadId: ThreadId) => Stream.Stream<OrchestrationThreadStreamItem>;
  readonly isEnvReady: Effect.Effect<boolean>;
}

/** Construct environment access helpers for one bound Feishu session. */
export const makeEnvAccess = (deps: EnvAccessDeps): EnvAccessHandle => {
  const { registry, environmentId, crypto } = deps;

  /**
   * Run an environment-scoped orchestration command on the connected
   * environment, discharging its `EnvironmentSupervisor` (via `registry.run`)
   * and `Crypto` requirements and surfacing any RPC/unavailable failure as a
   * defect. Returns a fully total `Effect<A>` the bridge can compose freely.
   */
  const runOnEnv = <A, E>(
    operation: Effect.Effect<A, E, Crypto.Crypto | EnvironmentSupervisor>,
  ): Effect.Effect<A> =>
    registry
      .run(environmentId, operation)
      .pipe(Effect.provideService(Crypto.Crypto, crypto), Effect.orDie);

  // Branded-id generator with `Crypto` already provided → fully total effect.
  const genId = <A>(brand: { readonly make: (value: string) => A }): Effect.Effect<A> =>
    makeBrandedId(brand).pipe(Effect.provideService(Crypto.Crypto, crypto));

  // `subscribeThread` stream for the session observer (replays a snapshot
  // first; the defensive retry mirrors M0's create→subscribe propagation lag).
  const subscribeThread = (threadId: ThreadId): Stream.Stream<OrchestrationThreadStreamItem> =>
    registry
      .followStream(
        environmentId,
        EnvironmentRpc.subscribe(
          ORCHESTRATION_WS_METHODS.subscribeThread,
          { threadId },
          {
            onExpectedFailure: () =>
              Console.log("[feishu-bot] thread not ready yet; retrying subscription..."),
            retryExpectedFailureAfter: "250 millis",
          },
        ),
      )
      .pipe(Stream.orDie);

  // Point read of whether the t3code environment is currently connected
  // (`ready`). Used to gate first-contact thread creation: a brand-new chat
  // arriving while the server is offline must be buffered (⏳ + outbound queue)
  // rather than orDie'ing inside the `createThread` dispatch. Never fails
  // (a not-yet-registered environment reads as "not ready").
  const isEnvReady: Effect.Effect<boolean> = registry.state(environmentId).pipe(
    Effect.map((state) => connectionProjectionPhase(state) === "ready"),
    Effect.orElseSucceed(() => false),
  );

  return { runOnEnv, genId, subscribeThread, isEnvReady } as const;
};
