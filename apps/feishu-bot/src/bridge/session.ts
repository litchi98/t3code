/**
 * Per-thread event observer (M1).
 *
 * Subscribes to a thread (`subscribeThread`), folds every snapshot/event into a
 * local {@link OrchestrationThread} via `applyThreadDetailEvent` (NEVER hand-
 * assembling assistant text), and exposes:
 *   - a stream of render ticks (the latest folded thread state; the card SDK
 *     throttles the actual card updates downstream), and
 *   - a completion signal derived from the session latch (saw `running` /
 *     `activeTurnId` set, then `activeTurnId → null` = success; status in
 *     {error,interrupted,stopped} = failure) — the same semantics M0's `bot.ts`
 *     used, lifted here into a reusable observer.
 *
 * The reducer (`applyThreadDetailEvent`) and `OrchestrationThread` come from
 * client-runtime / contracts via subpaths; this module never re-derives state.
 *
 * Decoupling: like `chatThreadMap`, the observer takes a `subscribe` thunk
 * (Integrate binds it to `EnvironmentRegistry.followStream(environmentId, …)`)
 * so it stays independent of the registry's service shape.
 */
import type {
  OrchestrationSession,
  OrchestrationThread,
  OrchestrationThreadStreamItem,
  ThreadId,
} from "@t3tools/contracts";
import { applyThreadDetailEvent } from "@t3tools/client-runtime/state/threads";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import type { TurnOutcome } from "./types.ts";

/**
 * Upper bound on how long we wait for a single turn to reach a terminal state.
 * A provider that wedges (or a missed terminal event) must not pin the chat's
 * queue forever; on timeout the observer reports a synthetic failure so the
 * bridge can flush the queue and recover. Mirrors M0's `TURN_TIMEOUT`.
 */
const TURN_TIMEOUT = Duration.minutes(10);

/**
 * Live observation of a single thread's turn.
 *
 * `ticks` emits the current folded {@link OrchestrationThread} each time a
 * relevant event lands; the bridge renders the latest and pushes it to the
 * streaming card. `completion` resolves once the active turn reaches a terminal
 * state ({@link TurnOutcome}), which flips the streaming card to its final
 * render and triggers the queue flush.
 */
export interface ThreadObservation {
  /** Latest folded thread state, one element per relevant update. */
  readonly ticks: Stream.Stream<OrchestrationThread>;
  /** Resolves with the turn's terminal outcome. */
  readonly completion: Effect.Effect<TurnOutcome>;
  /**
   * The current folded thread state (authoritative; read from the fold's own
   * ref, not the tick queue). Used for the final card render after `completion`
   * resolves, since the tick stream is shut down by then and may race the last
   * tick. `null` only before the first snapshot lands.
   */
  readonly current: Effect.Effect<OrchestrationThread | null>;
}

/** Dependencies an observation needs, injected by Integrate. */
export interface ObserveThreadDeps {
  /**
   * Open the live `subscribeThread` stream for `threadId`. Integrate binds this
   * to `EnvironmentRegistry.followStream(environmentId, subscribe(...))`, which
   * replays a full snapshot first and never fails (already `Stream.orDie`d).
   */
  readonly subscribe: (threadId: ThreadId) => Stream.Stream<OrchestrationThreadStreamItem>;
}

// NOTE (M1 scope): dispatch-now vs. enqueue is decided by `turnQueue`'s own
// "is a bridge turn already running for this chat?" flag — M1 only serialises
// the bridge's *own* turns. Reconciling against the *session's* observed running
// state (to detect a turn another client/end started concurrently) is a
// cross-end concern deferred to M2; until then there is no consumer for a
// `session.status === "running" && activeTurnId !== null` predicate here, so it
// is intentionally absent rather than left as dead code.

/**
 * Failure terminals for a session: a turn that ends in `error`, is
 * `interrupted`, or whose session is `stopped`. These should not be observed
 * before a turn has started under normal operation, so they double as a
 * completion signal even if the running phase was somehow missed. Mirrors M0.
 */
const isFailureStatus = (status: OrchestrationSession["status"]): boolean =>
  status === "error" || status === "interrupted" || status === "stopped";

/**
 * Begin observing `threadId`. Folds the subscription into a `Ref` and pushes
 * each folded state to a render-tick queue; resolves `completion` via the
 * session latch (saw active turn → `activeTurnId` cleared = success; failure
 * terminal = failure) or via a `thread.deleted` event (a hard terminal raised by
 * the reducer when another end deletes the thread). Returns the
 * {@link ThreadObservation} the bridge drives.
 *
 * The fold loop is forked into the caller's scope, so it is interrupted when the
 * surrounding turn scope closes. The tick queue is sliding(1): only the latest
 * thread state matters (the renderer is idempotent over state), so a slow card
 * consumer drops intermediate frames rather than building backpressure.
 */
