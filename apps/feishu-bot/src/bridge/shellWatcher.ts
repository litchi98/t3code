/**
 * Shell watcher (M2a): the bridge's single reverse-notification + reconciliation
 * fiber.
 *
 * Lazy sync means the bridge subscribes to *no* thread by default; it stays
 * silent until a user `/resume`s one. But two things must still reach the user
 * even for a chat that is only loosely bound (notably an `origin: "resumed"`
 * takeover) and is not actively mirroring:
 *
 *   1. **Reconciliation (M10).** Terminal/Web can `delete`/`archive` a thread a
 *      Feishu chat is bound to. `subscribeShell` surfaces that (the thread drops
 *      out of the snapshot, or gains a non-null `archivedAt`); without it the
 *      chat is left permanently pointing at a dead thread. On detection we
 *      unbind, tear down any mirror, and tell the user to `/resume` again.
 *
 *   2. **Key notifications (blind-spot B).** For chats that have taken a thread
 *      over (`origin === "resumed"`), surface the moments that need a human even
 *      when the bridge is not live-mirroring: a *new* pending approval (rising
 *      edge) and a turn that ends in a notable terminal — a *failure* (`error`)
 *      or an *interrupt* from another end (`interrupted`), each with its own
 *      text. Ordinary streaming output is still never pushed.
 *
 * Both consume the *same* `shellCache.changes` fold — one fiber, one traversal
 * over the snapshot stream — rather than two independent subscriptions.
 *
 * ── Why per-thread/per-turn memory, NOT frame-to-frame diff ──────────────────
 * On reconnect the underlying `subscribeShell` replays a full snapshot (the
 * `snapshotSequence` jumps). A "did this change vs. the previous frame?" diff
 * would then see every still-pending approval as a fresh rising edge and
 * re-spam the user. So dedup is keyed on stable identity: a per-`ThreadId`
 * record of whether we have already notified for the current pending-approval
 * episode, and the last announced notable `turnId`. The approval flag is
 * cleared on the *falling* edge (`hasPendingApprovals` → false) so the next
 * genuine approval re-notifies; the turn dedup is keyed by `turnId` so a later,
 * distinct turn still notifies.
 *
 * That memory is process-local, so a cold (re)start would otherwise replay state
 * that already existed before the restart (a still-pending approval, an
 * already-failed latest turn) as fresh edges. The *first* frame this fiber
 * processes therefore SEEDS the per-`ThreadId` baseline from the current shell
 * without emitting any notice; only subsequent frames notify on edges relative to
 * it. The memory is also dropped on the discrete `/release` / unbind lifecycle
 * events (see `clearNoticeMemory`) so a later `/resume` of the same thread
 * re-evaluates from scratch — neither of these is a return to per-frame diffing.
 *
 * This module folds `shellCache.changes` and reads each bound thread's
 * {@link OrchestrationThreadShell} out of the latest snapshot. It never derives
 * shell state itself (that is `shellCache`'s job) and performs the actual unbind
 * / mirror-teardown / notice send through injected hooks so it stays decoupled
 * from `bindingState`'s and the gateway's concrete shapes.
 */
