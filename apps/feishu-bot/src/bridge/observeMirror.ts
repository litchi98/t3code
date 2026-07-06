/**
 * Observe/mirror lifecycle extracted from bot.ts.
 *
 * Keeps the atomic observe-token claim→install→self-evict protocol and its
 * per-binding scope explicit while preserving the original closure bodies.
 */
import {
  type OrchestrationMessage,
  type OrchestrationThread,
  type OrchestrationThreadStreamItem,
  type RuntimeMode,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import {
  derivePendingApprovals,
  derivePendingUserInputs,
} from "@t3tools/client-runtime/state/thread-activity";
import * as Console from "effect/Console";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import type { LarkGateway, StreamingCard } from "../lark/index.ts";
import type { CardHandle, CardHandleStore } from "../runtime/persistence.ts";
import type { BindingState } from "./bindingState.ts";
import { type RenderDensity, renderThreadCard } from "./eventRenderer.ts";
import { splitChatKey } from "./chatThreadMap.ts";
import { topicSendOpts } from "./notices.ts";
import { observeThread, type ThreadObservation } from "./session.ts";
import { type ShellSnapshotCache, shellStatus } from "./shellCache.ts";

/** Dependencies for one bound session's observe/mirror lifecycle. */
export interface ObserveMirrorDeps {
  /** Per-binding sub-scope that owns resident observe fibers. */
  readonly rootScope: Scope.Scope;
  /** Connected Feishu gateway for card creation and updates. */
  readonly gateway: LarkGateway["Service"];
  /** Mutable chat-to-thread binding state. */
  readonly bindings: BindingState["Service"];
  /** Durable latest-card handles used for dedup and recovery. */
  readonly cardHandles: CardHandleStore["Service"];
  /** Resident shell snapshot cache used by takeover notices. */
  readonly shellCache: ShellSnapshotCache;
  /** Assembly-owned read-only busy probe for the turn queue. */
  readonly isChatBusy: (chatId: string) => Effect.Effect<boolean>;
  /** Assembly-owned current-operator map, read at render time. */
  readonly chatOperators: Ref.Ref<ReadonlyMap<string, string>>;
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
  /** Subscribe to a thread's replaying detail stream. */
  readonly subscribeThread: (threadId: ThreadId) => Stream.Stream<OrchestrationThreadStreamItem>;
  /** Send a static notice card to a conversation. */
  readonly sendNotice: (
    chatKey: string,
    text: string,
    replyToMessageId?: string,
  ) => Effect.Effect<void>;
  /** Render a compact transcript from recent messages. */
  readonly renderTranscriptMarkdown: (
    messages: ReadonlyArray<OrchestrationMessage>,
  ) => string | null;
  /** Schema-valid seed thread for initial streaming-card frames. */
  readonly placeholderThread: OrchestrationThread;
}

/** Handle returned by {@link makeObserveMirror}. */
export interface ObserveMirrorHandle {
  readonly startMirror: (
    chatId: string,
    threadId: ThreadId,
    replyToMessageId?: string,
  ) => Effect.Effect<void>;
  readonly isObserving: (chatId: string) => Effect.Effect<boolean>;
  readonly stopObserve: (chatId: string) => Effect.Effect<void>;
  readonly stopMirror: (chatId: string) => Effect.Effect<void>;
  readonly ensureObserving: (
    chatId: string,
    threadId: ThreadId,
    activeTurnId: TurnId | null,
  ) => Effect.Effect<void>;
  readonly surfacePendingApprovalIfNew: (
    chatId: string,
    threadId: ThreadId,
    preReadSnapshot?: OrchestrationThread | null,
    replyToMessageId?: string,
  ) => Effect.Effect<void>;
  readonly renderObservationToCard: (
    chatId: string,
    threadId: ThreadId,
    observation: ThreadObservation,
    handle: StreamingCard,
    operatorOverride?: string,
  ) => Effect.Effect<void, never, Scope.Scope>;
}

/** Construct the observe/mirror lifecycle for one bound Feishu session. */
export const makeObserveMirror = (deps: ObserveMirrorDeps): Effect.Effect<ObserveMirrorHandle> =>
  Effect.gen(function* () {
    const {
      rootScope,
      gateway,
      bindings,
      cardHandles,
      shellCache,
      isChatBusy,
      chatOperators,
      buildInteraction,
      resolveDensity,
      subscribeThread,
      sendNotice,
      renderTranscriptMarkdown,
      placeholderThread,
    } = deps;

    // Mirror-light: a `/resume` takeover (or a self-created first contact) does
    // not start a resident per-thread observe fiber. `startMirror` re-binds the
    // chat as `origin: "resumed"` then pushes a single, one-off "已接管" card.
    // M2b-2: instead of a shell-status-only notice, it takes a one-shot thread
    // snapshot (the `subscribeThread` stream replays a full snapshot first;
    // `Stream.take(1)` + `Effect.scoped` closes the subscription immediately —
    // the same pattern the cardAction handler uses) and renders a *simple
    // transcript* card from the last few messages. No resident fiber is started
    // (still mirror-light); live streaming resumes only when the user sends the
    // next message (the normal turn path). A null/empty snapshot falls back to
    // the M2a shell-status text notice.
    const startMirror = (
      chatId: string,
      threadId: ThreadId,
      // M3b path A: the `/resume` command message id (belongs to the resumed topic).
      // Used as the in-thread reply anchor for the takeover approval card and stored
      // on the binding as `topicAnchorMessageId` so later topic-anchored cards land
      // inside the topic. Absent (non-`/resume` callers) → cards post at the root.
      replyToMessageId?: string,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        // M2b-3: a `/resume` may re-point a chat that is already mirroring a previous
        // thread. Tear down any existing observe fiber first so the new takeover's
        // `ensureObserving` below is not deduped out by a stale entry under this
        // chatId (which would leave the chat observing the OLD thread). Idempotent
        // no-op when nothing is observing.
        yield* stopObserve(chatId);
        // Fix A: clear stale cardHandle so a click on the old card cannot be
        // misidentified as "current card, unauthorised clicker" (bystander no-op).
        // `surfacePendingApprovalIfNew` at the end of startMirror will re-populate
        // the handle if the new thread has a pending approval; otherwise the handle
        // stays absent → any click on the old card correctly falls through to the
        // "degrade stale card" path.
        yield* cardHandles.remove(chatId).pipe(Effect.ignore);
        // M3b: anchor later topic-anchored cards (path A surfaces below, path B's
        // watcher) to the `/resume` command message — it belongs to the resumed
        // topic, whereas `anchorOf` may yield an `omt_…` Feishu rejects as a reply
        // target. exactOptionalPropertyTypes: omit the key when absent rather than
        // assigning `undefined` (see persistence.ts `migrateChatBinding`). Density is
        // deliberately NOT stored here — a clean per-thread `runtimeMode` is not yet
        // available (the snapshot is read below), and the placeholder's
        // `densityForRuntime(placeholderThread.runtimeMode, …)` fallback is safe.
        yield* bindings.bind(chatId, {
          threadId,
          origin: "resumed",
          ...(replyToMessageId !== undefined ? { topicAnchorMessageId: replyToMessageId } : {}),
        });
        const shell = yield* shellCache.threadById(threadId);
        const title = shell?.title ?? threadId;
        // Map the shared `shellStatus` classifier to this card's Chinese line, so
        // the takeover card and the `/status` tag stay in lock-step on one split.
        const statusLine = {
          running: "状态: 运行中",
          "pending-approval": "状态: 有待批准操作",
          idle: "状态: 空闲",
          unknown: "(状态未知)",
        }[shellStatus(shell)];

        // One-shot snapshot for the transcript. Any failure here must NOT block
        // the takeover — fall back to the M2a status-only notice. `Effect.option`
        // turns a (typed) read failure into `None`; `Option.flatten` collapses the
        // resulting `Option<Option<item>>` back to `Option<item>`.
        // #7: `subscribeThread` is `orDie`'d and retries a not-ready subscription
        // forever, so a deleted/never-delivering thread would hang the user's
        // `/resume` indefinitely. Bound the read with a `timeout` (→ None) so the
        // takeover always settles into the status-only fallback within ~10s.
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

        // ── M2b-3: live-mirror a takeover of an *already-running* turn ───────────
        // If the snapshot shows a turn currently running (`session.activeTurnId`),
        // start a resident observe fiber that mirrors its progress/approvals/result
        // onto a live streaming card until it ends — then `ensureObserving` itself
        // returns and the chat falls back to mirror-light. When observe DID start we
        // RETURN here, skipping both the transcript card AND 修法 A's one-shot surface:
        // the observe card already carries the full live state *and* the interaction
        // controls (via `buildInteraction` per tick), so a transcript + a separate
        // approval card would be a redundant double-post for the same takeover. With
        // no active turn we keep the existing mirror-light behaviour (transcript +
        // 修法 A). `ensureObserving`'s own gates (isChatBusy / dedup) make this safe to
        // call unconditionally.
        //
        // Safety net — `ensureObserving` may decline to start (e.g. `isChatBusy`, or a
        // claim it then self-evicts). When it does, `isObserving` stays false and we
        // must NOT silently swallow the takeover: fall through to the transcript + 修法
        // A path so the operator still sees the current state and any pending approval
        // (修法 A's dedup compares the real top requestId against the handle, so it
        // never double-posts the same request). With the Bug-C defer gate removed, an
        // outstanding-approval takeover now normally observes (and the observe fiber
        // adopts the recovered card), so this fall-through rarely fires — but it is a
        // harmless backstop.
        if (snapshotThread?.session?.activeTurnId != null) {
          yield* ensureObserving(chatId, threadId, snapshotThread.session.activeTurnId);
          if (yield* isObserving(chatId)) {
            return;
          }
        }

        const transcript =
          snapshotThread === null ? null : renderTranscriptMarkdown(snapshotThread.messages);

        if (transcript !== null) {
          yield* sendNotice(
            chatId,
            [
              `已接管会话: ${title}`,
              statusLine,
              "",
              "最近对话:",
              transcript,
              "",
              "发送消息即可继续这个会话;/status 查看状态,/release 退出。",
            ].join("\n"),
          );
        } else {
          // Fallback (no snapshot, or no message history): the M2a status-only card.
          yield* sendNotice(
            chatId,
            [
              `已接管会话: ${title}`,
              statusLine,
              // The shell view carries no message history and the snapshot was
              // unavailable/empty; be honest that full history lives elsewhere.
              "(完整历史请见终端/Web)",
              "发送消息即可继续这个会话;/status 查看状态,/release 退出。",
            ].join("\n"),
          );
        }

        // ── M2b-2 (修法 A): surface a pre-existing pending approval on takeover ──
        //
        // The §11E "电脑→飞书 approval 接手" promise: a turn started on web that is
        // *blocked on an approval/user-input* must become actionable from Feishu the
        // moment the operator `/resume`s. The transcript card above is a *messages*
        // view only — it never carries the interaction controls. So when a request is
        // still pending, emit ONE actionable card whose freshly-signed buttons let the
        // `/resume` operator approve cross-end.
        //
        // This now delegates to the shared `surfacePendingApprovalIfNew` helper (the
        // same one 修法 B's watcher calls) so the takeover-surface and the follow-on
        // surface stay byte-for-byte consistent (one render/send/persist path, AGENTS
        // anti-duplication). On takeover there is no prior CardHandle, so the helper's
        // single-source dedup naturally passes and surfaces approval #1 — persisting
        // its requestId as the dedup baseline the watcher then composes with (it skips
        // the same id and surfaces a later #2). The operator captured by
        // `handleInbound` before routing `/resume` is read from `chatOperators` inside
        // the helper. Still mirror-light: no resident observe fiber. Robustness
        // (catchCause) lives inside the helper.
        //
        // #7: reuse the `snapshotThread` we already read above for the transcript card
        // instead of letting the helper take a *second* one-shot snapshot — that
        // doubled the takeover latency (two reads, each bounded by the 10s subscribe
        // timeout). Passing it (even `null`) tells the helper "use this; do not read".
        yield* surfacePendingApprovalIfNew(chatId, threadId, snapshotThread, replyToMessageId);
      });

    // ── M2b-3: resident observe-fiber registry (cross-end turn mirroring) ────────
    //
    // A `/resume` takeover (or a follow-on turn web starts after takeover) of a turn
    // the bridge did NOT drive must be mirrored live onto a Feishu card until it
    // ends. `ensureObserving` forks one `runObserveFiber` per chat and registers it
    // here.
    //
    // Dedup is keyed on CHAT-ID PRESENCE + SELF-EVICTION — NOT per-turn. The registry
    // holds at most one entry per `chatId`; `ensureObserving` skips when one is
    // already present (`map.has(chatId)`), and the fiber removes its own entry on exit
    // (self-eviction). The consequence is deliberate: a chat's CONSECUTIVE turns reuse
    // the SAME observe fiber and the SAME card — on an A→B turn rotation that never
    // surfaces `activeTurnId === null` between the two (a direct chain), fiber A keeps
    // folding the same thread subscription and mirrors B's progress onto its existing
    // card (continuous mirror). B's own `ensureObserving` is deduped out by the present
    // chat-id entry. This is the intended "纳入接管后新 turn" behaviour; it is NOT a
    // per-turn fiber rotation (that would break the continuous mirror). The only
    // identity used by guards is the per-attempt `token`; nothing keys on a turnId.
    //
    // Each per-chat entry carries a unique `token` (a fresh monotonic counter value)
    // plus the `fiber` (for interruption); the token — NOT a fiber reference — is the
    // identity used by every guard, so the claim→install→self-evict handshake is
    // immune to fiber-completion timing (a fiber that finishes before its handle is
    // even installed still evicts exactly its own token, never a newer entry).
    //
    // ALL reads/writes go through `Ref.modify` (atomic; Effect's cooperative
    // scheduling means no interleaving mid-`modify`), and `Fiber.interrupt` ALWAYS
    // runs AFTER the modify, outside the lock — the exact `turnQueue.ts` "decide in
    // modify, side-effect outside" pattern; the equality guard is on `token`.
    interface ObserveState {
      /** The forked observe fiber, or `null` in the claim→install window. */
      readonly fiber: Fiber.Fiber<void> | null;
      /** Unique per observe attempt; the sole identity used by every guard. */
      readonly token: number;
    }
    const activeRenderFibers = yield* Ref.make<ReadonlyMap<string, ObserveState>>(new Map());
    // Monotonic source for {@link ObserveState.token}s; never reused.
    const nextObserveToken = yield* Ref.make<number>(1);

    // Read-only: is an observe fiber currently registered for this chat? Used as
    // `surfacePendingApprovalIfNew`'s second door (an observe card already carries
    // the interaction, so a surface would double-post) and inside `ensureObserving`.
    const isObserving = (chatId: string): Effect.Effect<boolean> =>
      Ref.get(activeRenderFibers).pipe(Effect.map((map) => map.has(chatId)));

    // Atomically remove this chat's observe entry and interrupt its fiber (outside
    // the modify). No-op if none. `stopMirror` (so `/release` + watcher teardown
    // tear the mirror down) and `runTurn`'s pre-dispatch preemption both call it.
    const stopObserve = (chatId: string): Effect.Effect<void> =>
      Ref.modify(
        activeRenderFibers,
        (map): readonly [Fiber.Fiber<void> | null, ReadonlyMap<string, ObserveState>] => {
          const existing = map.get(chatId);
          if (existing === undefined) {
            return [null, map];
          }
          const next = new Map(map);
          next.delete(chatId);
          return [existing.fiber, next];
        },
      ).pipe(
        // Interrupt OUTSIDE the modify (lock), per the turnQueue Ref.modify+side-
        // effect-after pattern. Closing the fiber tears down its child scope →
        // unsubscribes the observed thread (see `runObserveFiber`). The fiber's own
        // self-evict finalizer is then a no-op (its token is already gone).
        Effect.flatMap((fiber) => (fiber === null ? Effect.void : Fiber.interrupt(fiber))),
      );

    // Mirror-light teardown is now the real observe teardown (M2b-3): interrupt the
    // chat's resident observe fiber (if any) so a `/release` / unbind / reconcile
    // stops the cross-end mirror. The candidate cache lives inside
    // `buildCommandTable`'s closure and is self-pruning, so there is nothing else to
    // clear here.
    const stopMirror = (chatId: string): Effect.Effect<void> => stopObserve(chatId);

    // Central trigger gate for cross-end turn mirroring. Forks a `runObserveFiber`
    // for `chatId`/`threadId` iff a turn is genuinely running on `threadId` that the
    // bridge is NOT itself driving and is NOT already observing.
    //
    // Gating (in order):
    //  1. `activeTurnId == null` → no live turn to mirror → skip.
    //  2. `isChatBusy(chatId)` → the bridge is driving (or about to dispatch) a turn
    //     for this chat; `driveTurn` owns the card. Observing too would double-render
    //     this end's own turn → skip. (driveTurn > observe; `runTurn` also preempts.)
    //  3. Atomic reservation (TOCTOU-free): a SINGLE `Ref.modify` both dedups and
    //     claims. If an entry already exists for this chat (observing, or a claim in
    //     flight) → return `false`, change nothing — this is the CHAT-ID-presence
    //     dedup, so a chat's later turn reuses the in-place fiber rather than starting
    //     a second one. Otherwise mint a fresh `token`, write the CLAIM marker
    //     `{ fiber: null, token }`, and return `true`. Because the dedup-check and the
    //     claim-write are the same atomic modify, two racing callers (startMirror on
    //     one fiber, the shellWatcher on another) can never BOTH see "free" and both
    //     fork — exactly one wins the claim; the loser sees the claim and skips. The
    //     winner forks (forking cannot happen inside a modify) and installs the real
    //     fiber into the slot — but only if its own `token` is still the current entry
    //     (guarded), so a concurrent `stopObserve` or self-evict wins and the just-
    //     forked fiber is interrupted, never leaked.
    const ensureObserving = (
      chatId: string,
      threadId: ThreadId,
      activeTurnId: TurnId | null,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (activeTurnId === null) {
          return;
        }
        // driveTurn (this end's own turn) wins over observe: never mirror a turn the
        // bridge is itself driving for this chat (would double-render).
        if (yield* isChatBusy(chatId)) {
          return;
        }
        // Bug C — an outstanding M2b-2 / M18 approval card does NOT block observe.
        // When a resumed chat was blocked on an approval at restart, M18 recovery
        // (`recoverApprovalCards`) re-renders that approval onto the EXISTING card
        // (old `messageId`) and writes a handle with `pendingRequestId != null`.
        // Rather than DEFER (which left a chat that is simultaneously running AND
        // awaiting an approval with no progress mirror — the normal §11E case — and
        // could pin forever on a stale cross-thread handle), `runObserveFiber` ADOPTS
        // that recovered card: if the persisted handle still solicits a currently-
        // live-pending request it continues rendering onto the same `messageId` via
        // `updateCard` (no new card, no `persistHandle(null)` clobber, operator
        // re-signed from the handle); otherwise it opens a fresh streaming card.
        // So we proceed to claim/observe unconditionally here — the adopt-vs-open
        // decision is made inside the fiber once it has the authoritative first frame.
        // Atomic dedup + claim (see the block comment above). Mint the token first;
        // the modify only consumes it (writes the claim) when the slot is free, so an
        // unused token on the dedup path is harmless (it is simply never installed).
        const token = yield* Ref.modify(nextObserveToken, (n) => [n, n + 1] as const);
        const claimed = yield* Ref.modify(
          activeRenderFibers,
          (map): readonly [boolean, ReadonlyMap<string, ObserveState>] => {
            if (map.has(chatId)) {
              // Already observing (a fiber is registered, or a claim is in flight) →
              // do not start a second one for this chat.
              return [false, map];
            }
            // Free: place the claim marker (fiber filled in after fork).
            return [true, new Map(map).set(chatId, { fiber: null, token })];
          },
        );
        if (!claimed) {
          return;
        }
        // We own the claim. Fork the observe fiber (cannot fork inside `modify`) — it
        // carries our `token` and self-evicts by it on exit — then install the real
        // fiber into the slot, but only if OUR token is still the current entry. A
        // concurrent `stopObserve` (preemption) or a fast self-evict (the turn was
        // already terminal) may have removed/replaced it; if so the fiber is orphaned
        // and we interrupt it so it does not leak an open thread subscription.
        const fiber = yield* runObserveFiber(chatId, threadId, token);
        const installed = yield* Ref.modify(
          activeRenderFibers,
          (map): readonly [boolean, ReadonlyMap<string, ObserveState>] => {
            const existing = map.get(chatId);
            if (existing !== undefined && existing.token === token) {
              return [true, new Map(map).set(chatId, { fiber, token })];
            }
            return [false, map];
          },
        );
        if (!installed) {
          yield* Fiber.interrupt(fiber);
          return;
        }
        // Bug A — close the `isChatBusy`-gate ↔ claim TOCTOU. The `isChatBusy` check
        // above (turnQueue.states Ref) and the claim (activeRenderFibers Ref) are two
        // independent atomics with a yield point between them, so a concurrent
        // `runTurn` can interleave: it does `beginTurn` (sets running=true) → then
        // `stopObserve` (which is a no-op if our claim wasn't installed yet). The bad
        // window is `runTurn`'s `stopObserve` running while our slot is empty (claim
        // minted, fiber not yet installed): `driveTurn` then opens its own card AND we
        // install our observe fiber → two streaming cards fight, and `runTurn`'s
        // one-shot `stopObserve` already ran, so observe is never torn down.
        //
        // Re-read `isChatBusy` AFTER a successful install. Invariant that closes the
        // window: `runTurn` calls `beginTurn` (running=true) BEFORE its `stopObserve`.
        //  • If our install lands AFTER `runTurn`'s `stopObserve`, then `beginTurn`
        //    already ran, so this re-check sees `isChatBusy === true` and we evict
        //    ourselves here.
        //  • If our install lands BEFORE `runTurn`'s `stopObserve`, that `stopObserve`
        //    sees our installed fiber and interrupts it.
        // Either way the just-installed observe is torn down — no double render. The
        // eviction uses the SAME token/fiber identity guard as `stopObserve`/self-
        // evict: only remove the slot if it still carries OUR token (a preempting
        // install must never be clobbered), and `Fiber.interrupt` runs AFTER the
        // `modify`, outside the lock (the turnQueue.ts pattern).
        if (yield* isChatBusy(chatId)) {
          const evicted = yield* Ref.modify(
            activeRenderFibers,
            (map): readonly [Fiber.Fiber<void> | null, ReadonlyMap<string, ObserveState>] => {
              const existing = map.get(chatId);
              if (existing === undefined || existing.token !== token) {
                return [null, map];
              }
              const next = new Map(map);
              next.delete(chatId);
              return [existing.fiber, next];
            },
          );
          if (evicted !== null) {
            yield* Fiber.interrupt(evicted);
          }
        }
      });

    // ── M2b-2 (修法 A + 修法 B shared): surface a *new* pending request as a card ──
    //
    // Single helper for "a pending approval/user-input exists on `threadId` that
    // Feishu has not yet rendered an actionable card for → send one fresh card and
    // remember it". Used by BOTH:
    //   - 修法 A (`startMirror`): the takeover moment — the approval already pending
    //     when the operator `/resume`s.
    //   - 修法 B (`shellWatcher`): the *chained/follow-on* approvals a resumed turn
    //     raises while the bridge is not live-mirroring (e.g. approve #1 → the turn
    //     continues → #2 appears). The watcher's single resident fiber calls this
    //     each frame the resumed thread's shell `hasPendingApprovals` is true.
    //
    // ── Single-source dedup (the load-bearing bit) ───────────────────────────────
    // `CardHandle.pendingRequestId` is the ONE source of truth for "which request is
    // currently surfaced in Feishu". We read a one-shot thread snapshot, take the
    // *top* pending requestId (approval first, then user-input — the same priority
    // `CardHandle` persistence uses elsewhere), and compare it to the stored handle:
    //   - top requestId === handle.pendingRequestId → already surfaced → return.
    //   - otherwise (no handle, or a different id) → a genuinely new request →
    //     send a new card and persist a handle whose `pendingRequestId` is that top
    //     id, so the next frame/call dedups against it.
    // This is what keeps the watcher from re-spamming the same approval across the
    // many frames it stays pending, and what makes 修法 A and 修法 B compose: 修法 A
    // persists the handle for approval #1 on takeover, so the watcher sees #1 (same
    // id) and skips; once #1 is approved and #2 appears (new id) the watcher surfaces
    // #2. No per-frame diffing — dedup is keyed on the stable requestId.
    //
    // ROBUSTNESS: the whole effect is `catchCause`-wrapped (warn only). A null/empty
    // snapshot, a `buildInteraction`/render failure, a failed card send, or a persist
    // failure must NEVER crash the bot or wedge the watcher's reconciliation loop.
    const surfacePendingApprovalIfNew = (
      // M3a: composite `chatId[:larkThreadId]` conversation key. Used verbatim for
      // every state lookup (busy/observe gates, cardHandles, chatOperators,
      // buildInteraction); the actual card is sent to the real Feishu chatId
      // (`splitChatKey`) at the `startStreamingCard` call below.
      chatId: string,
      threadId: ThreadId,
      // #7: optional already-read first-frame snapshot. `startMirror` reads a first
      // frame for its transcript card and then calls this helper; passing that same
      // snapshot here lets the helper reuse it instead of doing a *second*
      // independent one-shot read (which doubled the `/resume` latency, each read
      // bounded by the 10s subscribe timeout). The watcher (修法 B) does not pre-read
      // and passes nothing, so the helper still reads its own first frame. A
      // `null`/`undefined` value means "read it yourself".
      preReadSnapshot?: OrchestrationThread | null,
      // M3b path A: the `/resume` command message id, used as the in-thread reply
      // anchor so the surfaced card posts inside the topic. Path B (the watcher)
      // passes nothing → falls back to the binding's stored `topicAnchorMessageId`.
      replyToMessageId?: string,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        // #3: race guard. When the bridge is actively driving (or about to dispatch)
        // a turn for THIS chat, `driveTurn` owns the live streaming card and will
        // render the approval/user-input itself — so a surface here would call
        // `startStreamingCard` and post a *second*, parallel card before `driveTurn`
        // has persisted its `pendingRequestId` (the single-source dedup baseline),
        // i.e. the very window where the requestId dedup cannot yet fire. Skip the
        // surface entirely while busy and let `driveTurn` render. Read-only probe
        // (`turnQueue.isBusy`): never mutates the queue's token accounting. (修法 B
        // / the watcher only reconciles `origin: "resumed"` chats; a resumed user
        // sending a live message is exactly when this collision happens.)
        //
        // M2b-3 second door: likewise skip while an observe fiber is mirroring this
        // chat — the observe card already renders the interaction (`buildInteraction`
        // per tick), so a surface here would double-post the same approval. (修法 B
        // calls this on every `hasPendingApprovals` frame; without this gate it would
        // race the live observe card.) `isObserving` is read-only on the registry.
        if ((yield* isChatBusy(chatId)) || (yield* isObserving(chatId))) {
          return;
        }

        // One-shot snapshot read (same bounded pattern as 修法 A / M18 recovery:
        // `subscribeThread` is `orDie`'d and retries forever, so a deleted /
        // never-delivering thread would hang without the timeout). A null snapshot
        // → nothing to surface. #7: reuse a caller-supplied pre-read snapshot when
        // present so `startMirror` does not read the first frame twice.
        const snapshotThread =
          preReadSnapshot !== undefined
            ? preReadSnapshot
            : yield* Stream.runHead(subscribeThread(threadId).pipe(Stream.take(1))).pipe(
                Effect.scoped,
                Effect.timeout(Duration.seconds(10)),
                Effect.option,
                Effect.map(Option.flatten),
                Effect.map((firstFrame) =>
                  Option.match(firstFrame, {
                    onNone: () => null as OrchestrationThread | null,
                    onSome: (item) => (item.kind === "snapshot" ? item.snapshot.thread : null),
                  }),
                ),
              );
        if (snapshotThread === null) {
          return;
        }

        // Top pending requestId: approval first, then user-input. No pending → done.
        const pendingApprovals = derivePendingApprovals(snapshotThread.activities);
        const pendingUserInputs = derivePendingUserInputs(snapshotThread.activities);
        const topRequestId =
          pendingApprovals[0]?.requestId ?? pendingUserInputs[0]?.requestId ?? null;
        if (topRequestId === null) {
          return;
        }

        // Single-source dedup: if the currently-surfaced card already solicits this
        // exact request, it has been surfaced — do not re-send.
        const handleOpt = yield* cardHandles.get(chatId);
        if (Option.isSome(handleOpt) && handleOpt.value.pendingRequestId === topRequestId) {
          return;
        }

        // Operator: a `resumed` binding was `/resume`d by a user, so `chatOperators`
        // is normally populated (the inbound `/resume` set it before routing). After
        // a restart, though, the Ref is empty even though the durable handle still
        // carries the operator who triggered the prior card — so for a brand-new
        // approval that surfaces post-restart we fall back to that persisted operator
        // (in a p2p private chat the takeover operator is the same person, so the
        // persisted open id is valid for the new request too). Reuse the handle read
        // above for the dedup so we don't fetch it twice. If BOTH are empty we still
        // surface the card so the user *sees* a request is pending. M-2: whether its
        // buttons are actionable now depends on the authz gate's per-chat mode, not on
        // this operator: with a bound owner (owner-always) or a `designated`/`all`
        // chat, the card is approvable regardless of the empty operator here. Only in
        // `initiator` mode with no owner does an empty operator yield a readable-but-
        // not-clickable card (the gate then needs `payload.o` = the initiator; no
        // wildcard / auth bypass), prompting a resend — mirroring M18's graceful fallback.
        const operators = yield* Ref.get(chatOperators);
        const operatorOpenId =
          // #5: the trailing `?? ""` was unreachable — the conditional's else branch
          // already yields `""`, so the `??` could only ever see a non-nullish string.
          operators.get(chatId) ?? (Option.isSome(handleOpt) ? handleOpt.value.operatorOpenId : "");

        const interaction = yield* buildInteraction(chatId, snapshotThread, operatorOpenId);
        const density = yield* resolveDensity(chatId, snapshotThread.runtimeMode);
        const card = renderThreadCard(snapshotThread, {
          streaming: false,
          density,
          ...(interaction ? { interaction } : {}),
        }).card;

        // Send a fresh card (one-shot: completion already resolved → render once and
        // settle) and capture its messageId for the persisted handle.
        const done = yield* Deferred.make<void>();
        yield* Deferred.succeed(done, undefined);
        // M3b: anchor the surfaced approval card inside the topic when possible.
        // Path A (`/resume`) supplies the command message id; path B (the watcher)
        // passes nothing and falls back to the binding's stored
        // `topicAnchorMessageId`. `topicSendOpts` only emits in-thread opts when the
        // key is a topic (`larkThreadId` present) AND a reply anchor is known;
        // otherwise `undefined` → posts at the chat/group root (p2p / no anchor).
        const { chatId: realChatId, larkThreadId } = splitChatKey(chatId);
        const binding = yield* bindings.get(chatId);
        const effectiveReplyTo = replyToMessageId ?? binding?.topicAnchorMessageId;
        const sendOpts = topicSendOpts(larkThreadId, effectiveReplyTo);
        const sent = yield* gateway.startStreamingCard(
          realChatId,
          card,
          { done: Deferred.await(done) },
          sendOpts,
        );

        // Persist so this call/frame's surfaced request is the dedup baseline for the
        // next one, and so M18 restart recovery can re-render it.
        yield* cardHandles.put(chatId, {
          messageId: sent.messageId,
          pendingRequestId: topRequestId,
          lastSequence: 0,
          operatorOpenId,
        });
        yield* Console.log(
          `[feishu-bot] surfaced pending approval card for chat ${chatId} (request ${topRequestId}).`,
        );
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning(
            `[feishu-bot] failed to surface pending approval for chat ${chatId}.`,
            cause,
          ),
        ),
      );

    // ── M2b-3: pure render loop shared by `driveTurn` and `runObserveFiber` ──
    //
    // Given an OPEN streaming card `handle` plus a thread `observation`, mirror
    // that observation onto the card until it completes: per-tick render (interaction
    // + currentTurnId scoping + persist the top pending requestId on change) forked
    // onto the caller's `Scope`, then a single terminal render once `completion`
    // resolves. This is the EXACT render behaviour `driveTurn` had inline — extracted
    // verbatim (DRY) so the cross-end observe fiber (`runObserveFiber`) reuses the
    // identical card pipeline. Each call gets its OWN `currentTurnIdRef` /
    // `lastPendingId` closure state (created here), so two concurrent callers on
    // different chats never share write-once / dedup state.
    //
    // It does NOT open or close the card (the caller owns that, including the
    // `cardDone` producer-release in `driveTurn` and the child scope in
    // `runObserveFiber`) and NEVER touches the turn queue — it is pure observation →
    // card. Requires a `Scope` for the `forkScoped` per-tick updater.
    const renderObservationToCard = (
      chatId: string,
      threadId: ThreadId,
      observation: ThreadObservation,
      handle: StreamingCard,
      // M2b-3 adopt path: optional operator override forwarded to every
      // `buildInteraction` here. The live `driveTurn`/streaming paths omit it and
      // resolve the operator from the in-process `chatOperators` Ref. When this
      // observe fiber ADOPTS an M18-recovered card after a restart the Ref is empty,
      // so the adopt branch passes the operator captured on the persisted handle —
      // exactly as M18 `recoverApprovalCards` re-signs its buttons — so the adopted
      // approval's buttons verify when clicked instead of dead-ending on an empty
      // open id. A non-empty override wins inside `buildInteraction`; otherwise it
      // falls back to the Ref (live behaviour unchanged).
      operatorOverride?: string,
    ): Effect.Effect<void, never, Scope.Scope> =>
      Effect.gen(function* () {
        // The turnId of the turn being rendered. Captured from the first tick whose
        // folded session carries a non-null `activeTurnId` (turn now running), then
        // held — so once the turn completes and `activeTurnId` flips back to `null`,
        // the final/terminal render still filters tools/reasoning/error/body to
        // *this* turn instead of letting the whole thread's history flood in. `null`
        // only until the running frame lands (before which the renderer falls back to
        // `activeTurnId`).
        const currentTurnIdRef = yield* Ref.make<TurnId | null>(null);
        const captureCurrentTurnId = (thread: OrchestrationThread) =>
          Ref.update(currentTurnIdRef, (seen) => seen ?? thread.session?.activeTurnId ?? null);

        // The pendingRequestId last persisted to the card handle. Persist a handle
        // update only when it *changes* (the JSON store writes on every `put`), not
        // on every render tick — so recovery (M2b-2) still sees the outstanding
        // approval without per-tick file churn.
        const lastPendingId = yield* Ref.make<string | null | undefined>(undefined);
        const persistHandle = (pendingRequestId: string | null) =>
          Ref.get(lastPendingId).pipe(
            Effect.flatMap((seen) =>
              seen === pendingRequestId
                ? Effect.void
                : // Capture the chat's *current* real operator open id (#0/#1):
                  // the verify side reads `evt.operator.openId`, the same source
                  // `handleInbound` writes into `chatOperators` — so persisting it
                  // here lets M18 restart recovery re-sign approval buttons for the
                  // real operator instead of an empty string (which would never
                  // match at verify time, permanently dead-ending the button).
                  //
                  // Bug C — do NOT blank a recoverable operator. After a restart the
                  // `chatOperators` Ref is empty even though a durable handle may still
                  // carry the operator who triggered the prior (M18-recovered) card.
                  // Unconditionally writing `""` here would poison that handle, so on
                  // the next restart M18 sees an empty operator and DROPS the handle
                  // (downgrading to a "send a message" nudge). Fall back to the existing
                  // handle's `operatorOpenId` when the Ref has none. Empty string is
                  // only written when BOTH are genuinely unknown.
                  //
                  // Fix 1(b) (M3a): a non-empty `operatorOverride` (the live
                  // `driveTurn` now pins this turn's *initiator*; the observe/adopt
                  // path passes the recovered handle's operator) wins — the SAME
                  // precedence `buildInteraction` uses. This persists the pinned
                  // initiator into the durable handle so M18 restart recovery re-signs
                  // the recovered approval for the initiator, NOT for whoever last
                  // @-mentioned the bot (which a later inbound could have flipped in
                  // the Ref). For p2p the initiator equals the chat owner equals the
                  // Ref value, so this is byte-identical.
                  Effect.all([
                    Ref.get(chatOperators),
                    cardHandles
                      .get(chatId)
                      .pipe(Effect.orElseSucceed(() => Option.none<CardHandle>())),
                  ]).pipe(
                    Effect.flatMap(([operators, existing]) =>
                      cardHandles
                        .put(chatId, {
                          messageId: handle.messageId,
                          pendingRequestId,
                          lastSequence: 0,
                          operatorOpenId:
                            operatorOverride !== undefined && operatorOverride.length > 0
                              ? operatorOverride
                              : (operators.get(chatId) ??
                                (Option.isSome(existing) ? existing.value.operatorOpenId : "")),
                        })
                        .pipe(
                          Effect.ignore,
                          Effect.andThen(Ref.set(lastPendingId, pendingRequestId)),
                        ),
                    ),
                  ),
            ),
          );
        // Record the card handle once up front (no pending yet) so M2b-2 recovery can
        // re-render an outstanding approval card across a restart.
        yield* persistHandle(null);
        yield* observation.ticks.pipe(
          Stream.runForEach((thread) =>
            captureCurrentTurnId(thread).pipe(
              Effect.andThen(Ref.get(currentTurnIdRef)),
              Effect.flatMap((currentTurnId) =>
                // M-3 PR-C3: resolve density per tick from the REAL `thread.runtimeMode`
                // (p2p ⇒ full-access ⇒ card, via `resolveDensity`'s gate) so a per-chat
                // override lands AND the p2p-always-card invariant holds — the synthetic
                // placeholder's runtimeMode must never decide the live card's density.
                Effect.all({
                  interaction: buildInteraction(chatId, thread, operatorOverride),
                  density: resolveDensity(chatId, thread.runtimeMode),
                }).pipe(
                  Effect.flatMap(({ interaction, density }) =>
                    handle
                      .update(
                        renderThreadCard(thread, {
                          streaming: true,
                          currentTurnId,
                          density,
                          ...(interaction ? { interaction } : {}),
                        }).card,
                      )
                      .pipe(
                        Effect.ignore,
                        // Refresh the handle's `pendingRequestId` to the top open
                        // request (approval first, then user-input — the same
                        // priority `surfacePendingApprovalIfNew` derives its
                        // `topRequestId` with) — only when it changed. #2: a
                        // user-input-only turn must NOT persist `null` here, or M18
                        // restart recovery (which skips a handle whose
                        // `pendingRequestId === null`) would never recover the
                        // user-input card.
                        Effect.andThen(
                          persistHandle(
                            derivePendingApprovals(thread.activities)[0]?.requestId ??
                              derivePendingUserInputs(thread.activities)[0]?.requestId ??
                              null,
                          ),
                        ),
                      ),
                  ),
                ),
              ),
              Effect.ignore,
            ),
          ),
          Effect.forkScoped,
        );

        // Wait for the turn to reach a terminal state.
        const outcome = yield* observation.completion;
        yield* Console.log(
          `[feishu-bot] turn ${outcome.kind} on thread ${threadId}` +
            (outcome.kind === "failed" ? ` (status=${outcome.status}).` : "."),
        );

        // Final card render from the fold's authoritative state. By now the turn has
        // completed and `finalThread.session.activeTurnId` is null, so we pass the
        // captured `currentTurnId` to keep the terminal card scoped to *this* turn's
        // tools/reasoning/error/body (otherwise the whole thread's history would
        // surface).
        const finalThread = yield* observation.current;
        if (finalThread !== null) {
          const interaction = yield* buildInteraction(chatId, finalThread, operatorOverride);
          const currentTurnId = yield* Ref.get(currentTurnIdRef);
          // M-3 PR-C3: resolve density from the REAL terminal thread's runtimeMode
          // (same p2p-safe overlay as the per-tick render) for the stable final card.
          const density = yield* resolveDensity(chatId, finalThread.runtimeMode);
          yield* handle
            .update(
              renderThreadCard(finalThread, {
                streaming: false,
                currentTurnId,
                density,
                ...(interaction ? { interaction } : {}),
              }).card,
            )
            .pipe(Effect.ignore);
          // #2: top open request (approval first, then user-input) so a turn that
          // ends paused on a user-input prompt persists a non-null requestId and is
          // recoverable across a restart (M18 skips null-pendingRequestId handles).
          yield* persistHandle(
            derivePendingApprovals(finalThread.activities)[0]?.requestId ??
              derivePendingUserInputs(finalThread.activities)[0]?.requestId ??
              null,
          );
        }
      });

    // ── M2b-3: cross-end observe fiber (mirror a takeover's running turn) ────────
    //
    // Resident fiber that opens its OWN streaming card and mirrors `threadId`'s
    // current turn onto it via the shared `renderObservationToCard`, until the turn
    // reaches a terminal state. Unlike `driveTurn`, it dispatches NOTHING and touches
    // the turn queue NOT AT ALL — it is pure observation (the bridge is mirroring a
    // turn another end started, e.g. on web/terminal, after a `/resume` takeover, or
    // a follow-on turn web starts while the chat is taken over).
    //
    // Self-contained child scope (`Effect.scoped`): `observeThread`'s fold loop is
    // `forkScoped` onto THIS scope, so interrupting this fiber (via `stopObserve` /
    // root-scope teardown) closes the child scope → interrupts the fold → unsubscribes
    // the thread (no leaked subscription). `renderObservationToCard`'s per-tick
    // updater is likewise `forkScoped` here and torn down on completion/interrupt.
    //
    // Robustness: NOTHING inside may crash the bot. `startStreamingCard` failure is
    // caught (warn) and skips the render (the observe fiber just exits — the watcher
    // re-triggers `ensureObserving` on the next frame if the turn is still running);
    // `handle.update` is already `Effect.ignore` inside the helper; any residual
    // defect is `catchCause`'d so the forked fiber always succeeds (`E = never`).
    //
    // Self-eviction: the body has an `Effect.ensuring` finalizer that, on EVERY exit
    // (success / interrupt / defect), removes this chat's registry entry IFF it still
    // carries OUR `token`. Keying on the unique per-attempt token (not a fiber
    // reference) makes eviction immune to claim→install timing: even a turn already
    // terminal at fork time evicts exactly its own claim, and a preempting
    // `driveTurn`/`ensureObserving` that installed a newer entry (different token) is
    // never clobbered. Forked into `rootScope` so the observe outlives the triggering
    // message fiber (the takeover turn runs long after `/resume` returns) yet tears
    // down on bridge shutdown.
    const runObserveFiber = (
      chatId: string,
      threadId: ThreadId,
      token: number,
    ): Effect.Effect<Fiber.Fiber<void>, never, never> => {
      const body: Effect.Effect<void> = Effect.scoped(
        Effect.gen(function* () {
          const observation = yield* observeThread(threadId, { subscribe: subscribeThread });

          // Bug D — turn already over before the new subscription's first frame:
          // `ensureObserving` triggered us because a snapshot/shellCache frame
          // showed `activeTurnId != null`, but the turn can finish in the gap
          // between that decision and this fresh subscription's first folded
          // frame. If so, `observeThread`'s `turnObserved` latch never sets (it
          // only ever sees a null `activeTurnId`), so `completion` would NOT resolve
          // until the 10-min TURN_TIMEOUT — the observe card would hang empty in
          // streaming state, this fiber would never self-evict, and `isObserving`
          // would suppress 修法 A/B for ~10min. Wait for the fold's FIRST
          // authoritative frame (`current` is `null` until the replayed snapshot
          // lands — the fold loop is `forkScoped`, so it has not necessarily run by
          // the time `observeThread` returns; poll until non-null, bounded so a
          // never-delivering subscription can't pin us). If that first frame's
          // `activeTurnId` is already null, the turn is over — exit immediately (no
          // card opened, fiber self-evicts) rather than long-waiting `completion`.
          // Safe precisely because we only triggered on `activeTurnId != null`: a
          // null first frame here confirms the turn ended in the trigger→subscribe
          // gap. (TURN_TIMEOUT stays the backstop for a turn that genuinely runs
          // then wedges.) A read timeout just falls through to the normal path.
          const firstCurrent = yield* observation.current.pipe(
            Effect.repeat({
              until: (thread) => thread !== null,
              schedule: Schedule.spaced(Duration.millis(50)),
            }),
            Effect.timeoutOrElse({
              duration: Duration.seconds(10),
              orElse: () => Effect.succeed(null as OrchestrationThread | null),
            }),
          );
          if (firstCurrent !== null && firstCurrent.session?.activeTurnId == null) {
            return;
          }

          // ── M2b-3: ADOPT an already-recovered approval card (reuse-card) ─────────
          // When a resumed chat was blocked on an approval at restart, M18 recovery
          // (`recoverApprovalCards`) re-rendered that approval onto the EXISTING card
          // (`existing.messageId`) and persisted a handle with that request id +
          // operator. If that SAME request is still live-pending in this fold's first
          // authoritative frame, opening a fresh streaming card would post a SECOND
          // card for it (and `persistHandle(null)` would clobber the durable handle's
          // operator → dead buttons). Instead ADOPT: keep rendering onto the recovered
          // `messageId` via `updateCard`, re-signing the approval for the operator
          // captured on the handle (the `chatOperators` Ref is empty right after a
          // restart — same as M18). A STALE handle from an old turn whose request is
          // NOT in this thread's live-pending set is ignored → we fall through and open
          // a fresh card (no mis-adoption). The adopt path has NO streaming producer,
          // so it creates NO `cardDone` (a dangling `cardDone` would never resolve).
          const livePending = new Set<string>([
            ...(firstCurrent === null ? [] : derivePendingApprovals(firstCurrent.activities)).map(
              (a) => a.requestId,
            ),
            ...(firstCurrent === null ? [] : derivePendingUserInputs(firstCurrent.activities)).map(
              (u) => u.requestId,
            ),
          ]);
          const existing = yield* cardHandles
            .get(chatId)
            .pipe(Effect.orElseSucceed(() => Option.none<CardHandle>()));

          // Operator fallback shared by BOTH render branches (adopt AND fresh card).
          // The live `chatOperators` Ref is the authoritative source while the bot has
          // seen an inbound/`/resume` for this chat — but it is EMPTY right after a
          // restart, even though a durable handle may still carry the operator who
          // triggered the recovered (M18) card. When the Ref has this chat, pass
          // `undefined` so `buildInteraction` resolves from the Ref (live behaviour
          // unchanged); when it does not, fall back to the persisted handle's
          // `operatorOpenId` so an approval that surfaces post-restart is still signed
          // for the recovered operator instead of an empty open id (dead buttons). The
          // fresh-card branch previously passed NO override, so on a restart where
          // observe lost the adopt race (the first live-pending request already
          // resolved) its approval buttons would dead-end — this fallback fixes that.
          const liveOperators = yield* Ref.get(chatOperators);
          const operatorFallback = liveOperators.has(chatId)
            ? undefined
            : Option.isSome(existing) && existing.value.operatorOpenId.length > 0
              ? existing.value.operatorOpenId
              : undefined;

          if (
            Option.isSome(existing) &&
            existing.value.messageId.length > 0 &&
            existing.value.pendingRequestId !== null &&
            livePending.has(existing.value.pendingRequestId)
          ) {
            // Adopt: a static handle that patches the recovered card in place. No
            // streaming producer ⇒ no `cardDone`. `updateCard` failures are swallowed
            // (a bad patch must never crash the observe fiber); the operator override
            // (handle's captured operator, falling back to the live Ref when present)
            // re-signs the approval so its buttons verify across the restart.
            const recovered = existing.value;
            const adoptHandle: StreamingCard = {
              messageId: recovered.messageId,
              update: (card) => gateway.updateCard(recovered.messageId, card).pipe(Effect.ignore),
            };
            yield* renderObservationToCard(
              chatId,
              threadId,
              observation,
              adoptHandle,
              operatorFallback,
            );
            return;
          }

          // Bug B — `cardDone` must resolve on EVERY exit of this whole block, not
          // just around `renderObservationToCard`: the SDK streaming producer
          // (`startStreamingCard`'s `done`) parks on `Deferred.await(cardDone)`, so
          // any exit that opened the card but left `cardDone` unresolved — a
          // `Fiber.interrupt` (all four `stopObserve` sites) landing in/after
          // `startStreamingCard` but before the inner render-`ensuring`, or the
          // `handle === null` early return — would leave the producer parked forever
          // (card stuck streaming). Mirror `driveTurn`: create `cardDone`, then wrap
          // the start→handle-check→render block in a single `Effect.ensuring` that
          // resolves it on success / failure / interrupt / early return alike.
          const cardDone = yield* Deferred.make<void>();
          yield* Effect.gen(function* () {
            // Open this observe fiber's own streaming card; its producer settles when
            // the turn reaches a terminal state (the `cardDone` released below). A
            // failed start must NOT crash the fiber — skip the render and exit; the
            // watcher re-triggers on the next frame if the turn is still running.
            // M-3 PR-C3: resolve the placeholder first-frame density through the same
            // per-chat > binding > runtime overlay the real frames use, so a per-chat
            // override matches from the very first frame (no card→low-noise jump). The
            // binding read below still supplies the topic reply anchor.
            const binding = yield* bindings.get(chatId);
            const placeholderDensity = yield* resolveDensity(chatId, placeholderThread.runtimeMode);
            const initial = renderThreadCard(placeholderThread, {
              streaming: true,
              density: placeholderDensity,
            }).card;
            // M3b: an observe fiber mirrors a turn another end started (no triggering
            // message for this end), so anchor its fresh card inside the topic via the
            // binding's stored `topicAnchorMessageId` when present; `topicSendOpts`
            // degrades to a root post for p2p / plain group / no stored anchor.
            const { chatId: realChatId, larkThreadId } = splitChatKey(chatId);
            const sendOpts = topicSendOpts(larkThreadId, binding?.topicAnchorMessageId);
            const card = yield* gateway
              .startStreamingCard(realChatId, initial, { done: Deferred.await(cardDone) }, sendOpts)
              .pipe(
                Effect.tapError((error) =>
                  Console.error(
                    `[feishu-bot] observe streaming card failed to start for chat ${chatId}: ${error.message}`,
                  ),
                ),
                Effect.option,
              );
            const handle = Option.isSome(card) ? card.value : null;
            if (handle === null) {
              return;
            }
            yield* renderObservationToCard(chatId, threadId, observation, handle, operatorFallback);
          }).pipe(
            // Always release the SDK producer so the card settles into its terminal
            // (non-streaming) form instead of parking forever (mirrors `driveTurn`).
            Effect.ensuring(Deferred.succeed(cardDone, undefined)),
          );
        }),
      ).pipe(
        // No observe failure/defect may crash the bot; the fiber always succeeds.
        Effect.catchCause((cause) =>
          Effect.logWarning(`[feishu-bot] observe fiber failed for chat ${chatId}.`, cause),
        ),
        // Self-evict by token on every exit (see the block comment above).
        Effect.ensuring(
          Ref.update(activeRenderFibers, (map) => {
            const existing = map.get(chatId);
            if (existing === undefined || existing.token !== token) {
              return map;
            }
            const next = new Map(map);
            next.delete(chatId);
            return next;
          }),
        ),
      );

      return Effect.forkIn(body, rootScope);
    };

    return {
      startMirror,
      isObserving,
      stopObserve,
      stopMirror,
      ensureObserving,
      surfacePendingApprovalIfNew,
      renderObservationToCard,
    } as const;
  });
