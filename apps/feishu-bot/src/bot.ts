import { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import { createProject, createThread, startThreadTurn } from "@t3tools/client-runtime/operations";
import * as EnvironmentRpc from "@t3tools/client-runtime/rpc";
import type { RemoteEnvironmentRequestError } from "@t3tools/client-runtime/rpc";
import {
  type EnvironmentId,
  MessageId,
  type ModelSelection,
  ORCHESTRATION_WS_METHODS,
  type OrchestrationSession,
  type OrchestrationShellStreamItem,
  type OrchestrationThreadStreamItem,
  ProjectId,
  ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";

import type { FeishuBotConfig } from "./config.ts";
import { resolveEnvironment, type ResolvedEnvironment } from "./auth.ts";
import { connectionLayer } from "./runtime/connection.ts";
import { describeThreadEvent } from "./events.ts";

/**
 * How long to wait for the first shell snapshot (i.e. a healthy, authenticated
 * websocket session) before giving up. `supervisor.connect` retries forever, so
 * without this bound a wrong `wsBaseUrl`, a failed ws-ticket exchange, or a down
 * server would hang silently at "discovering project...".
 */
const DISCOVERY_TIMEOUT = Duration.seconds(30);

/** Upper bound on how long we wait for a single turn to reach a terminal state. */
const TURN_TIMEOUT = Duration.minutes(5);

/** Picked project: its id plus the default model selection (if any). */
interface PickedProject {
  readonly projectId: ProjectId;
  readonly defaultModelSelection: ModelSelection | null;
}

/**
 * Extract the first project from a shell stream item, if present, as a `Filter`
 * result (for `Stream.filterMap`). The shell stream emits a `snapshot` frame
 * first (full state) followed by deltas; a new project arrives as a
 * `project-upserted` delta.
 */
function projectFromShellItem(
  item: OrchestrationShellStreamItem,
): Result.Result<PickedProject, void> {
  if (item.kind === "snapshot") {
    const first = item.snapshot.projects[0];
    return first === undefined
      ? Result.failVoid
      : Result.succeed({ projectId: first.id, defaultModelSelection: first.defaultModelSelection });
  }
  if (item.kind === "project-upserted") {
    return Result.succeed({
      projectId: item.project.id,
      defaultModelSelection: item.project.defaultModelSelection,
    });
  }
  return Result.failVoid;
}

/**
 * Discover the first project, creating one when the server has none.
 *
 * We consume the live shell stream (already scoped to the connected
 * environment). The first emitted item is the snapshot; if it carries a project
 * we use it, otherwise we create one and keep consuming until the
 * `project-upserted` delta arrives. `followStream` always replays the current
 * snapshot first, so re-running the projects stream after a create still
 * observes the new project.
 */
const discoverProject = (
  config: FeishuBotConfig,
  environmentId: EnvironmentId,
  registry: EnvironmentRegistry["Service"],
  shellStream: Stream.Stream<OrchestrationShellStreamItem>,
) =>
  Effect.gen(function* () {
    const projects = shellStream.pipe(Stream.filterMap(projectFromShellItem));

    // Inspect only the initial snapshot frame (always emitted first) so we get a
    // bounded decision: a live `runHead` over `projects` would block forever when
    // the snapshot has no project, since the stream never terminates.
    const firstFrame = yield* Stream.runHead(shellStream.pipe(Stream.take(1)));
    const fromSnapshot = Option.flatMap(firstFrame, (item) =>
      Result.getSuccess(projectFromShellItem(item)),
    );
    if (Option.isSome(fromSnapshot)) {
      return fromSnapshot.value;
    }

    yield* Console.log(`[feishu-bot] no project found; creating one at ${config.workspaceRoot}.`);
    const projectId = yield* makeBrandedId(ProjectId);
    yield* registry.run(
      environmentId,
      createProject({
        projectId,
        title: "feishu-bot",
        workspaceRoot: config.workspaceRoot,
        createWorkspaceRootIfMissing: true,
      }),
    );

    const created = yield* Stream.runHead(projects);
    return yield* Option.match(created, {
      onNone: () =>
        Effect.die(new Error("Project was created but never appeared in the shell stream.")),
      onSome: Effect.succeed,
    });
  });

/**
 * Resolve the model selection for the new thread: prefer the project's
 * `defaultModelSelection`, otherwise pick the first enabled+ready provider's
 * first model from `server.getConfig`.
 */
const resolveModelSelection = (project: PickedProject) =>
  Effect.gen(function* () {
    if (project.defaultModelSelection !== null) {
      return project.defaultModelSelection;
    }
    const serverConfig = yield* EnvironmentRpc.request(WS_METHODS.serverGetConfig, {});
    const provider = serverConfig.providers.find(
      (candidate) => candidate.enabled && candidate.status === "ready",
    );
    if (provider === undefined) {
      return yield* Effect.die(
        new Error("No enabled, ready provider is available to start a thread."),
      );
    }
    const model = provider.models[0];
    if (model === undefined) {
      return yield* Effect.die(new Error(`Provider ${provider.instanceId} exposes no models.`));
    }
    return { instanceId: provider.instanceId, model: model.slug } satisfies ModelSelection;
  });

/** Generate a branded id from a fresh UUIDv4 using the platform crypto service. */
const makeBrandedId = <A>(brand: { readonly make: (value: string) => A }) =>
  Crypto.Crypto.pipe(
    Effect.flatMap((crypto) => crypto.randomUUIDv4),
    Effect.orDie,
    Effect.map((uuid) => brand.make(uuid)),
  );

/**
 * The core M0 conversation, run inside the connection layer (so the
 * `EnvironmentRegistry` is available and the environment is connected).
 */
const runConversation = (config: FeishuBotConfig, resolved: ResolvedEnvironment) =>
  Effect.gen(function* () {
    const registry = yield* EnvironmentRegistry;
    const environmentId = resolved.target.environmentId;

    yield* Console.log(`[feishu-bot] connected to ${resolved.target.label} (${environmentId}).`);
    yield* Console.log("[feishu-bot] discovering project...");

    const shellStream = registry
      .followStream(
        environmentId,
        EnvironmentRpc.subscribe(ORCHESTRATION_WS_METHODS.subscribeShell, {}),
      )
      .pipe(Stream.orDie);

    // Bound discovery: the first shell snapshot only arrives once the websocket
    // session is connected and authenticated. `supervisor.connect` retries
    // forever, so a wrong `wsBaseUrl`, a failed ws-ticket exchange, or a down
    // server would otherwise hang here indefinitely with no diagnostic.
    const project = yield* discoverProject(config, environmentId, registry, shellStream).pipe(
      Effect.timeoutOrElse({
        duration: DISCOVERY_TIMEOUT,
        orElse: () =>
          Effect.die(
            new Error(
              `Timed out after ${Duration.format(DISCOVERY_TIMEOUT)} waiting for the first shell ` +
                "snapshot. Check that the server is running and that wsBaseUrl is correct and " +
                "reachable, and that the ws-ticket exchange (pairing token) succeeds.",
            ),
          ),
      }),
    );
    yield* Console.log(`[feishu-bot] using project ${project.projectId}.`);

    const modelSelection = yield* registry.run(environmentId, resolveModelSelection(project));
    yield* Console.log(
      `[feishu-bot] model: ${modelSelection.instanceId} / ${modelSelection.model}.`,
    );

    const threadId = yield* makeBrandedId(ThreadId);
    const messageId = yield* makeBrandedId(MessageId);

    // Resolved with the final session once the turn reaches a terminal state.
    // We key completion off `thread.session-set` (see the consumer below) rather
    // than `thread.turn-diff-completed`, which is git-gated and never fires for
    // the default non-git workspace + plain-text prompt.
    const turnDone = yield* Deferred.make<OrchestrationSession>();
    // The server dispatches `thread.session-set` on many lifecycle events, and
    // the initial `session.started`/`thread.started` snapshot is already
    // `status: ready, activeTurnId: null` BEFORE our turn runs. Latch on the
    // first time we see the turn actually running so we don't resolve early.
    const turnObserved = yield* Ref.make(false);

    // Create the thread BEFORE subscribing so the subscription's first frame is
    // a real snapshot rather than a `Thread ... was not found` domain failure.
    // The subscription replays the full snapshot first, so starting the turn
    // only after the consumer is forked guarantees no turn events are missed.
    yield* Console.log(`[feishu-bot] creating thread ${threadId}.`);
    yield* registry.run(
      environmentId,
      createThread({
        threadId,
        projectId: project.projectId,
        title: "feishu-bot M0",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      }),
    );

    // Defensive guard against a `createThread` -> subscribe propagation lag: if
    // the snapshot read still races ahead of the write, `onExpectedFailure`
    // swallows the domain `OrchestrationGetSnapshotError` (instead of turning it
    // into a defect) and retries shortly. `orDie` is reserved for genuinely
    // unexpected, non-domain causes.
    const threadStream = registry
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

    // Inspect a session for turn completion. The server re-derives the session
    // on a snapshot too, so we read it from both frame kinds (a mid-turn
    // transport reconnect replays a fresh snapshot rather than the live events).
    const observeSession = (session: OrchestrationSession) =>
      Effect.gen(function* () {
        // A turn is active while it has an `activeTurnId`; remember that ours ran.
        if (session.activeTurnId !== null) {
          yield* Ref.set(turnObserved, true);
          return;
        }
        // `activeTurnId === null`: ignore transient states; otherwise this is a
        // terminal state. Treat it as completion only after the turn has run, OR
        // when the status is a failure terminal (which would not be observed
        // before a turn started under normal operation).
        if (session.status === "starting" || session.status === "running") {
          return;
        }
        const seen = yield* Ref.get(turnObserved);
        if (seen || isFailureStatus(session.status)) {
          yield* Deferred.succeed(turnDone, session);
        }
      });

    // Fork the consumer before starting the turn so the real-time turn events
    // are observed. The forked fiber is scoped, so it is interrupted
    // automatically when this effect's scope closes.
    yield* threadStream.pipe(
      Stream.runForEach((item: OrchestrationThreadStreamItem) =>
        Effect.gen(function* () {
          yield* Console.log(describeThreadEvent(item));
          if (item.kind === "snapshot") {
            if (item.snapshot.thread.session !== null) {
              yield* observeSession(item.snapshot.thread.session);
            }
            return;
          }
          if (item.event.type === "thread.session-set") {
            yield* observeSession(item.event.payload.session);
          }
        }),
      ),
      Effect.forkScoped,
    );

    yield* Console.log("[feishu-bot] starting turn with prompt.");
    yield* registry.run(
      environmentId,
      startThreadTurn({
        threadId,
        message: {
          messageId,
          role: "user",
          text: config.prompt,
          attachments: [],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
      }),
    );

    yield* Console.log("[feishu-bot] waiting for the turn to complete...");
    const outcome = yield* Deferred.await(turnDone).pipe(
      Effect.map(Option.some<OrchestrationSession>),
      Effect.timeoutOrElse({
        duration: TURN_TIMEOUT,
        orElse: () =>
          Console.error(
            `[feishu-bot] turn did not complete within ${Duration.format(TURN_TIMEOUT)}; ` +
              "check the server logs and that the provider is reachable. Shutting down.",
          ).pipe(Effect.as(Option.none<OrchestrationSession>())),
      }),
    );

    yield* Option.match(outcome, {
      onNone: () => Effect.void,
      onSome: (session) =>
        session.status === "error"
          ? Console.error(
              `[feishu-bot] turn ended in error (status=${session.status}` +
                `${session.lastError === null ? "" : `, lastError=${session.lastError}`}).`,
            )
          : Console.log(`[feishu-bot] turn complete (status=${session.status}); shutting down.`),
    });
  });

/**
 * Failure terminals for a session: a turn that ends in `error`, is
 * `interrupted`, or whose session is `stopped`/`exited`. These should not be
 * observed before a turn has started under normal operation, so they double as a
 * completion signal even if we somehow missed the running phase.
 */
const isFailureStatus = (status: OrchestrationSession["status"]): boolean =>
  status === "error" || status === "interrupted" || status === "stopped";

/**
 * Translate the typed `resolveEnvironment` failures into an actionable,
 * single-line diagnostic and exit cleanly. The auth boundary surfaces typed
 * errors (token rejected/expired, server unreachable, timeout, bad response)
 * instead of collapsing them into a bare defect, so we can guide the operator.
 */
const reportAuthFailure = (error: RemoteEnvironmentRequestError): Effect.Effect<void> => {
  switch (error._tag) {
    case "EnvironmentAuthInvalidError":
      return Console.error(
        `[feishu-bot] pairing token rejected (${error.reason}). Re-run /pair on the server and update T3_PAIRING_TOKEN.`,
      );
    case "EnvironmentScopeRequiredError":
      return Console.error(
        `[feishu-bot] pairing token is missing the required scope "${error.requiredScope}". Re-issue it with the needed scopes.`,
      );
    case "EnvironmentRequestInvalidError":
      return Console.error(`[feishu-bot] auth request rejected by the server (${error.reason}).`);
    case "EnvironmentOperationForbiddenError":
      return Console.error(`[feishu-bot] auth operation forbidden (${error.reason}).`);
    case "EnvironmentInternalError":
      return Console.error(`[feishu-bot] the server reported an internal error (${error.reason}).`);
    case "RemoteEnvironmentAuthTimeoutError":
    case "RemoteEnvironmentAuthFetchError":
      return Console.error(
        `[feishu-bot] could not reach the server; is it running and are httpBaseUrl/wsBaseUrl correct? (${error.message})`,
      );
    case "RemoteEnvironmentAuthUndeclaredStatusError":
    case "RemoteEnvironmentAuthInvalidJsonError":
      return Console.error(
        `[feishu-bot] the server returned an unexpected response. ${error.message}`,
      );
  }
};

/**
 * Top-level program: resolve the environment, build the connection layer from
 * the resolved target, then run the conversation to completion. The whole flow
 * is wrapped in `Effect.scoped` so the connection (and its forked fibers) tear
 * down cleanly on exit. Typed auth failures are reported as actionable
 * one-liners before exiting cleanly; only genuinely unexpected defects die.
 */
export const program = (config: FeishuBotConfig): Effect.Effect<void> =>
  Effect.gen(function* () {
    const resolved = yield* resolveEnvironment(config);
    yield* runConversation(config, resolved).pipe(
      Effect.provide(
        connectionLayer({ target: resolved.target, accessToken: resolved.accessToken }),
      ),
      Effect.scoped,
    );
  }).pipe(
    Effect.catchTags({
      EnvironmentRequestInvalidError: reportAuthFailure,
      EnvironmentAuthInvalidError: reportAuthFailure,
      EnvironmentScopeRequiredError: reportAuthFailure,
      EnvironmentOperationForbiddenError: reportAuthFailure,
      EnvironmentInternalError: reportAuthFailure,
      RemoteEnvironmentAuthFetchError: reportAuthFailure,
      RemoteEnvironmentAuthInvalidJsonError: reportAuthFailure,
      RemoteEnvironmentAuthUndeclaredStatusError: reportAuthFailure,
      RemoteEnvironmentAuthTimeoutError: reportAuthFailure,
    }),
    Effect.orDie,
  );