import type { OrchestrationThreadShell, ThreadId, TurnId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import type { BindingState, ChatBinding } from "./bindingState.ts";
import type { ShellSnapshotCache } from "./shellCache.ts";
import { NoticeMemoryStore } from "../runtime/persistence.ts";

/**
 * The binding-state service *shape* (its read/write surface). `BindingState` is
 * the `Context.Service` tag; `BindingState["Service"]` is the value it provides —
 * the in-memory binding view (`get`/`bind`/`unbind`/`entries`) this watcher reads.
 */
type BindingStateService = BindingState["Service"];

/**
 * Notable turn terminals for a thread's latest turn. `OrchestrationLatestTurn.state`
 * is one of `running | interrupted | completed | error`; `completed` is success
 * and `running` is in-flight, so the two terminals worth surfacing are `error`
 * (the run failed) and `interrupted` (another end stopped the turn). Both are
 * deduped by `turnId`, but they get *distinct* notice text so an operator-driven
 * interrupt from another end is not mis-reported as a failure.
 */
const noticeTurnState = (
  state: OrchestrationThreadShell["latestTurn"],
): "error" | "interrupted" | null =>
  state === null
    ? null
    : state.state === "error" || state.state === "interrupted"
      ? state.state
      : null;

/** Per-thread dedup memory (keyed by stable identity, never by frame diff). */
interface NoticeMemory {
  /**
   * Whether we have already pushed a notice for the *current* pending-approval
   * episode. Set true on the rising edge, reset to false on the falling edge so
   * the next genuine pending approval re-notifies.
   */
  readonly approvalNotified: boolean;
  /** The last failed `turnId` we announced, for per-turn dedup. `null` = none. */
  readonly lastFailedTurnId: string | null;
}

const EMPTY_MEMORY: NoticeMemory = { approvalNotified: false, lastFailedTurnId: null };

/** Dependencies the shell watcher needs, injected by Integrate. */
export interface ShellWatcherDeps {
  /**
   * The resident lightweight shell cache (a folded `subscribeShell`). The
   * watcher consumes `changes` and reads bound threads out of the latest
   * snapshot via `threadById`.
   */
  readonly shellCache: ShellSnapshotCache;
  /**
   * The chat↔thread binding state. The watcher reads `entries` each frame and
   * calls `unbind` on reconciliation. `unbind` is idempotent. Typed as the
   * service *shape* ({@link BindingState}`["Service"]`) so it can be supplied
   * either from the resolved tag or as a plain object.
   */
  readonly bindings: BindingStateService;
  /**
   * Tear down any live mirror for `chatId` (subscription fiber / card handle /
   * candidate cache). Under mirror-light this is usually a candidate-cache
   * clear or a no-op, but the hook is kept for symmetry with `/release`.
   */
  readonly stopMirror: (chatId: string) => Effect.Effect<void>;
  /** Push a single plain-text notice card to `chatId`. */
  readonly sendNotice: (chatId: string, text: string) => Effect.Effect<void>;
  /**
   * Surface a *new* pending approval/user-input on `threadId` as an actionable card
   * in `chatId`, if one is pending that Feishu has not already rendered a card for
   * (M2b-2 修法 B). Injected by the bot so the watcher stays decoupled from the
   * gateway / card-render / `CardHandle` concretes.
   *
   * It is the bot's `surfacePendingApprovalIfNew`: a one-shot thread-snapshot read
   * that derives the *top* pending requestId, dedups against the persisted
   * `CardHandle.pendingRequestId` (the single source of truth for "already
   * surfaced"), and only sends + persists a new card on a genuinely new request.
   * That requestId-keyed dedup is what makes calling this on *every* frame the
   * resumed thread is `hasPendingApprovals` safe — the same approval pending across
   * many frames is surfaced exactly once; a later, distinct approval re-surfaces.
   *
   * The effect handles its own robustness (`catchCause` → warn) and never fails, but
   * the watcher still wraps the call so a surface attempt can never wedge or starve
   * the shared reconciliation/notification fold.
   */
  readonly surfacePendingApproval: (chatId: string, threadId: ThreadId) => Effect.Effect<void>;
  /**
   * Start (or no-op) a resident cross-end observe fiber that live-mirrors a running
   * turn on `threadId` onto a Feishu card in `chatId`, until it ends (M2b-3). The
   * watcher calls this for a `resumed` binding whose shell shows a turn running
   * (`session.activeTurnId`), so a turn web/terminal starts *after* the takeover —
   * which 修法 A/B never see (they only surface pending approvals) — is mirrored too.
   *
   * It is the bot's `ensureObserving`: its own gates (skip when `activeTurnId` is
   * null, skip when the bridge is driving this chat's own turn, skip when an
   * outstanding approval card already exists, and an atomic dedup+claim keyed on the
   * chat's PRESENCE in the observe registry — self-evicting on exit) make calling it
   * on EVERY frame the resumed thread is running safe. Dedup is per-chatId, NOT
   * per-turn: at most one observe fiber/card per chat, and a chat's consecutive turns
   * reuse it — a chained A→B turn that never shows `activeTurnId === null` between the
   * two keeps being mirrored onto the same card (continuous mirror), and B's call here
   * is simply deduped out. A fresh observe is only started after the prior one self-
   * evicts (turn reached a terminal state). Decoupled from the gateway/observe
   * concretes.
   */
  readonly ensureObserving: (
    chatId: string,
    threadId: ThreadId,
    activeTurnId: TurnId | null,
  ) => Effect.Effect<void>;
  /**
   * Persistent store for per-thread notice dedup state. Replaces the
   * process-local `Ref<Map>` so dedup survives a bot restart: a cold (re)start
   * no longer re-sends notifications for events that were already delivered
   * before the restart. Supplied by the caller (already included in
   * `fileStoresLayer`, so no extra `provide` call is needed at the call site).
   */
  readonly noticeMemoryStore: NoticeMemoryStore["Service"];
}

/** Handle returned by {@link runShellWatcherFiber}. */
export interface ShellWatcherHandle {
  /**
   * Fork the reconciliation/notification fold loop into the caller's scope. This
   * is split out from constructing the handle so the caller controls *when* the
   * loop starts relative to the rest of startup.
   *
   * The bot defers this until AFTER its M18 restart-recovery pass has run (and
   * after the gateway is connected): recovery updates each chat's
   * `CardHandle.pendingRequestId` (the single-source dedup baseline) on the main
   * fiber, so by the time the watcher's first frame lands the baseline is already
   * in place and the watcher's `surfacePendingApproval` dedups against it instead
   * of racing recovery to post a second card. The handle (and its
   * {@link clearNoticeMemory}) is available immediately — only the fold is
   * deferred — so the command table can wire `/release` before the loop starts.
   *
   * Idempotency is the caller's responsibility (call exactly once).
   */
  readonly start: Effect.Effect<void, never, Scope.Scope>;
  /**
   * Drop the per-thread dedup memory for `threadId`. Called on the discrete
   * `/release` / unbind lifecycle events so a later `/resume` of the same thread
   * re-evaluates its key notifications from scratch (re-pushing an existing
   * pending approval, etc.) instead of being suppressed by stale dedup state.
   * This is a deliberate, event-driven reset — NOT a return to per-frame diffing.
   */
  readonly clearNoticeMemory: (threadId: ThreadId) => Effect.Effect<void>;
}

/**
 * Construct the shell watcher. Returns a {@link ShellWatcherHandle} whose
 * {@link ShellWatcherHandle.start} forks the reconciliation/notification fold
 * loop into the caller's scope (it runs until the scope closes — the surrounding
 * `subscribeShell` is torn down with it). The fold never fails: a notice /
 * unbind / mirror-teardown error for one binding is logged and swallowed so it
 * cannot wedge the shared fold loop or starve other bindings.
 *
 * The loop is NOT forked here; the caller invokes `start` once it is ready (the
 * bot does so after M18 restart-recovery so the dedup baseline is already set —
 * see {@link ShellWatcherHandle.start}). The handle and its
 * {@link ShellWatcherHandle.clearNoticeMemory} are usable immediately.
 *
 * Constructing the handle needs no `Scope` (the fork moved into `start`); only
 * `start` requires the caller's `Scope`.
 */
export const runShellWatcherFiber = (deps: ShellWatcherDeps): Effect.Effect<ShellWatcherHandle> =>
  Effect.gen(function* () {
    const store = deps.noticeMemoryStore;

    // Cold-start guard. On the *first* frame this fiber processes, we cannot tell
    // a genuinely-new approval/failed turn from state that already existed before
    // the bot restarted: the dedup memory is process-local and starts empty, so
    // without this every still-pending approval and every already-failed turn
    // would re-notify once per restart. The first frame therefore *seeds* the
    // per-thread baseline from the current shell (no notices) and only subsequent
    // frames notify on edges relative to that baseline.
    const firstFrame = yield* Ref.make(true);

    /** One reconciliation/notification pass over the current snapshot. */
    const onFrame = Effect.gen(function* () {
      const snapshot = yield* deps.shellCache.current;
      // No snapshot yet (pre-first-frame): nothing to reconcile against. Do NOT
      // consume the cold-start flag yet — wait for an actual snapshot to seed from.
      if (snapshot === null) {
        return;
      }
      const isFirstFrame = yield* Ref.getAndSet(firstFrame, false);
      // M3a: each entry's key is the bridge's composite `chatId[:larkThreadId]`
      // (a topic backs its own binding). This watcher treats it as an OPAQUE
      // conversation id and never splits it: every dep it forwards the key to
      // (`bindings.unbind` / `stopMirror` / `surfacePendingApproval` /
      // `ensureObserving` are all keyed by the same composite id; `sendNotice`
      // splits it back to the real Feishu chatId internally), so per-topic
      // reconciliation/notification falls out for free. For p2p / plain group the
      // key is the bare chatId (no `:`), so behaviour is byte-identical to pre-M3a.
      const entries = yield* deps.bindings.entries;
      yield* Effect.forEach(
        entries,
        ([chatId, binding]) => reconcileBinding(chatId, binding, isFirstFrame),
        { discard: true },
      );
    });

    const reconcileBinding = (chatId: string, binding: ChatBinding, isFirstFrame: boolean) =>
      Effect.gen(function* () {
        // Read the shell once — shared between the self-created fast path and the
        // full resumed path below.
        const shell = yield* deps.shellCache.threadById(binding.threadId);

        // ── Scope gate: takeovers only (with M3a self-created observe exception) ──
        // The watcher exists primarily for `origin: "resumed"` takeovers — chats
        // loosely bound to a thread another end drives. A `self-created` binding
        // is the bridge's *own* live-driven thread: the turn pipeline owns its
        // lifecycle, so the watcher must NOT touch reconciliation or notifications
        // for it. Reconciling a self-created binding (unbind on deleted/archived)
        // would send the chat back through `ensureThread`'s self-create path,
        // which deterministically re-derives the same threadId and slams into the
        // server's soft-delete tombstone (`requireThreadAbsent`) → endless outbound
        // retry that wedges the chat.
        //
        // M3a exception: a bot-driven group turn can spawn a server-side subagent
        // (e.g. planner → executor). The executor turn surfaces in
        // `shell.session.activeTurnId` but is NOT driven by this bot's driveTurn
        // pipeline — it is a server-spawned subagent whose pending approvals must
        // still reach Feishu. We call `ensureObserving` here so the subagent turn
        // is mirrored and its approval cards surface. Safety is preserved:
        //   • `isChatBusy` inside ensureObserving → no-op while driveTurn is active
        //   • atomic per-chat dedup → at most one observe fiber/card per chat
        // Reconciliation and key notifications remain resumed-only (no change there).
        if (binding.origin !== "resumed") {
          if (shell?.session?.activeTurnId != null) {
            yield* deps
              .ensureObserving(chatId, binding.threadId, shell.session.activeTurnId)
              .pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning(
                    "[feishu-bot] shellWatcher ensureObserving (self-created) failed",
                    cause,
                  ),
                ),
              );
          }
          return;
        }

        // ── Reconciliation (M10) ──────────────────────────────────────────
        // Thread gone from the snapshot (deleted) or archived → the binding is
        // dangling. Unbind (idempotent), tear down any mirror, tell the user.
        if (shell === null || shell.archivedAt !== null) {
          yield* deps.bindings.unbind(chatId);
          yield* deps.stopMirror(chatId);
          yield* deps.sendNotice(chatId, "⚠️ 你接管的会话已被删除/归档,请用 /resume 重新选择");
          // Drop dedup memory so a future thread reusing this id starts clean.
          // Best-effort: a persistence failure must not abort the unbind/notify
          // work already done above (unbind + stopMirror + sendNotice succeeded).
          yield* store.remove(binding.threadId).pipe(Effect.ignore);
          return;
        }

        // ── Cold-start baseline seed ──────────────────────────────────────
        // First frame: record the current state as the baseline WITHOUT emitting
        // any notice, so state that already existed before this (re)start is not
        // replayed as a fresh edge. Subsequent frames notify relative to it.
        // With the persistent store a genuinely-cold restart (no stored state)
        // still seeds; a warm restart (stored state already present) skips the
        // seed so the persisted record is preserved as-is and dedup continues.
        if (isFirstFrame) {
          const existing = yield* store.get(binding.threadId);
          if (Option.isNone(existing)) {
            const latestTurn = shell.latestTurn;
            const baseline: NoticeMemory = {
              approvalNotified: shell.hasPendingApprovals,
              lastFailedTurnId:
                noticeTurnState(latestTurn) !== null && latestTurn !== null
                  ? (latestTurn.turnId as string)
                  : null,
            };
            // Best-effort: a seed-write failure is non-fatal — the worst
            // outcome is a single duplicate notice on the next restart; the
            // frame still returns cleanly so the binding is not wedged.
            yield* store.put(binding.threadId, baseline).pipe(Effect.ignore);
          }
          return;
        }

        // ── Key notifications (blind-spot B) ──────────────────────────────
        const prior = Option.getOrElse(yield* store.get(binding.threadId), () => EMPTY_MEMORY);
        const title = shell.title;

        // ① Pending-approval episode tracking (M2b-1: notice SUPPRESSED).
        // The interaction card is now the in-Feishu approval entry point (live
        // [允许]/[拒绝] buttons rendered by the turn pipeline), so the old M2a
        // "请在终端/Web 处理" standalone notice is obsolete and redundant — we no
        // longer push it. We STILL track the rising/falling edge in `NoticeMemory`
        // (set on rising edge, reset on falling edge) purely to keep the dedup
        // state consistent for the cold-start baseline seed and `/release` reset;
        // only the user-facing `sendNotice` call is removed.
        const approvalNotified = shell.hasPendingApprovals;

        // ── M2b-3: live-mirror a turn web/terminal started AFTER the takeover ──────
        // The user accepted "也纳入接管后 web 又起的新 turn 也要镜像": once a chat is
        // taken over, a turn another end starts later must be mirrored just like the
        // one that was running at takeover. 修法 A/B only surface *pending approvals*;
        // they never mirror a turn's progress/result. This resident fiber is the one
        // observer of the resumed thread's shell, so whenever it shows a turn running
        // (`session.activeTurnId`) we hand off to `ensureObserving`, which forks a
        // cross-end observe card (and no-ops if already observing / if the bridge is
        // driving this chat's own turn / if an outstanding approval card already
        // exists). Its atomic dedup is keyed on the chat's PRESENCE in the observe
        // registry (NOT per-turn), with the fiber self-evicting on exit, so calling it
        // on every running frame is safe — one observe fiber/card per chat, reused
        // across a chat's consecutive turns (continuous mirror); a fresh one starts
        // only after the prior self-evicts. Best-effort: `ensureObserving` never
        // fails, but wrap defensively so it cannot break this frame.
        if (shell.session?.activeTurnId != null) {
          yield* deps
            .ensureObserving(chatId, binding.threadId, shell.session.activeTurnId)
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("[feishu-bot] shellWatcher ensureObserving failed", cause),
              ),
            );
        }

        // M2b-2 (修法 B): surface follow-on / chained approvals AND user-inputs for a
        // resumed thread. After a `/resume` takeover the bridge is NOT live-mirroring,
        // so an approval/user-input the turn raises *after* the first one (approve #1 →
        // turn continues → #2, or the turn pauses on a user-input prompt) is invisible
        // to Feishu — 修法 A only surfaced what was pending at takeover. This resident
        // fiber is the one observer that still sees the resumed thread's shell, so when
        // it shows EITHER a pending approval or a pending user-input we hand off to the
        // bot's `surfacePendingApproval`, which does a one-shot snapshot read and
        // surfaces a fresh actionable card *only if it is a new request* (dedup against
        // the persisted `CardHandle.pendingRequestId`). The same request pending across
        // many frames is therefore surfaced once.
        //
        // READ-ONLY GATE: only call when `hasPendingApprovals` OR `hasPendingUserInput`
        // is true, so a thread with nothing pending never triggers the (relatively
        // costly) one-shot snapshot read — the cheap shell flags gate the expensive
        // read; the requestId dedup inside the helper then gates the actual card send.
        // (修法 A in `startMirror` calls the helper unconditionally and already surfaces
        // user-input correctly; this gate is the only path that previously dropped it
        // by checking `hasPendingApprovals` alone.)
        //
        // Best-effort: `surfacePendingApproval` already swallows its own failures, but
        // wrap the call so even an unexpected defect cannot break this frame's
        // reconciliation / turn-terminal notice / dedup-write below.
        if (shell.hasPendingApprovals || shell.hasPendingUserInput) {
          yield* deps
            .surfacePendingApproval(chatId, binding.threadId)
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("[feishu-bot] shellWatcher surfacePendingApproval failed", cause),
              ),
            );
        }

        // ② Latest turn in a notable terminal (error / interrupted), deduped by
        // turnId. Distinct text per state so an interrupt from another end is not
        // mis-reported as a failure.
        let lastFailedTurnId = prior.lastFailedTurnId;
        const latestTurn = shell.latestTurn;
        const turnState = noticeTurnState(latestTurn);
        if (turnState !== null && latestTurn !== null) {
          const turnId = latestTurn.turnId as string;
          if (turnId !== prior.lastFailedTurnId) {
            yield* deps.sendNotice(
              chatId,
              turnState === "interrupted"
                ? `⏹️ 会话 ${title} 的运行已被中断`
                : `❌ 会话 ${title} 的一次运行失败`,
            );
            lastFailedTurnId = turnId;
          }
        }

        // Best-effort: a write failure must not abort the frame or suppress
        // a notice that was already sent — the next frame retries the write.
        yield* store
          .put(binding.threadId, { approvalNotified, lastFailedTurnId })
          .pipe(Effect.ignore);
      }).pipe(
        // One binding's IO failure must not wedge the shared fold or starve its
        // peers; log and move on (the next frame retries).
        Effect.catchCause((cause) =>
          Effect.logWarning("[feishu-bot] shellWatcher binding failed", cause),
        ),
      );

    // Single fold over `shellCache.changes`; forked into the caller's scope so it
    // is interrupted when the resident shell subscription is torn down. Deferred
    // into `start` (not forked at construction) so the caller controls when the
    // loop begins — the bot starts it AFTER M18 restart-recovery has seeded the
    // per-chat dedup baseline (see {@link ShellWatcherHandle.start}).
    const start: Effect.Effect<void, never, Scope.Scope> = deps.shellCache.changes.pipe(
      Stream.runForEach(() => onFrame),
      Effect.forkScoped,
      Effect.asVoid,
    );

    // Discrete lifecycle reset (NOT per-frame): drop a thread's dedup memory so a
    // future `/resume` of the same thread re-evaluates its notices from scratch.
    // Now delegates to the persistent store so the reset survives a bot restart.
    const clearNoticeMemory = (threadId: ThreadId): Effect.Effect<void> =>
      store
        .remove(threadId)
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("[feishu-bot] clearNoticeMemory store.remove failed", cause),
          ),
        );

    return { start, clearNoticeMemory } satisfies ShellWatcherHandle;
  });