export const observeThread = (
  threadId: ThreadId,
  deps: ObserveThreadDeps,
): Effect.Effect<ThreadObservation, never, Scope.Scope> =>
  Effect.gen(function* () {
    // Latest folded thread state. `applyThreadDetailEvent` needs a prior thread,
    // which the snapshot frame (always emitted first) seeds.
    const threadRef = yield* Ref.make<OrchestrationThread | null>(null);
    // Drop stale events that arrive ordered behind a fresher snapshot (a mid-
    // turn reconnect replays a new snapshot); mirrors client-runtime's fold.
    const lastSequence = yield* Ref.make<number>(-1);
    // Latch: only treat `activeTurnId === null` as completion once we've seen
    // the turn actually running (the initial snapshot is already terminal-ish).
    const turnObserved = yield* Ref.make(false);

    // sliding(1): the renderer only cares about the newest state; coalesce.
    const ticks = yield* Queue.sliding<OrchestrationThread>(1);
    const done = yield* Deferred.make<TurnOutcome>();

    const observeSession = (session: OrchestrationSession) =>
      Effect.gen(function* () {
        if (session.activeTurnId !== null) {
          yield* Ref.set(turnObserved, true);
          return;
        }
        // activeTurnId === null: a terminal-ish state. Only treat it as *this
        // turn's* completion once we've actually seen a turn running. This is
        // essential for reused threads (M1): the initial snapshot of a returning
        // chat can already carry a prior turn's terminal status (`ready`/`error`)
        // — without the latch we'd false-complete before our turn even starts.
        const seen = yield* Ref.get(turnObserved);
        if (!seen) {
          return;
        }
        if (isFailureStatus(session.status)) {
          yield* Deferred.succeed(done, {
            kind: "failed",
            status: session.status,
            lastError: session.lastError,
          } satisfies TurnOutcome);
          return;
        }
        // status ∈ {idle, ready}: a clean terminal after the turn ran = success.
        // (`starting`/`running` with a null activeTurnId is a transient we skip.)
        if (session.status === "starting" || session.status === "running") {
          return;
        }
        yield* Deferred.succeed(done, { kind: "succeeded" } satisfies TurnOutcome);
      });

    const applyItem = (item: OrchestrationThreadStreamItem) =>
      Effect.gen(function* () {
        if (item.kind === "snapshot") {
          yield* Ref.set(lastSequence, item.snapshot.snapshotSequence);
          yield* Ref.set(threadRef, item.snapshot.thread);
          yield* Queue.offer(ticks, item.snapshot.thread);
          if (item.snapshot.thread.session !== null) {
            yield* observeSession(item.snapshot.thread.session);
          }
          return;
        }
        const seq = yield* Ref.get(lastSequence);
        if (item.event.sequence <= seq) {
          return;
        }
        yield* Ref.set(lastSequence, item.event.sequence);
        const current = yield* Ref.get(threadRef);
        if (current === null) {
          // No snapshot yet — cannot fold an event without a base thread.
          return;
        }
        const result = applyThreadDetailEvent(current, item.event);
        if (result.kind === "updated") {
          yield* Ref.set(threadRef, result.thread);
          yield* Queue.offer(ticks, result.thread);
        } else if (result.kind === "deleted") {
          // Another client/end deleted this thread mid-observation (the reducer's
          // `thread.deleted` terminal). The subscription is now dangling — there
          // is no turn left to complete — so terminate `completion` immediately
          // with a hard, *distinguishable* terminal: a failure-shaped outcome
          // whose `status: "thread-deleted"` lets the bridge tell a deletion apart
          // from an ordinary turn failure. That stops the streaming card, renders
          // its final form, and (critically) flushes the chat's queue instead of
          // pinning it until the TURN_TIMEOUT fires, and gives the caller the
          // signal it needs to invalidate the stale `chatId → threadId` binding /
          // notify the user. `Deferred.succeed` is idempotent, so a deletion
          // racing a normal terminal is harmless; the fold loop's surrounding
          // scope tears the subscription down once the turn scope closes.
          //
          // NOTE: the richer reuse path (subscribing to client-runtime's
          // `threadStateChanges` / `makeEnvironmentThreadState`, which fold the
          // *same* reducer behind a `SubscriptionRef` and already surface deletion
          // as `status: "deleted"`) is intentionally not taken here: that API is
          // parameterised by `EnvironmentRegistry` + `EnvironmentCacheStore`
          // context, not by the injected `subscribe` thunk this observer is built
          // around, so adopting it would change `observeThread`'s signature and
          // its `bot.ts` call site. Handling `deleted` inline reuses the reducer's
          // own classification without re-deriving any state.
          yield* Deferred.succeed(done, {
            kind: "failed",
            status: "thread-deleted",
            lastError: "The thread was deleted from another client.",
          } satisfies TurnOutcome);
          return;
        }
        // `thread.session-set` carries the session directly; observe it for the
        // latch (the folded thread also has it, but reading the event payload is
        // the authoritative, immediate signal M0 latched on).
        if (item.event.type === "thread.session-set") {
          yield* observeSession(item.event.payload.session);
        }
      });

    // Fold the subscription in a scoped fiber. The stream replays a full
    // snapshot first; folding starts before the bridge dispatches the turn, so
    // no turn event is missed (the spec's ordering rule).
    yield* deps.subscribe(threadId).pipe(Stream.runForEach(applyItem), Effect.forkScoped);

    // Bound the wait so a wedged provider can't pin the chat queue forever.
    const completion = Deferred.await(done).pipe(
      Effect.timeoutOrElse({
        duration: TURN_TIMEOUT,
        orElse: (): Effect.Effect<TurnOutcome> =>
          Effect.succeed({
            kind: "failed",
            status: "timeout",
            lastError: `Turn did not complete within ${Duration.format(TURN_TIMEOUT)}.`,
          }),
      }),
      // Stop pushing render ticks once the turn is terminal.
      Effect.ensuring(Queue.shutdown(ticks)),
    );

    return {
      ticks: Stream.fromQueue(ticks),
      completion,
      current: Ref.get(threadRef),
    } satisfies ThreadObservation;
  });
