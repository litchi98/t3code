import {
  connectionProjectionPhase,
  EnvironmentRegistry,
  EnvironmentSupervisor,
} from "@t3tools/client-runtime/connection";
import { createProject, createThread, startThreadTurn } from "@t3tools/client-runtime/operations";
import * as EnvironmentRpc from "@t3tools/client-runtime/rpc";
import type { RemoteEnvironmentRequestError } from "@t3tools/client-runtime/rpc";
import {
  type EnvironmentId,
  isProviderAvailable,
  MessageId,
  type ModelSelection,
  ORCHESTRATION_WS_METHODS,
  type OrchestrationMessage,
  type OrchestrationShellStreamItem,
  type OrchestrationThread,
  type OrchestrationThreadStreamItem,
  ProjectId,
  type ServerProvider,
  ThreadId,
  TrimmedNonEmptyString,
  WS_METHODS,
} from "@t3tools/contracts";
import { resolveSelectableModel } from "@t3tools/shared/model";
import * as Console from "effect/Console";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import type { FeishuBotConfig } from "./config.ts";
import { resolveEnvironment, type ResolvedEnvironment } from "./auth.ts";
import { connectionLayer } from "./runtime/connection.ts";
import { ChatThreadMapStore, fileStoresLayer, SentCommandStore } from "./runtime/persistence.ts";
import { LarkGateway } from "./lark/index.ts";
import { larkGatewayLayer } from "./lark/channel.ts";
import type { BridgeHandlers, InboundMessage } from "./lark/types.ts";
import { deriveThreadId, ensureThreadForChat } from "./bridge/chatThreadMap.ts";
import { deriveCommandId } from "./bridge/commandId.ts";
import { renderThreadCard } from "./bridge/eventRenderer.ts";
import { observeThread, type ThreadObservation } from "./bridge/session.ts";
import { type MergedDispatch, TurnQueue, turnQueueLayer } from "./bridge/turnQueue.ts";
import { OutboundQueue, outboundQueueLayer } from "./bridge/outbound.ts";

/**
 * How long to wait for the first shell snapshot (i.e. a healthy, authenticated
 * websocket session) before giving up. `supervisor.connect` retries forever, so
 * without this bound a wrong `wsBaseUrl`, a failed ws-ticket exchange, or a down
 * server would hang silently at "discovering project...".
 */
const DISCOVERY_TIMEOUT = Duration.seconds(30);

/**
 * "Still offline — retry me" signal. A buffered turn raised by the outbound flush
 * fails with this when the environment dropped again mid-flush, so the outbound
 * queue keeps the intent (+ its ⏳) and retries on a later flush rather than
 * recording it as sent. Internal to the bridge; never escapes a handler.
 */
class OfflineRetry extends Data.TaggedError("OfflineRetry") {}

/** Picked project: its id plus the default model selection (if any). */
interface PickedProject {
  readonly projectId: ProjectId;
  readonly defaultModelSelection: ModelSelection | null;
}

// ── Project / model discovery (reused verbatim from M0) ──────────────────────

