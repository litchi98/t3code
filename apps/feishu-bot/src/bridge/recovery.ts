/**
 * Restart recovery + reconnect notice extracted from bot.ts.
 *
 * Two independent factories:
 *  - {@link makeNotifyReconnect} builds the M7 "resend after a gap" prompt
 *    (Feishu has no inbound replay), deduped per Feishu chat (M3a Fix 4);
 *  - {@link makeM18Recovery} builds `recoverPendingApprovalCards`, the M2b-2
 *    restart pass that re-renders outstanding approval cards with freshly-signed
 *    buttons and seeds each chat's dedup baseline (`CardHandle.pendingRequestId`
 *    + `feishuInitiators` + an early `ensureObserving`) so the shellWatcher's first
 *    frame cannot race it into a duplicate card.
 *
 * §5.4 red line: the assembly runs `gateway.connect` →
 * `recoverPendingApprovalCards(...)` → `shellWatcher.start` in that order; the
 * "#4 recovery seeds the dedup baseline before the watcher starts" comment lives
 * at the assembly site (kept beside `shellWatcher.start`), and the operator
 * fallback chain (§5.2) is signed via the injected `buildInteraction` (this
 * module does NOT hold `auth`).
 */
import {
  derivePendingApprovals,
  derivePendingUserInputs,
} from "@t3tools/client-runtime/state/thread-activity";
import {
  type FeishuChatConfig,
  type OrchestrationThread,
  type OrchestrationThreadStreamItem,
  type RuntimeMode,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import type { LarkGateway } from "../lark/index.ts";
import type { CardHandleStore } from "../runtime/persistence.ts";
import type { ChatBinding } from "./bindingState.ts";
import { effectiveChatConfig } from "./chatConfig.ts";
import { splitChatKey } from "./chatThreadMap.ts";
import { type RenderDensity, renderThreadCard } from "./eventRenderer.ts";
import type { ShellSnapshotCache } from "./shellCache.ts";
import type { BindingState } from "./bindingState.ts";

/** Dependencies for the M7 reconnect-resend prompt. */
export interface NotifyReconnectDeps {
  /** Mutable chat-to-thread binding state (in-memory authority). */
  readonly bindings: BindingState["Service"];
  /** Send a static notice card to a conversation. */
  readonly sendNotice: (
    chatKey: string,
    text: string,
    replyToMessageId?: string,
  ) => Effect.Effect<void>;
}

/**
 * Build the M7 reconnect notice effect: prompt every known Feishu chat (deduped
 * per real chatId, M3a Fix 4) to resend any message lost during the WebSocket
 * gap. Returned as a value (not a factory-of-functions) — the SDK
 * `onReconnected` callback forks it directly.
 */
export const makeNotifyReconnect = (deps: NotifyReconnectDeps): Effect.Effect<void> => {
  const { bindings, sendNotice } = deps;

  // M7 reconnect notice: Feishu has no inbound replay, so after the WebSocket
  // drops and reconnects, any message a user sent during the gap is lost to us.
  // Tell every chat we know about (restored bindings) to resend — a user-visible
  // prompt, not just a console line. Best-effort and bounded: notices are sent
  // serially and individually swallowed (`sendNotice` already logs failures).
  return Effect.gen(function* () {
    const entries = yield* bindings.entries;
    // Fix 4 (M3a): a group with K topic bindings yields K composite keys that all
    // split to the SAME Feishu chatId — sending one notice per binding would spam
    // the group root with K identical reconnect prompts. Dedup on the real chatId
    // (`splitChatKey`) so each Feishu chat is prompted exactly once. A bare chatId
    // (p2p / plain group) splits to itself, so this collapses to the pre-Fix-4
    // one-notice-per-chat behaviour.
    const roots = Array.from(new Set(entries.map(([chatKey]) => splitChatKey(chatKey).chatId)));
    yield* Console.log(
      `[feishu-bot] feishu websocket reconnected; prompting ${roots.length} known chat(s) to resend.`,
    );
    yield* Effect.forEach(
      roots,
      (chatId) =>
        sendNotice(
          chatId,
          "⚠️ I briefly lost connection — any message you sent in the last moment may not have reached me. Please resend it if you didn't get a reply.",
        ),
      { discard: true },
    );
  });
};

/** Dependencies for the M18 restart-recovery pass. */
export interface M18RecoveryDeps {
  /** Durable latest-card handles used for dedup and recovery. */
  readonly cardHandles: CardHandleStore["Service"];
  /** Resident shell snapshot cache (recovery-side runtimeMode read). */
  readonly shellCache: ShellSnapshotCache;
  /** Connected Feishu gateway for card updates. */
  readonly gateway: LarkGateway["Service"];
  /**
   * Live binding owner open id (`null` when unbound). §5.6: read at call time,
   * never cache a snapshot.
   */
  readonly ownerRef: Ref.Ref<string | null>;
  /**
   * Live per-chat approval config keyed by bare chatId. §5.6: read at call
   * time, never cache a snapshot.
   */
  readonly chatConfigsRef: Ref.Ref<{ readonly [chatId: string]: FeishuChatConfig }>;
  /**
   * Live per-chat config defaults. §5.6: read at call time, never cache a
   * snapshot.
   */
  readonly chatDefaultsRef: Ref.Ref<FeishuChatConfig>;
  /**
   * Assembly-owned trusted per-thread Feishu-initiator map (`threadId` →
   * operator open_id); this pass SEEDS it post-restart from the durable handle's
   * recovered operator so the observe/surface paths sign approval cards for the
   * recovered initiator across the restart (pin-drift fix). Written only by
   * turn-establishing Feishu actions (`driveTurn` / `/resume` / M18).
   */
  readonly feishuInitiators: Ref.Ref<ReadonlyMap<ThreadId, string>>;
  /** Build signed approval and user-input controls for a thread. */
  readonly buildInteraction: (
    chatKey: string,
    thread: OrchestrationThread,
    operatorOverride?: string,
  ) => Effect.Effect<{ readonly elements: ReadonlyArray<object> } | undefined>;
  /** Resolve the effective card density for a live thread. */
  readonly resolveDensity: (
    chatKey: string,
    runtimeMode: RuntimeMode,
  ) => Effect.Effect<RenderDensity>;
  /** Adopt a still-running recovered turn into the observe registry. */
  readonly ensureObserving: (
    chatId: string,
    threadId: ThreadId,
    activeTurnId: TurnId | null,
  ) => Effect.Effect<void>;
  /** Subscribe to a thread's replaying detail stream. */
  readonly subscribeThread: (threadId: ThreadId) => Stream.Stream<OrchestrationThreadStreamItem>;
  /** Send a static notice card to a conversation. */
  readonly sendNotice: (
    chatKey: string,
    text: string,
    replyToMessageId?: string,
  ) => Effect.Effect<void>;
}

/** Handle returned by {@link makeM18Recovery}. */
export interface M18RecoveryHandle {
  readonly recoverPendingApprovalCards: (
    restored: ReadonlyArray<readonly [string, ChatBinding]>,
  ) => Effect.Effect<void>;
}

/** Construct the M18 restart-recovery pass for one bound Feishu session. */
export const makeM18Recovery = (deps: M18RecoveryDeps): M18RecoveryHandle => {
  const {
    cardHandles,
    shellCache,
    gateway,
    ownerRef,
    chatConfigsRef,
    chatDefaultsRef,
    feishuInitiators,
    buildInteraction,
    resolveDensity,
    ensureObserving,
    subscribeThread,
    sendNotice,
  } = deps;

  // ── M2b-2: restart recovery of outstanding approval cards ────────────────
  //
  // After a bot restart the durable `CardHandleStore` may still hold a card
  // whose `pendingRequestId` was awaiting an operator decision. Feishu has no
  // inbound replay, so unless we re-render that card its buttons carry tokens
  // signed with the OLD app-secret-derived key context and the operator has no
  // fresh card to act on. For each restored binding we read its card handle and,
  // when it has a `pendingRequestId`, take a one-shot thread snapshot (the same
  // `Stream.take(1)` + `Effect.scoped` pattern the cardAction handler uses),
  // re-derive the pending approvals, and:
  //   - still pending  → re-render the approval card (`renderThreadCard` +
  //     `buildInteraction`, freshly-signed buttons) onto the same `messageId`;
  //   - no longer pending → drop the stale handle so we don't try again.
  //
  // ROBUSTNESS: the WHOLE block is wrapped in `Effect.catchCause` (warning only).
  // Recovery is strictly best-effort — a snapshot/render/update failure for one
  // chat must NEVER interrupt startup (the bot must come up and serve live
  // traffic regardless). Per-chat work is additionally isolated so one bad chat
  // doesn't abort the others.
  const recoverPendingApprovalCards = (
    restored: ReadonlyArray<readonly [string, ChatBinding]>,
  ): Effect.Effect<void> =>
    Effect.forEach(
      restored,
      ([chatId, binding]) =>
        Effect.gen(function* () {
          const handleOpt = yield* cardHandles.get(chatId);
          if (Option.isNone(handleOpt)) {
            return;
          }
          const handle = handleOpt.value;
          if (handle.pendingRequestId === null) {
            return;
          }
          const threadId = binding.threadId;

          // #0/#1(c): graceful fallback when the persisted handle has no captured
          // operator (pre-M2b-2 data, or the card was rendered before any inbound
          // message identified the chat's operator). M-2/PR2b: the "empty open id →
          // dead button" premise only holds when the gate's authority DEPENDS on the
          // (missing) initiator — i.e. `initiator` mode with no bound owner. If an
          // owner is bound (owner-always) OR the chat's mode is `designated`/`all`
          // (initiator-independent), the card is approvable with no captured operator,
          // so recover it. Resolve the mode from the thread's current per-chat config
          // (same source the cardAction gate uses); a cold shell cache (null) is
          // treated as not-recoverable → the safe nudge fallback.
          if (handle.operatorOpenId.length === 0) {
            const recoveryShell = yield* shellCache.threadById(threadId);
            const owner = yield* Ref.get(ownerRef);
            const mode =
              recoveryShell === null
                ? null
                : effectiveChatConfig(
                    chatId,
                    yield* Ref.get(chatConfigsRef),
                    yield* Ref.get(chatDefaultsRef),
                  ).approvalMode;
            const recoverable = mode !== null && (owner !== null || mode !== "initiator");
            if (!recoverable) {
              // initiator-only with no owner (or cold cache): re-signing with an empty
              // open id would dead-end at verify time, so drop the stale handle and
              // nudge the user to send a message — which re-drives the turn and produces
              // a fresh, correctly-signed card. No wildcard / auth bypass.
              yield* cardHandles.remove(chatId).pipe(Effect.ignore);
              yield* sendNotice(
                chatId,
                "⚠️ 有待批准的操作,请发送一条消息以继续(将刷新可操作的卡片)。",
              );
              yield* Console.log(
                `[feishu-bot] skipping approval-card recovery for chat ${chatId} (no captured operator, initiator-only mode); nudged user to resend.`,
              );
              return;
            }
            // Recoverable (owner bound or non-initiator mode): fall through. The
            // recovered buttons sign the (empty) initiator into `payload.o`, but the
            // owner / a designated approver / any member can still approve them — the
            // gate does not consult `payload.o` in those cases.
            yield* Console.log(
              `[feishu-bot] recovering approval card for chat ${chatId} with no captured operator (owner bound or non-initiator mode; approvable without the initiator).`,
            );
          }

          // Seed the trusted `feishuInitiators` map with the recovered operator so the
          // observe fiber started just below (修法 1) — and any follow-on approval that
          // surfaces on this thread — signs `payload.o` for the recovered initiator
          // across the restart, instead of an empty open id (dead buttons). The map is
          // keyed by `threadId` (the observe / surface paths read it by threadId). Only
          // a non-empty operator is planted; an empty one carries no authority (owner /
          // designated / all can still approve — the gate ignores `payload.o` there —
          // and `initiator` mode correctly has no clickable Feishu approver until the
          // user acts, mirroring the empty-operator handling above).
          if (handle.operatorOpenId.length > 0) {
            yield* Ref.update(feishuInitiators, (map) =>
              new Map(map).set(threadId, handle.operatorOpenId),
            );
          }

          // #7: bound the one-shot snapshot read. `subscribeThread` is `orDie`'d and
          // retries the subscription forever on an expected failure, so a thread
          // that was deleted/archived while the bot was down (or a server that never
          // delivers its first frame) would otherwise hang this read — and, since it
          // runs synchronously on the main `runBoundSession` fiber before `Effect.never`,
          // wedge startup. A `timeout` turns that into a `None` we skip past.
          const firstFrame = yield* Stream.runHead(
            subscribeThread(threadId).pipe(Stream.take(1)),
          ).pipe(
            Effect.scoped,
            Effect.timeout(Duration.seconds(10)),
            Effect.option,
            Effect.map(Option.flatten),
          );
          const snapshotThread = Option.match(firstFrame, {
            onNone: () => null as OrchestrationThread | null,
            onSome: (item) => (item.kind === "snapshot" ? item.snapshot.thread : null),
          });
          if (snapshotThread === null) {
            yield* Console.log(
              `[feishu-bot] approval-card recovery skipped for chat ${chatId} (no snapshot within timeout).`,
            );
            return;
          }

          const pendingApprovals = derivePendingApprovals(snapshotThread.activities);
          const pendingUserInputs = derivePendingUserInputs(snapshotThread.activities);
          const stillPending = pendingApprovals.some(
            (approval) => approval.requestId === handle.pendingRequestId,
          );
          // #2: the original request may have been resolved while the bot was down,
          // but a *new* approval (B) can have appeared on the same thread in the
          // meantime. Only drop the handle when nothing at all is pending; if any
          // approval/user-input is pending we fall through to the render path, which
          // lets `buildInteraction` (via `derivePendingApprovals` /
          // `derivePendingUserInputs`) surface B on the same card/messageId rather
          // than leaving the user with no actionable card.
          if (!stillPending && pendingApprovals.length === 0 && pendingUserInputs.length === 0) {
            // Nothing pending at all (resolved elsewhere, no replacement): drop the
            // stale handle so we don't keep trying to recover a dead request.
            yield* cardHandles.remove(chatId).pipe(Effect.ignore);
            return;
          }

          // Still pending (the original request, or a newer approval B): re-render
          // the approval card with freshly-signed buttons and push it onto the same
          // message id. #0/#1(b): re-sign for the operator captured on the handle
          // (the `feishuInitiators` map may be empty right after a restart, but the
          // durable handle carries it) so the buttons verify correctly when clicked;
          // the operator is re-checked at verify time.
          const interaction = yield* buildInteraction(
            chatId,
            snapshotThread,
            handle.operatorOpenId,
          );
          const density = yield* resolveDensity(chatId, snapshotThread.runtimeMode);
          const card = renderThreadCard(snapshotThread, {
            streaming: false,
            density,
            ...(interaction ? { interaction } : {}),
          }).card;
          // #10: reflect the ACTUAL outcome of the card push. `updateCard` failures
          // are still swallowed (recovery must never crash the bot), but we no
          // longer log a "recovered" success unconditionally — a failed push logs a
          // warning instead, so the log doesn't claim success that didn't happen.
          const pushExit = yield* gateway.updateCard(handle.messageId, card).pipe(Effect.exit);
          if (pushExit._tag === "Failure") {
            yield* Effect.logWarning(
              `[feishu-bot] approval-card recovery render failed for chat ${chatId} (request ${handle.pendingRequestId}).`,
              pushExit.cause,
            );
          } else {
            // #2: the card we just rendered may solicit a *newer* request (B) than the
            // one stored on the handle (the original was resolved while the bot was
            // down). Refresh the durable `pendingRequestId` to the request actually
            // rendered — the SAME priority `buildInteraction`/`renderInteractionSection`
            // used (approval first, then user-input) — so the resident shellWatcher's
            // single-source dedup (`CardHandle.pendingRequestId`) matches the surfaced
            // card and does NOT re-send a duplicate (which would also be signed with an
            // empty operator post-restart, i.e. dead buttons). Reuse the recovered
            // `messageId` and the persisted `operatorOpenId` (the map may still be empty).
            const renderedRequestId =
              pendingApprovals[0]?.requestId ?? pendingUserInputs[0]?.requestId ?? null;
            yield* cardHandles
              .put(chatId, {
                messageId: handle.messageId,
                pendingRequestId: renderedRequestId,
                lastSequence: handle.lastSequence,
                operatorOpenId: handle.operatorOpenId,
              })
              .pipe(Effect.ignore);
            yield* Console.log(
              `[feishu-bot] recovered outstanding approval card for chat ${chatId} (request ${renderedRequestId}).`,
            );

            // 修法 1 (core): if the recovered turn is STILL RUNNING, start observe NOW
            // so it ADOPTS this just-recovered card instead of opening a second one
            // later. The bug it fixes: with the turn paused on an approval the shell
            // stops pushing frames, so observe's adopt trigger (the shellWatcher's 2nd
            // frame) never fires while paused; it only fires after the user approves #1
            // and the turn resumes — by which point request #1 is resolved and NOT in
            // observe's live-pending set, so the adopt branch misses and observe opens a
            // FRESH card for #2 (with, pre-修法 2/3, an empty-operator signature → dead
            // buttons). Starting observe here, while #1 is still live-pending, makes
            // observe's adopt branch HIT immediately: it keeps rendering onto THIS
            // `messageId` (single card) and 修法 2 forwards the recovered operator, so
            // follow-on #2 renders on the same card with verifiable buttons.
            //
            // `recoverApprovalCards` runs BEFORE `shellWatcher.start`, inside this same
            // `runBoundSession` gen scope, so `ensureObserving` is callable here. Its own
            // gates apply: `isChatBusy` (turnQueue empty post-restart → false) lets it
            // through, and the atomic claim dedups per-chat (multiple bindings each get
            // their own observe, keyed by `chatId`). A null `activeTurnId` (turn already
            // settled) makes `ensureObserving` a no-op. `Effect.ignore` keeps any
            // observe-start failure from aborting this chat's recovery (the per-chat
            // `catchCause` below is the second backstop, so startup never crashes).
            const recoveredActiveTurnId = snapshotThread.session?.activeTurnId ?? null;
            if (recoveredActiveTurnId !== null) {
              yield* ensureObserving(chatId, threadId, recoveredActiveTurnId).pipe(Effect.ignore);
            }
          }
        }).pipe(
          // Per-chat isolation: a failure recovering one chat must not abort the
          // others. Logged at warning level, then swallowed.
          Effect.catchCause((cause) =>
            Effect.logWarning(
              `[feishu-bot] approval-card recovery failed for chat ${chatId}.`,
              cause,
            ),
          ),
        ),
      // #6: recover chats with bounded concurrency. Each per-chat snapshot read is
      // bounded by a 10s `timeout`; with the old fully-serial `forEach` a handful of
      // chats whose threads were deleted/never-deliver-a-frame while the bot was down
      // would each burn their full 10s back-to-back (N × 10s) and stall startup right
      // up to `Effect.never`. A small bound runs them in parallel so the worst case is
      // ~10s total, not 10s per chat, while the per-chat `catchCause` isolation above
      // (one bad chat never aborts the pass) is preserved unchanged.
      { concurrency: 8, discard: true },
    ).pipe(
      // Outer guard: ANY failure of the recovery pass as a whole is non-fatal —
      // startup must proceed to `Effect.never` regardless.
      Effect.catchCause((cause) =>
        Effect.logWarning("[feishu-bot] approval-card recovery pass failed.", cause),
      ),
    );

  return { recoverPendingApprovalCards } as const;
};
