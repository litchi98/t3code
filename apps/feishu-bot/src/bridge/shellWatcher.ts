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
import type { OrchestrationThreadShell, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import type { BindingState, ChatBinding } from "./bindingState.ts";
import type { ShellSnapshotCache } from "./shellCache.ts";

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
}

/** Handle returned by {@link runShellWatcherFiber}. */
export interface ShellWatcherHandle {
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
 * Fork the shell-watcher loop into the caller's scope. It runs until the scope
 * closes (the surrounding `subscribeShell` is torn down with it). Never fails:
 * a notice / unbind / mirror-teardown error for one binding is logged and
 * swallowed so it cannot wedge the shared fold loop or starve other bindings.
 *
 * Returns a {@link ShellWatcherHandle} so the `/release` / unbind paths can clear
 * a thread's dedup memory (see {@link ShellWatcherHandle.clearNoticeMemory}).
 */
export const runShellWatcherFiber = (
  deps: ShellWatcherDeps,
): Effect.Effect<ShellWatcherHandle, never, Scope.Scope> =>
  Effect.gen(function* () {
    // Per-thread dedup memory. Keyed by `ThreadId` (stable identity) so a
    // reconnect's full-snapshot replay does not re-trigger notifications.
    const memory = yield* Ref.make<Map<ThreadId, NoticeMemory>>(new Map());

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
      const entries = yield* deps.bindings.entries;
      yield* Effect.forEach(
        entries,
        ([chatId, binding]) => reconcileBinding(chatId, binding, isFirstFrame),
        { discard: true },
      );
    });

    const reconcileBinding = (chatId: string, binding: ChatBinding, isFirstFrame: boolean) =>
      Effect.gen(function* () {
        // ── Scope gate: takeovers only ────────────────────────────────────
        // The watcher exists for `origin: "resumed"` takeovers — chats loosely
        // bound to a thread another end drives. A `self-created` binding is the
        // bridge's *own* live-driven thread: the turn pipeline already owns its
        // lifecycle, so the watcher must NOT touch it. Reconciling a self-created
        // binding here (unbind on a deleted/archived snapshot) sends the chat back
        // through `ensureThread`'s self-create path, which deterministically
        // re-derives the *same* threadId and slams into the server's soft-delete
        // tombstone (`requireThreadAbsent`) → endless outbound retry that wedges
        // the chat. Gate the *entire* pass (reconciliation + key notifications)
        // on `resumed` so self-created bindings are left untouched (= the M1,
        // watcher-less behaviour). Also keeps the "你接管的会话…" notice text
        // truthful — it only fires for genuinely taken-over chats.
        if (binding.origin !== "resumed") {
          return;
        }

        const shell = yield* deps.shellCache.threadById(binding.threadId);

        // ── Reconciliation (M10) ──────────────────────────────────────────
        // Thread gone from the snapshot (deleted) or archived → the binding is
        // dangling. Unbind (idempotent), tear down any mirror, tell the user.
        if (shell === null || shell.archivedAt !== null) {
          yield* deps.bindings.unbind(chatId);
          yield* deps.stopMirror(chatId);
          yield* deps.sendNotice(chatId, "⚠️ 你接管的会话已被删除/归档,请用 /resume 重新选择");
          // Drop dedup memory so a future thread reusing this id starts clean.
          yield* Ref.update(memory, (m) => {
            const next = new Map(m);
            next.delete(binding.threadId);
            return next;
          });
          return;
        }

        // ── Cold-start baseline seed ──────────────────────────────────────
        // First frame: record the current state as the baseline WITHOUT emitting
        // any notice, so state that already existed before this (re)start is not
        // replayed as a fresh edge. Subsequent frames notify relative to it.
        if (isFirstFrame) {
          const latestTurn = shell.latestTurn;
          const baseline: NoticeMemory = {
            approvalNotified: shell.hasPendingApprovals,
            lastFailedTurnId:
              noticeTurnState(latestTurn) !== null && latestTurn !== null
                ? (latestTurn.turnId as string)
                : null,
          };
          yield* Ref.update(memory, (m) => new Map(m).set(binding.threadId, baseline));
          return;
        }

        // ── Key notifications (blind-spot B) ──────────────────────────────
        const prior = (yield* Ref.get(memory)).get(binding.threadId) ?? EMPTY_MEMORY;
        const title = shell.title;

        // ① Pending-approval rising edge: notify once per episode.
        let approvalNotified = prior.approvalNotified;
        if (shell.hasPendingApprovals) {
          if (!prior.approvalNotified) {
            yield* deps.sendNotice(
              chatId,
              `⚠️ 你接管的会话 ${title} 有一个待批准操作,请在终端/Web 处理(飞书内审批将于后续版本支持)`,
            );
            approvalNotified = true;
          }
        } else {
          // Falling edge: reset so the next genuine approval re-notifies.
          approvalNotified = false;
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

        yield* Ref.update(memory, (m) => {
          const next = new Map(m);
          next.set(binding.threadId, { approvalNotified, lastFailedTurnId });
          return next;
        });
      }).pipe(
        // One binding's IO failure must not wedge the shared fold or starve its
        // peers; log and move on (the next frame retries).
        Effect.catchCause((cause) =>
          Effect.logWarning("[feishu-bot] shellWatcher binding failed", cause),
        ),
      );

    // Single fold over `shellCache.changes`; forked into the caller's scope so
    // it is interrupted when the resident shell subscription is torn down.
    yield* deps.shellCache.changes.pipe(
      Stream.runForEach(() => onFrame),
      Effect.forkScoped,
      Effect.asVoid,
    );

    // Discrete lifecycle reset (NOT per-frame): drop a thread's dedup memory so a
    // future `/resume` of the same thread re-evaluates its notices from scratch.
    const clearNoticeMemory = (threadId: ThreadId): Effect.Effect<void> =>
      Ref.update(memory, (m) => {
        if (!m.has(threadId)) {
          return m;
        }
        const next = new Map(m);
        next.delete(threadId);
        return next;
      });

    return { clearNoticeMemory } satisfies ShellWatcherHandle;
  });