/**
 * Extract the first project from a shell stream item, if present, as a `Filter`
 * result (for `Stream.filterMap`).
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

/** Discover the first project, creating one when the server has none. */
const discoverProject = (
  config: FeishuBotConfig,
  environmentId: EnvironmentId,
  registry: EnvironmentRegistry["Service"],
  shellStream: Stream.Stream<OrchestrationShellStreamItem>,
) =>
  Effect.gen(function* () {
    const projects = shellStream.pipe(Stream.filterMap(projectFromShellItem));

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
 * Whether `selection` still names a model on a currently-ready provider. Used to
 * validate a persisted `defaultModelSelection` before reusing it: a default that
 * points at a now-disabled/unavailable instance (or a model the instance no
 * longer exposes) must fall back rather than dispatch an unroutable selection.
 */
const isSelectionRoutable = (
  selection: ModelSelection,
  readyProviders: ReadonlyArray<ServerProvider>,
): boolean =>
  readyProviders.some(
    (provider) =>
      provider.instanceId === selection.instanceId &&
      provider.models.some((model) => model.slug === selection.model),
  );

/**
 * Resolve the model selection used to create the thread (and, under an explicit
 * override, to pin every turn — see `buildTurnStart`).
 *
 * Priority:
 *  1. **`T3_MODEL` override** (when set): wins over everything. Match it across
 *     *all* ready providers via the shared canonical resolver
 *     (`resolveSelectableModel`, which honours per-driver slug aliases such as
 *     `opus` → the canonical slug and name matches), preferring an exact/alias
 *     hit. Die — listing the available slugs across *every* ready provider — if
 *     nothing matches.
 *  2. The project's **`defaultModelSelection`**, but only if it still names a
 *     model on a ready provider; otherwise fall back (with a warning).
 *  3. The **first ready provider's first model**.
 *
 * "Ready" mirrors the web client: `enabled && isProviderAvailable && status ===
 * "ready"`. Dies with a clear message when no ready provider (or no model on
 * one) is available.
 */
const resolveModelSelection = (project: PickedProject, modelOverride: string | null) =>
  Effect.gen(function* () {
    const serverConfig = yield* EnvironmentRpc.request(WS_METHODS.serverGetConfig, {});
    const readyProviders = serverConfig.providers.filter(
      (provider) =>
        provider.enabled && isProviderAvailable(provider) && provider.status === "ready",
    );
    if (readyProviders.length === 0) {
      return yield* Effect.die(
        new Error("No enabled, available, ready provider is available to start a thread."),
      );
    }

    // 1. Explicit T3_MODEL override: match across ALL ready providers via the
    //    shared canonical resolver (driver-aware alias + name matching),
    //    preferring an exact/alias hit over a later candidate.
    if (modelOverride !== null) {
      const matches: ReadonlyArray<ModelSelection> = readyProviders.flatMap((provider) => {
        const slug = resolveSelectableModel(provider.driver, modelOverride, provider.models);
        return slug === null
          ? []
          : [{ instanceId: provider.instanceId, model: slug } satisfies ModelSelection];
      });
      const chosen = matches[0];
      if (chosen === undefined) {
        const available = readyProviders
          .flatMap((provider) =>
            provider.models.map((model) => `${provider.instanceId}/${model.slug}`),
          )
          .join(", ");
        return yield* Effect.die(
          new Error(
            `No model on any ready provider matches T3_MODEL="${modelOverride}". ` +
              `Available: ${available || "(none)"}.`,
          ),
        );
      }
      if (matches.length > 1) {
        yield* Console.warn(
          `[feishu-bot] T3_MODEL="${modelOverride}" matched ${matches.length} ready providers; ` +
            `using ${chosen.instanceId}/${chosen.model}.`,
        );
      }
      return chosen;
    }

    // 2. No override: prefer the project's persisted default, but only if it is
    //    still routable on a ready provider; otherwise fall back with a warning.
    if (project.defaultModelSelection !== null) {
      if (isSelectionRoutable(project.defaultModelSelection, readyProviders)) {
        return project.defaultModelSelection;
      }
      yield* Console.warn(
        `[feishu-bot] project default model ${project.defaultModelSelection.instanceId}/` +
          `${project.defaultModelSelection.model} is no longer on a ready provider; ` +
          "falling back to the first ready provider's first model.",
      );
    }

    // 3. First ready provider's first model.
    const provider = readyProviders[0]!;
    const firstModel = provider.models[0];
    if (firstModel === undefined) {
      return yield* Effect.die(new Error(`Provider ${provider.instanceId} exposes no models.`));
    }
    return { instanceId: provider.instanceId, model: firstModel.slug } satisfies ModelSelection;
  });

/** Generate a branded id from a fresh UUIDv4 using the platform crypto service. */
const makeBrandedId = <A>(brand: { readonly make: (value: string) => A }) =>
  Crypto.Crypto.pipe(
    Effect.flatMap((crypto) => crypto.randomUUIDv4),
    Effect.orDie,
    Effect.map((uuid) => brand.make(uuid)),
  );

/**
 * Decode a `TrimmedNonEmptyString`. Compiled once at module scope (the schema's
 * decoder is rebuilt on every call site otherwise). Used only for the
 * statically-valid placeholder title, so callers `Effect.orDie` the result.
 */
const decodeTrimmedNonEmpty = Schema.decodeEffect(TrimmedNonEmptyString);

// ── Resident bridge core ─────────────────────────────────────────────────────

/**
 * The resident core: connect to Feishu, then route every private-chat message
 * through the bridge (bind → dispatch/queue → observe → render → stream card),
 * looping forever. Runs inside the connection layer (so `EnvironmentRegistry` is
 * available) and the bot's own scope (so subscriptions/fibers tear down on exit).
 */
const runBridge = (config: FeishuBotConfig, resolved: ResolvedEnvironment) =>
  Effect.gen(function* () {
    const registry = yield* EnvironmentRegistry;
    const gateway = yield* LarkGateway;
    const chatThreadMap = yield* ChatThreadMapStore;
    const sent = yield* SentCommandStore;
    const outbound = yield* OutboundQueue;
    const turnQueue = yield* TurnQueue;
    const environmentId = resolved.target.environmentId;

    yield* Console.log(`[feishu-bot] connected to ${resolved.target.label} (${environmentId}).`);
    yield* Console.log("[feishu-bot] discovering project...");

    const shellStream = registry
      .followStream(
        environmentId,
        EnvironmentRpc.subscribe(ORCHESTRATION_WS_METHODS.subscribeShell, {}),
      )
      .pipe(Stream.orDie);

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

    const modelSelection = yield* registry.run(
      environmentId,
      resolveModelSelection(project, config.modelOverride),
    );
    yield* Console.log(
      `[feishu-bot] model: ${modelSelection.instanceId} / ${modelSelection.model}.`,
    );

    // Per-turn model selection (M2 cross-end safety). Only an *explicit*
    // `T3_MODEL` override pins the model on every turn; without one we omit
    // `modelSelection` on `startThreadTurn` so the server keeps the thread's
    // persistent model — honouring both the creation-time choice and any model
    // switch another end (e.g. web) made. Unconditionally re-sending the
    // startup selection would silently overwrite such a switch (and break the
    // next turn for `requiresNewThreadForModelChange` providers like Grok),
    // and the server does not per-turn-switch an existing thread anyway, so it
    // would be useless and harmful. (`createThread` still always carries
    // `modelSelection` — it is required to build the thread.)
    const perTurnModelSelection: ModelSelection | null =
      config.modelOverride === null ? null : modelSelection;

    // Capture the platform crypto service so environment-scoped command
    // operations (which need `Crypto` for any auto-generated ids) can have that
    // requirement discharged here, leaving a fully-total effect for the bridge.
    const crypto = yield* Crypto.Crypto;

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

    // A minimal, schema-valid `OrchestrationThread` used as the seed for the
    // first card render (before any tick) and as the envelope for static notice
    // cards. Built once from real branded ids + the resolved model selection, so
    // it satisfies every required field with proper types — no `as unknown`
    // cast. `renderThreadCard` only reads `messages`/`activities`/`session`; the
    // rest is well-typed filler.
    // A statically-valid constant; a decode failure here would be a programmer
    // error, so surface it as a defect rather than threading `SchemaError`.
    const placeholderTitle = yield* decodeTrimmedNonEmpty("feishu-bot").pipe(Effect.orDie);
    const placeholderTimestamp = "1970-01-01T00:00:00.000Z";
    const placeholderThreadId = yield* genId(ThreadId);
    const placeholderMessageId = yield* genId(MessageId);
    const placeholderThread: OrchestrationThread = {
      id: placeholderThreadId,
      projectId: project.projectId,
      title: placeholderTitle,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      latestTurn: null,
      createdAt: placeholderTimestamp,
      updatedAt: placeholderTimestamp,
      archivedAt: null,
      deletedAt: null,
      messages: [],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
      session: null,
    };

    // Render a static, single-message notice card into the placeholder envelope.
    // The notice text rides in as one assistant message so it flows through the
    // real renderer (markdown body, byte clamping) instead of hand-built JSON.
    const makeNoticeThread = (text: string): OrchestrationThread => {
      const message: OrchestrationMessage = {
        id: placeholderMessageId,
        role: "assistant",
        text,
        turnId: null,
        streaming: false,
        createdAt: placeholderTimestamp,
        updatedAt: placeholderTimestamp,
      };
      return { ...placeholderThread, messages: [message] };
    };

    // Send a one-off, non-streaming notice card to `chatId` (e.g. "text only",
    // "server not connected"). Opens a streaming card whose completion is already
    // resolved, so the SDK producer renders once and settles immediately. Failures
    // are logged and swallowed — a notice must never crash the handler.
    const sendNotice = (chatId: string, text: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        const done = yield* Deferred.make<void>();
        yield* Deferred.succeed(done, undefined);
        const card = renderThreadCard(makeNoticeThread(text), { streaming: false }).card;
        yield* gateway.startStreamingCard(chatId, card, { done: Deferred.await(done) }).pipe(
          Effect.tapError((error) =>
            Console.error(`[feishu-bot] notice card failed for chat ${chatId}: ${error.message}`),
          ),
          Effect.ignore,
        );
      });

    // Capture a runtime that forks effects into a scoped FiberSet. This is the
    // edge between the SDK's plain `void` callbacks and the Effect world: the
    // callback offers to a queue, and a forked consumer drains it. Forked fibers
    // are interrupted when the scope closes. Every service the forked effects use
    // (Crypto/EnvironmentSupervisor via `genId`/`runOnEnv`, the stores via their
    // captured service values) is already discharged, so the forked effects are
    // fully total — the runtime needs no residual requirements.
    const runFork = yield* FiberSet.makeRuntime<never>();

    // Inbound mailbox: the SDK callback is non-blocking, so it only enqueues;
    // the consumer below forks one handler per message.
    const inbox = yield* Queue.unbounded<InboundMessage>();

    // Serialize the first-contact get-or-create so two concurrent messages for
    // an unbound chat can never race into two threads. Cheap after the first
    // message (a store cache hit); a single global permit is ample for M1's
    // low, 1:1 private-chat traffic.
    const ensureLock = yield* Semaphore.make(1);

    // Per-chat turn lock: guarantees at most one turn runs for a chat at a time
    // regardless of path. The live queue's `running` flag already serialises
    // *live* turns, but a turn replayed from the outbound flush on reconnect does
    // not pass through `offer` and so would otherwise be invisible to that flag —
    // this lock keeps a flushed turn from dispatching concurrently with a fresh
    // live turn on the same thread (which would steer/overwrite the agent). Locks
    // are created lazily per chat and never reaped (one tiny Semaphore per chat is
    // negligible for M1's 1:1 traffic).
    const chatTurnLocks = yield* Ref.make<ReadonlyMap<string, Semaphore.Semaphore>>(new Map());
    const withChatTurnLock = <A, E>(chatId: string, effect: Effect.Effect<A, E>) =>
      Ref.modify(
        chatTurnLocks,
        (map): readonly [Semaphore.Semaphore, ReadonlyMap<string, Semaphore.Semaphore>] => {
          const existing = map.get(chatId);
          if (existing !== undefined) {
            return [existing, map];
          }
          const created = Semaphore.makeUnsafe(1);
          return [created, new Map(map).set(chatId, created)];
        },
      ).pipe(Effect.flatMap((lock) => lock.withPermits(1)(effect)));

    // Chats with an offline `createThread` already buffered this session, so a
    // *second* offline message for the same brand-new chat does not enqueue a
    // second create (which would hit the server's "thread already exists"
    // invariant — distinct create commandIds, same deterministic threadId). The
    // binding is persisted by the create intent *on success* (not optimistically),
    // so this in-memory set and the in-memory outbound queue are lost together on
    // a crash — a restart then re-creates the thread cleanly rather than pointing
    // a persisted binding at a thread that was never created.
    const pendingCreates = yield* Ref.make<ReadonlySet<string>>(new Set());

    /**
     * Build the `ThreadTurnStart` command for a merged dispatch. Stable
     * commandId, NO `createdAt` (M9/M19); a fresh `MessageId` per attempt is fine
     * (the server keys idempotency on the stable `commandId`, not the messageId).
     *
     * `modelSelection` is attached ONLY when an explicit `T3_MODEL` override is
     * set (`perTurnModelSelection !== null`); in that case every turn is pinned
     * to the bot-resolved model. Without an override it is omitted so the server
     * keeps the thread's persistent model — preserving the creation-time choice
     * and any model switch made by another end (M2). See `perTurnModelSelection`.
     */
    const buildTurnStart = (threadId: ThreadId, dispatch: MergedDispatch) =>
      genId(MessageId).pipe(
        Effect.map((messageId) =>
          startThreadTurn({
            commandId: dispatch.commandId,
            threadId,
            message: { messageId, role: "user", text: dispatch.prompt, attachments: [] },
            ...(perTurnModelSelection === null ? {} : { modelSelection: perTurnModelSelection }),
            runtimeMode: "full-access",
            interactionMode: "default",
          }),
        ),
      );

    // Drive the live card + observer + completion for an already-dispatched turn.
    // `cardDone` is resolved on EVERY exit (success/failure/interrupt) so the SDK
    // stream producer always exits and `stream()` settles — never a parked
    // producer (the LOW cardDone finding). Requires a `Scope`: the per-tick card
    // updater is `forkScoped` onto the caller's turn scope (`runTurn`'s
    // `Effect.scoped`), so it is interrupted when the turn ends.
    const driveTurn = (
      chatId: string,
      threadId: ThreadId,
      observation: ThreadObservation,
    ): Effect.Effect<void, never, Scope.Scope> =>
      Effect.gen(function* () {
        const cardDone = yield* Deferred.make<void>();
        yield* Effect.gen(function* () {
          const initial = renderThreadCard(placeholderThread, { streaming: true }).card;

          const card = yield* gateway
            .startStreamingCard(chatId, initial, { done: Deferred.await(cardDone) })
            .pipe(
              // A failed card start must not abort the turn; the agent still runs.
              Effect.tapError((error) =>
                Console.error(`[feishu-bot] streaming card failed to start: ${error.message}`),
              ),
              Effect.option,
            );

          // Push each render tick to the card (best-effort; throttled by the SDK).
          const handle = Option.isSome(card) ? card.value : null;
          if (handle !== null) {
            yield* observation.ticks.pipe(
              Stream.runForEach((thread) =>
                handle
                  .update(renderThreadCard(thread, { streaming: true }).card)
                  .pipe(Effect.ignore),
              ),
              Effect.forkScoped,
            );
          }

          // Wait for the turn to reach a terminal state.
          const outcome = yield* observation.completion;
          yield* Console.log(
            `[feishu-bot] turn ${outcome.kind} on thread ${threadId}` +
              (outcome.kind === "failed" ? ` (status=${outcome.status}).` : "."),
          );

          // Final card render from the fold's authoritative state.
          if (handle !== null) {
            const finalThread = yield* observation.current;
            if (finalThread !== null) {
              yield* handle
                .update(renderThreadCard(finalThread, { streaming: false }).card)
                .pipe(Effect.ignore);
            }
          }
        }).pipe(
          // Whatever happens, release the SDK producer so the card settles into
          // its terminal (non-streaming) form instead of parking forever.
          Effect.ensuring(Deferred.succeed(cardDone, undefined)),
        );
      });

    /**
     * What to do when a turn dispatch finds the environment offline. Two callers:
     *  - **live** (`offlineBuffer`): give a ⏳ receipt and buffer a *flush* turn so
     *    the reconnect re-runs the full pipeline. Succeeds (the live message is now
     *    safely queued; the running flag is released by the completion path).
     *  - **flush** (`offlineRetry`): the environment dropped *again* mid-flush —
     *    **fail** with `OfflineRetry` so the outbound queue keeps the intent + its
     *    ⏳ and retries on the next flush (never records it as sent, never drops).
     */
    type OfflineStrategy = (params: {
      readonly chatId: string;
      readonly threadId: ThreadId;
      readonly dispatch: MergedDispatch;
      readonly feishuMessageId: string;
    }) => Effect.Effect<void, OfflineRetry>;

    const offlineRetry: OfflineStrategy = () => Effect.fail(new OfflineRetry());

    const offlineBuffer: OfflineStrategy = ({ chatId, threadId, dispatch, feishuMessageId }) =>
      Effect.gen(function* () {
        yield* Console.log(
          `[feishu-bot] environment offline; queued turn for chat ${chatId} (⏳).`,
        );
        // Buffer the full turn: on reconnect the flush re-runs `runTurn` with the
        // `offlineRetry` strategy, so a mid-flush re-drop fails the intent (keeping
        // it + its ⏳) rather than self-enqueuing under the `offlineBuffer` path.
        yield* outbound.enqueue({
          commandId: dispatch.commandId,
          feishuMessageId,
          run: runTurn(chatId, threadId, dispatch, offlineRetry),
        });
      });

    /**
     * Drive a single turn for `chatId` end to end.
     *
     * Accounting model (H3 reconnect-flush regression fix). Every turn — live or
     * flushed/replayed off the outbound queue — owns the chat's running slot for
     * exactly its lifetime:
     *  1. **Begin (inside the lock, before dispatch):** `beginTurn` mints a fresh
     *     ownership token and (idempotently) marks the slot running. A live turn
     *     already had `running` set by `offer`; a flushed/replay turn — which never
     *     passed through `offer` — gets it set here. Either way, messages arriving
     *     while this turn runs are *held*, not steered (invariant: a flushed turn
     *     still holds new traffic correctly).
     *  2. **Settle (inside the lock, on EVERY exit, before release):** the turn's
     *     finalizer calls `onTurnComplete(chatId, token)`. The queue only mutates
     *     state when `token` still owns the slot, so this turn settles *exactly*
     *     the `running`/`held` it claimed — a flushed turn can never clobber a live
     *     turn's running flag or drain its held messages (the bug). Because the
     *     settle runs *before the lock releases*, the next same-chat turn cannot
     *     begin until this one's accounting is committed ("settle before yield").
     *  3. **Chain (outside the lock):** if the settle drained held messages, the
     *     follow-up `runTurn` is dispatched *after the lock is released*, so it can
     *     re-acquire the same chat lock without self-deadlock.
     *
     * 1:1 pairing: each `beginTurn` is settled by exactly one matching
     * `onTurnComplete`; non-owning completions are no-ops. So `running`-true count
     * and settling count stay balanced even when a reconnect flush overlaps live
     * traffic on the same chat.
     *
     * Ordering rule (M0-verified trap): `observeThread` opens the subscription
     * *before* `startThreadTurn` dispatches, so no turn event is missed and the
     * dispatch never races a not-yet-ready session.
     *
     * Offline recovery (M8): if the dispatch finds the environment unavailable /
     * not yet registered, `onOffline` decides — the live caller buffers the *whole*
     * turn (card, observer, completion) as an outbound intent that re-runs this
     * same `runTurn` on reconnect (⏳ meanwhile); the flush caller fails with
     * `OfflineRetry` so the queue retries it. Either way the buffered turn flows
     * through the identical streaming pipeline and re-joins the queue's running/
     * completion coordination — never a bare, observer-less dispatch.
     */
    const runTurn = (
      chatId: string,
      threadId: ThreadId,
      dispatch: MergedDispatch,
      onOffline: OfflineStrategy,
    ): Effect.Effect<void, OfflineRetry> =>
      Effect.gen(function* () {
        // The held follow-up the settle drained (if any). Written by the in-lock
        // settle finalizer; read by the out-of-lock chain finalizer below. A Ref
        // (not a closure result) because the settle runs inside an `onExit`
        // finalizer whose value cannot otherwise reach the chain step.
        const followUp = yield* Ref.make<MergedDispatch | null>(null);

        yield* Effect.gen(function* () {
          // Own the running slot for this turn's whole critical section. Done
          // first, inside the lock, so ownership is established before the
          // dispatch and settled before the lock releases (settle-before-yield).
          // A flushed/replay turn (which bypassed `offer`) sets `running` here, so
          // messages arriving while it runs are held — never steering it.
          const token = yield* turnQueue.beginTurn(chatId);

          yield* Effect.gen(function* () {
            // Local idempotency pre-check (M9): a stable commandId already recorded
            // as sent means a prior attempt/delivery dispatched this exact turn.
            // Short-circuit so a crash-recovery replay never double-dispatches (the
            // server's commandReceipt store is the second line of defence).
            const already = yield* sent
              .has(dispatch.commandId)
              .pipe(Effect.orElseSucceed(() => false));
            if (already) {
              yield* Console.log(
                `[feishu-bot] skipping already-dispatched turn for chat ${chatId} (commandId seen).`,
              );
              return;
            }

            // Subscribe BEFORE dispatching (M0-verified ordering trap).
            const observation = yield* observeThread(threadId, { subscribe: subscribeThread });

            const turnStart = yield* buildTurnStart(threadId, dispatch);

            // Attempt the dispatch. If the environment is unavailable / not yet
            // connected (M8), hand off to `onOffline` (buffer live / retry on
            // flush) instead of dropping; the re-dispatch is idempotent under the
            // stable commandId. Skip the live card here — there is no live turn to
            // stream yet.
            const triggerMessageId = dispatch.sources[0]?.message.messageId ?? dispatch.commandId;
            const dispatched = yield* registry.run(environmentId, turnStart).pipe(
              Effect.provideService(Crypto.Crypto, crypto),
              Effect.as(true as const),
              Effect.catchTags({
                EnvironmentRpcUnavailableError: () => Effect.succeed(false as const),
                EnvironmentNotRegisteredError: () => Effect.succeed(false as const),
              }),
              // Any other failure (validation/internal) is a genuine defect.
              Effect.orDie,
            );
            if (!dispatched) {
              yield* onOffline({ chatId, threadId, dispatch, feishuMessageId: triggerMessageId });
              return;
            }
            // Record the dispatch as sent (M9) so a later replay/flush short-circuits.
            yield* sent.add(dispatch.commandId).pipe(Effect.ignore);
            yield* Console.log(
              `[feishu-bot] started turn on thread ${threadId} for chat ${chatId}.`,
            );

            yield* driveTurn(chatId, threadId, observation);
          }).pipe(
            // Per-turn scope: tears down the thread subscription + card update
            // fiber on this turn's exit (inside the lock so teardown completes
            // before the next same-chat turn begins).
            Effect.scoped,
            // Settle on EVERY exit — success, failure, defect, interrupt, offline
            // branch alike — and STILL INSIDE THE LOCK, so the next same-chat turn
            // cannot begin before this turn's running/held accounting is committed.
            // The queue's token guard makes the settle a no-op unless this turn
            // owns the slot, so it releases *exactly* the `running`/`held` it
            // claimed — a flushed turn can never clobber a live turn's slot (the
            // bug). The drained held follow-up is stashed for the chain finalizer
            // below; nothing re-dispatches under the lock (would self-deadlock).
            Effect.onExit(() =>
              turnQueue
                .onTurnComplete(chatId, token)
                .pipe(Effect.flatMap((next) => Ref.set(followUp, next))),
            ),
          );
        }).pipe(
          (body) => withChatTurnLock(chatId, body),
          // Chain on EVERY exit, OUTSIDE the lock (mirrors the original finalizer's
          // every-exit guarantee, but now self-deadlock-free): the held follow-up's
          // `runTurn` re-acquires the same chat lock and `beginTurn`s afresh, so it
          // must run only after this turn released the lock. Its own failure is
          // swallowed so it can never mask this turn's exit.
          //
          // Offline strategy for the chain (LOW message-loss fix). The drained held
          // batch is a set of *new* messages this turn captured while running — it
          // is NOT part of any existing outbound intent's retry. So the chain must
          // re-dispatch it under `offlineBuffer` (independent re-buffer as a *new*
          // intent), NOT the parent `onOffline`. Were it to inherit a flush-path
          // `offlineRetry`, a re-drop here would raise `OfflineRetry` that only the
          // parent intent's outbound entry re-queues — and that entry replays the
          // *original* prompt, never this held batch; meanwhile this chain turn's
          // own settle already cleared `running`, so the held batch would be neither
          // re-buffered nor re-held → silently dropped. `offlineBuffer` instead
          // buffers the held batch as its own outbound intent (with a fresh ⏳),
          // so a re-drop keeps it for the next flush. (The live path already used
          // `offlineBuffer`, so for a live-origin chain this is unchanged.)
          Effect.onExit(() =>
            Ref.get(followUp).pipe(
              Effect.flatMap((next) =>
                next === null
                  ? Effect.void
                  : runTurn(chatId, threadId, next, offlineBuffer).pipe(Effect.ignore),
              ),
            ),
          ),
        );
      });

    /**
     * Resolve the chat's bound thread, creating one on first contact. Serialised
     * under `ensureLock` so two concurrent first messages can't race into two
     * threads (and, while offline, can't enqueue two conflicting `createThread`s).
     *
     * Always returns the chat's threadId. The threadId is *deterministic* from the
     * chatId (`deriveThreadId`) — the same value the persistent binding holds and
     * the same value the turn queue resolves for the stable commandId — so the
     * merged dispatch's commandId is correct whether or not the binding has been
     * persisted yet.
     *
     * Outcomes:
     *  - already bound → the bound `threadId`.
     *  - unbound + ready → online `createThread` + persist → the new `threadId`.
     *    A mid-create environment drop falls back to the offline buffer.
     *  - unbound + offline → ⏳/notice + buffered create intent (binding persisted
     *    on flush success) → the (deterministic) `threadId`. The turn is buffered
     *    separately by `runTurn`'s offline branch.
     */
    const ensureThread = (message: InboundMessage): Effect.Effect<ThreadId> =>
      Effect.gen(function* () {
        const existing = yield* chatThreadMap.get(message.chatId).pipe(
          Effect.map((option) => (Option.isSome(option) ? option.value : null)),
          Effect.orElseSucceed(() => null),
        );
        if (existing !== null) {
          return existing;
        }

        // First contact. Derive the deterministic threadId up front so both the
        // online and offline create paths agree on it (and on the stable create
        // commandId), making re-delivery idempotent against the server.
        const threadId = deriveThreadId(message.chatId);

        // Offline first contact (MEDIUM): visible ⏳ receipt + notice, then buffer
        // the `createThread` as an outbound intent that persists the binding *on
        // success* (not optimistically — see `pendingCreates`). The turn itself is
        // buffered separately by `runTurn`'s offline branch; intents flush in FIFO
        // order, so the create runs before any turn. A second offline message for
        // the same chat must NOT buffer a second create (it would hit the server's
        // "thread already exists" invariant), so we dedup on `pendingCreates`.
        const bufferOfflineCreate = Effect.gen(function* () {
          const firstCreate = yield* Ref.modify(
            pendingCreates,
            (set): readonly [boolean, ReadonlySet<string>] =>
              set.has(message.chatId) ? [false, set] : [true, new Set(set).add(message.chatId)],
          );
          yield* sendNotice(
            message.chatId,
            "⏳ The server is not connected right now — your message is queued and will be sent once it reconnects.",
          );
          if (!firstCreate) {
            // A create for this brand-new chat is already buffered; its flush
            // persists the binding. This message only needs its turn buffered.
            yield* Console.log(
              `[feishu-bot] environment offline; create already buffered for chat ${message.chatId}, queuing turn only (⏳).`,
            );
            return threadId;
          }
          yield* Console.log(
            `[feishu-bot] environment offline on first contact; buffering create+turn for chat ${message.chatId} (⏳).`,
          );
          const createCommandId = deriveCommandId(message.chatId, threadId, message.messageId, 1);
          yield* outbound.enqueue({
            commandId: createCommandId,
            feishuMessageId: message.messageId,
            // Create THEN persist the binding — only a created thread gets a
            // binding, so a crash before the flush leaves no binding pointing at a
            // missing thread. `runOnEnv` orDies an offline re-drop into a defect,
            // which the outbound flush captures as a retry (keeps the intent + ⏳).
            run: runOnEnv(
              createThread({
                commandId: createCommandId,
                threadId,
                projectId: project.projectId,
                title: `Feishu · ${message.senderName ?? message.senderId} (${message.chatId.slice(0, 12)})`,
                modelSelection,
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: null,
                worktreePath: null,
              }),
            ).pipe(
              Effect.andThen(
                chatThreadMap.put(message.chatId, threadId).pipe(
                  Effect.tapError((error) =>
                    Console.error(
                      `[feishu-bot] thread created but binding persist failed for chat ${message.chatId}: ${error.message}`,
                    ),
                  ),
                  Effect.ignore,
                ),
              ),
            ),
          });
          return threadId;
        });

        const ready = yield* isEnvReady;
        if (!ready) {
          return yield* bufferOfflineCreate;
        }

        // Online first contact. Attempt `createThread` + persist now. Capture the
        // exit so a mid-create environment drop (a TOCTOU between `isEnvReady` and
        // the dispatch — `runOnEnv` would orDie it into a defect) falls back to the
        // offline buffer instead of silently dropping the user's first message.
        const ensuredExit = yield* ensureThreadForChat(message.chatId, message, {
          environmentId,
          projectId: project.projectId,
          modelSelection,
          dispatch: runOnEnv,
          generateThreadId: genId(ThreadId),
        }).pipe(Effect.provideService(ChatThreadMapStore, chatThreadMap), Effect.exit);

        if (ensuredExit._tag === "Failure") {
          yield* Effect.logWarning(
            `[feishu-bot] online first-contact create failed for chat ${message.chatId}; falling back to offline buffer.`,
            ensuredExit.cause,
          );
          return yield* bufferOfflineCreate;
        }
        // M9: record the (stable) create commandId locally on a fresh create so a
        // crash-recovery replay short-circuits instead of re-dispatching (the
        // server's commandReceipt store is the authoritative second line). The
        // triple mirrors `ensureThreadForChat`'s internal derivation (part: 1).
        if (ensuredExit.value.created) {
          const createCommandId = deriveCommandId(message.chatId, threadId, message.messageId, 1);
          yield* sent.add(createCommandId).pipe(Effect.ignore);
        }
        return ensuredExit.value.threadId;
      });

    /**
     * Handle one inbound message: filter unsupported content, ensure the chat's
     * thread (binding/buffering on first contact, under `ensureLock`), then offer
     * it to the per-chat queue. An idle offer returns a merged dispatch (after the
     * ~600ms coalescing window) we run as a turn; a held offer (turn already
     * running) returns `null` — the running turn's completion picks it up.
     *
     * Forked one-per-message so concurrent `offer` calls drive the queue's
     * generation-debounce coalescing (rapid messages collapse into one prompt);
     * the only racy step, first-contact create, is serialized by `ensureLock`.
     */
    const handleInbound = (message: InboundMessage): Effect.Effect<void> =>
      Effect.gen(function* () {
        // Content filter (M16): M1 dispatches text only. A message with no text
        // (image/file-only, or an empty body) must NOT become an empty-prompt
        // turn — reply with an explicit "text only" notice and skip dispatch.
        if (message.text.trim().length === 0) {
          const what =
            message.attachments.length > 0
              ? "I can only act on text right now (image/file attachments aren't supported yet)."
              : "I received an empty message — please send some text.";
          yield* sendNotice(message.chatId, what);
          return;
        }

        // Ensure the chat↔thread binding FIRST (serialised) so the queue resolves
        // the real threadId when it merges — the stable commandId triple includes
        // the threadId, so offering before binding would derive the wrong id.
        // Always yields a (deterministic) threadId; a brand-new offline chat gets
        // its create + this turn buffered for the reconnect flush.
        const threadId = yield* ensureThread(message).pipe(ensureLock.withPermits(1));

        // `offer` blocks for the idle coalescing window; concurrent offers for
        // the same chat collapse via the generation-debounce into one dispatch.
        const merged = yield* turnQueue.offer(message.chatId, message);
        if (merged === null) {
          return; // Coalesced into a peer offer, or held during a running turn.
        }
        // Live path: `offlineBuffer` buffers (succeeds) rather than signalling a
        // retry, so `OfflineRetry` is unreachable here — treat it as a defect.
        yield* runTurn(message.chatId, threadId, merged, offlineBuffer).pipe(Effect.orDie);
      });

    // Consumer: fork one handler per message so the queue's idle-window coalesce
    // works (the SDK callback already decoupled intake). Offline first-contact is
    // compensated (⏳ + buffered create/turn intents), so a handler should only
    // ever fail on a genuine defect — logged and isolated to that message's fiber.
    yield* Stream.fromQueue(inbox).pipe(
      Stream.runForEach((message) =>
        Effect.sync(
          () =>
            void runFork(
              handleInbound(message).pipe(
                Effect.catchCause((cause) =>
                  Effect.logError(
                    `[feishu-bot] message handler failed for chat ${message.chatId}.`,
                    cause,
                  ),
                ),
              ),
            ),
        ),
      ),
      Effect.forkScoped,
    );

    // Flush the outbound queue whenever the *t3code environment* (re)connects —
    // intents are buffered when that environment is offline (M8), so its
    // reconnection (not Feishu's) is the correct flush trigger. Edge-triggered:
    // flush only on the transition into `connected`.
    yield* registry.stateChanges(environmentId).pipe(
      Stream.orDie,
      Stream.map((state) => connectionProjectionPhase(state) === "ready"),
      Stream.changes,
      Stream.filter((ready) => ready),
      Stream.runForEach(() =>
        Console.log("[feishu-bot] t3code environment connected; flushing outbound queue.").pipe(
          Effect.andThen(outbound.flush),
        ),
      ),
      Effect.forkScoped,
    );

    // M7 reconnect notice: Feishu has no inbound replay, so after the WebSocket
    // drops and reconnects, any message a user sent during the gap is lost to us.
    // Tell every chat we know about (restored bindings) to resend — a user-visible
    // prompt, not just a console line. Best-effort and bounded: notices are sent
    // serially and individually swallowed (`sendNotice` already logs failures).
    const notifyReconnect: Effect.Effect<void> = Effect.gen(function* () {
      const entries = yield* chatThreadMap.entries.pipe(Effect.orElseSucceed(() => []));
      yield* Console.log(
        `[feishu-bot] feishu websocket reconnected; prompting ${entries.length} known chat(s) to resend.`,
      );
      yield* Effect.forEach(
        entries,
        ([chatId]) =>
          sendNotice(
            chatId,
            "⚠️ I briefly lost connection — any message you sent in the last moment may not have reached me. Please resend it if you didn't get a reply.",
          ),
        { discard: true },
      );
    });

    // Bridge handlers: the SDK edge. All non-blocking — enqueue / fork only.
    const handlers: BridgeHandlers = {
      onInboundMessage: (message) => {
        runFork(Queue.offer(inbox, message));
      },
      onReconnecting: () => {
        runFork(Console.log("[feishu-bot] feishu websocket reconnecting..."));
      },
      onReconnected: () => {
        // Feishu inbound replay is unavailable (M7): the user must resend any
        // messages sent during the gap. We surface that to each known chat (not
        // just the console). (Outbound t3code intents flush on the *t3code*
        // environment's reconnect, watched separately above.)
        runFork(notifyReconnect);
      },
      onError: (error) => {
        runFork(Console.error(`[feishu-bot] feishu channel error (${error.code ?? "?"}).`));
      },
    };

    yield* Console.log("[feishu-bot] connecting to feishu...");
    yield* gateway.connect(handlers).pipe(Effect.orDie);
    yield* Console.log("[feishu-bot] ready — listening for private-chat messages.");

    // `chatThreadMap.entries` is a useful warm-up log of restored bindings.
    const bindings = yield* chatThreadMap.entries.pipe(Effect.orElseSucceed(() => []));
    yield* Console.log(`[feishu-bot] restored ${bindings.length} chat binding(s).`);

    // Resident: keep the scope (connection, subscriptions, fibers) open forever.
    return yield* Effect.never;
  });

/**
 * Top-level program: resolve the environment, build the resident bridge with the
 * connection + persistence + lark + queue layers, and run it forever. The whole
 * flow is wrapped in `Effect.scoped` so the connection (and every forked fiber)
 * tears down cleanly on exit. Auth failures are reported as actionable
 * one-liners before exiting; only genuinely unexpected defects die.
 */
export const program = (
  config: FeishuBotConfig,
): Effect.Effect<void, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const resolved = yield* resolveEnvironment(config);

    // Lark gateway, durable stores, and the two bridge queues are provided here.
    // `turnQueueLayer` needs a `threadIdFor` lookup; bind it to the persistent
    // chat→thread map (the chat is always bound before the queue dispatches).
    const baseLayer = Layer.mergeAll(
      connectionLayer({ target: resolved.target, accessToken: resolved.accessToken }),
      fileStoresLayer({ stateDir: config.stateDir }),
      larkGatewayLayer(config.feishu),
    );

    const queuesLayer = Layer.merge(
      outboundQueueLayer,
      // The queue needs the bound threadId to derive a merged dispatch's stable
      // commandId. That threadId is *deterministic* from the chatId
      // (`deriveThreadId`) — the same value the persistent binding holds — so the
      // queue resolves it purely, with no store dependency and, crucially, with no
      // dependence on whether the binding has been persisted yet (a brand-new chat
      // buffered while offline still gets the correct commandId).
      turnQueueLayer((chatId) => Effect.sync(() => deriveThreadId(chatId))),
    ).pipe(Layer.provideMerge(baseLayer));

    return yield* runBridge(config, resolved).pipe(Effect.provide(queuesLayer), Effect.scoped);
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

/**
 * Translate the typed `resolveEnvironment` failures into an actionable,
 * single-line diagnostic and exit cleanly. Mirrors M0's reporter.
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
