/**
 * Turn-runner lifecycle extracted from bot.ts.
 *
 * Owns the per-chat turn lock, the live card/observer drive, and the offline
 * buffering strategy while preserving the original closure bodies. `runTurn` and
 * `offlineBuffer` are mutually recursive (the chain re-buffers a held batch), so
 * they must live in one module — the original front-referencing order is kept.
 */
import { startThreadTurn } from "@t3tools/client-runtime/operations";
import type { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import {
  type EnvironmentId,
  MessageId,
  type ModelSelection,
  type OrchestrationThread,
  type OrchestrationThreadStreamItem,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import type * as Stream from "effect/Stream";

import type { LarkGateway, StreamingCard } from "../lark/index.ts";
import type { SentCommandStore } from "../runtime/persistence.ts";
import { runtimeModeForChatType, splitChatKey } from "./chatThreadMap.ts";
import { OfflineRetry, turnRejectedNoticeText } from "./createIntent.ts";
import { type RenderDensity, renderThreadCard } from "./eventRenderer.ts";
import { topicSendOpts } from "./notices.ts";
import type { OutboundQueue } from "./outbound.ts";
import { observeThread, type ThreadObservation } from "./session.ts";
import type { MergedDispatch, TurnQueue } from "./turnQueue.ts";

/**
 * What to do when a turn dispatch finds the environment offline. Two callers:
 *  - **live** (`offlineBuffer`): give a ⏳ receipt and buffer a *flush* turn so
 *    the reconnect re-runs the full pipeline. Succeeds (the live message is now
 *    safely queued; the running flag is released by the completion path).
 *  - **flush** (`offlineRetry`): the environment dropped *again* mid-flush —
 *    **fail** with `OfflineRetry` so the outbound queue keeps the intent + its
 *    ⏳ and retries on the next flush (never records it as sent, never drops).
 */
export type OfflineStrategy = (params: {
  readonly chatId: string;
  readonly dispatch: MergedDispatch;
  readonly feishuMessageId: string;
}) => Effect.Effect<void, OfflineRetry>;

/** Dependencies for one bound session's turn runner. */
export interface TurnRunnerDeps {
  /** Bare environment registry for the offline-typed dispatch (see §5.14). */
  readonly registry: EnvironmentRegistry["Service"];
  /** The bound session's environment id. */
  readonly environmentId: EnvironmentId;
  /** Platform crypto, provided to the bare `registry.run` dispatch. */
  readonly crypto: Crypto.Crypto;
  /** Per-chat turn queue: begin/settle accounting for the running slot. */
  readonly turnQueue: TurnQueue["Service"];
  /** Local idempotency ledger of dispatched command ids. */
  readonly sent: SentCommandStore["Service"];
  /** Outbound intent queue for offline buffering. */
  readonly outbound: OutboundQueue["Service"];
  /** Connected Feishu gateway for streaming-card creation. */
  readonly gateway: LarkGateway["Service"];
  /** Preempt any resident observe fiber before this end drives its own turn. */
  readonly stopObserve: (chatId: string) => Effect.Effect<void>;
  /** Shared per-tick + terminal card render pipeline (observeMirror handle). */
  readonly renderObservationToCard: (
    chatId: string,
    threadId: ThreadId,
    observation: ThreadObservation,
    handle: StreamingCard,
    operatorOverride?: string,
  ) => Effect.Effect<void, never, Scope.Scope>;
  /** Resolve the effective card density for a live thread. */
  readonly resolveDensity: (
    chatKey: string,
    runtimeMode: RuntimeMode,
  ) => Effect.Effect<RenderDensity>;
  /** Send a static notice card to a conversation. */
  readonly sendNotice: (
    chatKey: string,
    text: string,
    replyToMessageId?: string,
  ) => Effect.Effect<void>;
  /** Subscribe to a thread's replaying detail stream. */
  readonly subscribeThread: (threadId: ThreadId) => Stream.Stream<OrchestrationThreadStreamItem>;
  /** Schema-valid seed thread for initial streaming-card frames. */
  readonly placeholderThread: OrchestrationThread;
  /** Generate a branded id (Crypto already discharged). */
  readonly genId: <A>(brand: { readonly make: (value: string) => A }) => Effect.Effect<A>;
  /** The resolved `T3_MODEL` override for this session, or `null`. */
  readonly perTurnModelSelection: ModelSelection | null;
  /**
   * Assembly-owned trusted per-thread Feishu-initiator map (`threadId` →
   * operator open_id). `driveTurn` records this Feishu turn's initiator here so a
   * later observe fiber for the SAME thread signs approval cards for the real
   * initiator, never a driftable last-sender ref (pin-drift fix). Written only by
   * turn-establishing Feishu actions (`driveTurn` / `/resume` / M18).
   */
  readonly feishuInitiators: Ref.Ref<ReadonlyMap<ThreadId, string>>;
}

/** Handle returned by {@link makeTurnRunner}. */
export interface TurnRunnerHandle {
  readonly runTurn: (
    chatId: string,
    dispatch: MergedDispatch,
    onOffline: OfflineStrategy,
  ) => Effect.Effect<void, OfflineRetry>;
  readonly offlineBuffer: OfflineStrategy;
}

/** Construct the turn runner for one bound Feishu session. */
export const makeTurnRunner = (deps: TurnRunnerDeps): Effect.Effect<TurnRunnerHandle> =>
  Effect.gen(function* () {
    const {
      registry,
      environmentId,
      crypto,
      turnQueue,
      sent,
      outbound,
      gateway,
      stopObserve,
      renderObservationToCard,
      resolveDensity,
      sendNotice,
      subscribeThread,
      placeholderThread,
      genId,
      perTurnModelSelection,
      feishuInitiators,
    } = deps;

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
            // M3a: per-turn runtimeMode tracks the chat type of the message(s) that
            // drove this turn — p2p stays `full-access`, group/topic is
            // `approval-required`. A dispatched batch always carries ≥1 source
            // message; the `?? "p2p"` keeps the legacy `full-access` default in the
            // (unreachable) empty case so existing p2p behaviour is byte-identical.
            //
            // NOTE: for an *already-existing* thread this field is INERT — the
            // server pins `runtimeMode` at thread-creation time and `turn.start`
            // resolves the active mode from `targetThread.runtimeMode`
            // (decider.ts), IGNORING this command value. It is carried only because
            // `ThreadTurnStart` requires it; it does NOT re-assert per-turn policy.
            // (The group/topic safety gate that matters lives at thread creation +
            // the `/resume` full-access gate, not here.)
            runtimeMode: runtimeModeForChatType(dispatch.sources[0]?.message.chatType ?? "p2p"),
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
      // M3a: composite `chatId[:larkThreadId]` key. The render loop keys state by
      // it (via `renderObservationToCard`); the card is opened on the real Feishu
      // chatId, and — for a topic, with the triggering message as the in-thread
      // reply anchor — posted *inside* that topic.
      chatId: string,
      threadId: ThreadId,
      observation: ThreadObservation,
      // M-3 p2p-density: the REAL runtime mode for THIS turn, derived from the
      // triggering message's chat type (`runtimeModeForChatType`). The placeholder
      // first frame resolves its density through `resolveDensity(chatId, this)` —
      // NOT the synthetic `placeholderThread.runtimeMode` (hard-coded
      // `approval-required`), which would render a p2p turn's first frame at the
      // group density and flicker to the configured `p2pDensity` on the real frame.
      turnRuntimeMode: RuntimeMode,
      // The Feishu message id that triggered this turn (the topic reply anchor),
      // or `undefined` (flush/replay with no live trigger) → post at the root.
      replyToMessageId?: string,
      // Fix 1(a) (M3a): the open id of *this turn's initiator* (the sender of the
      // turn's first source message), pinned for the whole turn. Forwarded as the
      // `operatorOverride` to `renderObservationToCard` so every live tick signs
      // the approval/user-input buttons (and persists the handle) for the
      // initiator — NOT for whoever last @-mentioned the bot mid-turn (a group
      // hazard: a later `@bot` would otherwise re-sign the buttons to a bystander
      // who could then approve, and lock the real initiator out). `undefined`
      // (unreachable empty dispatch) signs `payload.o` empty → owner-only in
      // `initiator` mode; there is no last-sender ref to fall back to.
      initiatorOperatorOpenId?: string,
    ): Effect.Effect<void, never, Scope.Scope> =>
      Effect.gen(function* () {
        // Record this Feishu-initiated turn's initiator into the trusted map, so a
        // later observe fiber for the SAME thread (a chained subagent, or a follow-on
        // turn) signs the approval card's `payload.o` for the REAL initiator rather
        // than a driftable last-sender ref. driveTurn itself pins the initiator
        // directly; this write is for the observe/surface paths that mirror the thread
        // afterwards. Only a non-empty initiator carries authority.
        if (initiatorOperatorOpenId !== undefined && initiatorOperatorOpenId.length > 0) {
          yield* Ref.update(feishuInitiators, (map) =>
            new Map(map).set(threadId, initiatorOperatorOpenId),
          );
        }
        const cardDone = yield* Deferred.make<void>();
        yield* Effect.gen(function* () {
          // M-3 PR-C3 / p2p-density: resolve the placeholder first-frame density
          // through the SAME overlay the real frames use, keyed on the turn's REAL
          // runtime mode (`turnRuntimeMode`) — never the synthetic placeholder mode —
          // so neither a group per-chat override nor a lowered p2p `p2pDensity` jumps
          // between the first frame and the real one.
          const placeholderDensity = yield* resolveDensity(chatId, turnRuntimeMode);
          const initial = renderThreadCard(placeholderThread, {
            streaming: true,
            density: placeholderDensity,
          }).card;

          // M3a: real Feishu chatId + (topic-only) in-thread reply opts. driveTurn
          // anchors to THIS turn's triggering message (`replyToMessageId`) — its
          // freshest in-topic message — not the binding anchor (red line: unchanged).
          const { chatId: realChatId, larkThreadId } = splitChatKey(chatId);
          const sendOpts = topicSendOpts(larkThreadId, replyToMessageId);
          const card = yield* gateway
            .startStreamingCard(realChatId, initial, { done: Deferred.await(cardDone) }, sendOpts)
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
            // The whole render loop (per-tick + terminal render + handle persistence)
            // is the shared `renderObservationToCard` helper (M2b-3 DRY): identical
            // behaviour to the prior inline body. Fix 1(a): pin this turn's initiator
            // as the operator override so the live card's buttons stay signed for the
            // initiator across the whole turn.
            yield* renderObservationToCard(
              chatId,
              threadId,
              observation,
              handle,
              initiatorOperatorOpenId,
            );
          } else {
            // No card handle: still wait for the turn to settle (so the SDK
            // producer / completion path resolves identically).
            const outcome = yield* observation.completion;
            yield* Console.log(
              `[feishu-bot] turn ${outcome.kind} on thread ${threadId}` +
                (outcome.kind === "failed" ? ` (status=${outcome.status}).` : "."),
            );
          }
        }).pipe(
          // Whatever happens, release the SDK producer so the card settles into
          // its terminal (non-streaming) form instead of parking forever.
          Effect.ensuring(Deferred.succeed(cardDone, undefined)),
        );
      });

    const offlineRetry: OfflineStrategy = () => Effect.fail(new OfflineRetry());

    const offlineBuffer: OfflineStrategy = ({ chatId, dispatch, feishuMessageId }) =>
      Effect.gen(function* () {
        yield* Console.log(
          `[feishu-bot] environment offline; queued turn for chat ${chatId} (⏳).`,
        );
        // Buffer the full turn: on reconnect the flush re-runs `runTurn` with the
        // `offlineRetry` strategy, so a mid-flush re-drop fails the intent (keeping
        // it + its ⏳) rather than self-enqueuing under the `offlineBuffer` path.
        // The turn target rides in `dispatch.resolvedThreadId` (B1).
        yield* outbound.enqueue({
          commandId: dispatch.commandId,
          feishuMessageId,
          run: runTurn(chatId, dispatch, offlineRetry),
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
      dispatch: MergedDispatch,
      onOffline: OfflineStrategy,
    ): Effect.Effect<void, OfflineRetry> =>
      Effect.gen(function* () {
        // Single source of truth for *this* turn's target (B1 re-bind TOCTOU fix).
        // The dispatch carries the threadId resolved at the same instant its
        // commandId was derived (`turnQueue` → `mergeMessages`); we dispatch and
        // observe against *that* exact value. `runTurn` deliberately takes NO
        // separate threadId argument — the caller (`handleInbound`) used to pass a
        // threadId captured back at `ensureThread`, which a concurrent `/resume`
        // re-bind could have made stale, leaving the commandId's embedded threadId
        // and the turn's real target pointing at different threads. By driving
        // both from the dispatch's own resolution, they are one and the same by
        // construction and cannot drift. With no concurrent re-bind this equals
        // the thread `ensureThread` ensured exists.
        const target = dispatch.resolvedThreadId;

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

          // M2b-3: driveTurn > observe. The bridge is now driving its OWN turn for
          // this chat, so it must be the single render source — preempt any resident
          // cross-end observe fiber (a takeover mirror) before `driveTurn` opens its
          // card, or two streaming cards would fight over the same chat. Interrupting
          // the observe closes its child scope (unsubscribes the thread); idempotent
          // no-op when nothing is observing. `ensureObserving`'s `isChatBusy` gate
          // then keeps observe from restarting while this turn owns the running slot.
          yield* stopObserve(chatId);

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

            // Subscribe BEFORE dispatching (M0-verified ordering trap). Observe
            // the dispatch's own resolved target so card/observer follow exactly
            // what the commandId encodes (B1).
            const observation = yield* observeThread(target, { subscribe: subscribeThread });

            const turnStart = yield* buildTurnStart(target, dispatch);

            // Attempt the dispatch. If the environment is unavailable / not yet
            // connected (M8), hand off to `onOffline` (buffer live / retry on
            // flush) instead of dropping; the re-dispatch is idempotent under the
            // stable commandId. Skip the live card here — there is no live turn to
            // stream yet.
            const triggerMessageId = dispatch.sources[0]?.message.messageId ?? dispatch.commandId;
            const dispatched = yield* registry.run(environmentId, turnStart).pipe(
              Effect.provideService(Crypto.Crypto, crypto),
              Effect.as("dispatched" as const),
              Effect.catchTags({
                EnvironmentRpcUnavailableError: () => Effect.succeed("offline" as const),
                EnvironmentNotRegisteredError: () => Effect.succeed("offline" as const),
              }),
              // Review fix A③ / turn-intent backstop: any OTHER failure is the
              // server actively rejecting this dispatch (thread missing after a
              // dropped create, previously-rejected receipt, validation). It
              // used to `orDie` — which silently LOST the message on the live
              // path and carried the intent over FOREVER on the flush path
              // (dispatchOne retries every failure). A rejection is terminal
              // for this exact commandId: settle the intent (success → queue
              // consumes it, ⏳ cleared) and tell the user visibly instead.
              Effect.catchCause((cause) =>
                Effect.logWarning(
                  `[feishu-bot] turn dispatch rejected by the server for chat ${chatId}; dropping with a visible notice.`,
                  cause,
                ).pipe(Effect.as("rejected" as const)),
              ),
            );
            if (dispatched === "offline") {
              yield* onOffline({ chatId, dispatch, feishuMessageId: triggerMessageId });
              return;
            }
            if (dispatched === "rejected") {
              yield* sendNotice(
                chatId,
                turnRejectedNoticeText,
                dispatch.sources[0]?.message.messageId,
              );
              return;
            }
            // Record the dispatch as sent (M9) so a later replay/flush short-circuits.
            yield* sent.add(dispatch.commandId).pipe(Effect.ignore);
            yield* Console.log(`[feishu-bot] started turn on thread ${target} for chat ${chatId}.`);

            // M3a: pass the *real* triggering Feishu message id (not the commandId
            // fallback `triggerMessageId` uses for the offline receipt) as the topic
            // reply anchor — `topicSendOpts` only emits in-thread send opts when this
            // is a genuine message id, so a flush/replay with no live source posts at
            // the root instead of replying to a non-message id.
            //
            // Fix 1(a): also pin this turn's *initiator* (the sender of the first
            // source message) as the live card's operator override, so the approval
            // buttons stay signed for the initiator for the turn's whole lifetime
            // (and not for a later mid-turn `@bot` from a bystander).
            yield* driveTurn(
              chatId,
              target,
              observation,
              // M-3 p2p-density: the turn's REAL runtime mode (p2p ⇒ full-access),
              // from the triggering message's chat type — the SAME derivation
              // `buildTurnStart` uses for the command — so the placeholder first
              // frame renders at the p2p `p2pDensity` (no card→low-noise flicker).
              runtimeModeForChatType(dispatch.sources[0]?.message.chatType ?? "p2p"),
              dispatch.sources[0]?.message.messageId,
              dispatch.sources[0]?.message.senderId,
            );
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
                  : // The follow-up carries its own freshly-resolved threadId (from
                    // `onTurnComplete`'s merge); `runTurn` dispatches against that (B1).
                    runTurn(chatId, next, offlineBuffer).pipe(Effect.ignore),
              ),
            ),
          ),
        );
      });

    return { runTurn, offlineBuffer } as const;
  });
