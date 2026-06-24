/**
 * Resident shell snapshot cache + change stream (M2a).
 *
 * Subscribes to the environment shell (`subscribeShell`, opened by the caller),
 * folds every snapshot/event into a single cached {@link OrchestrationShellSnapshot}
 * via `applyShellStreamEvent` (the SAME pure reducer the web/mobile clients use —
 * this module never hand-derives shell state), and exposes:
 *   - typed reads of the current cache ({@link ShellSnapshotCache.current},
 *     `activeThreads`, `threadById`), and
 *   - a broadcast {@link ShellSnapshotCache.changes} stream that emits the folded
 *     snapshot after every `fold(snapshot/event)`, for notification / reconcile
 *     consumers to react to thread upserts/removals across all ends.
 *
 * The fold mirrors `session.ts`'s `observeThread` skeleton (snapshot first frame,
 * then incremental events guarded by `lastSequence`), but for the *shell* rather
 * than a single thread:
 *   - snapshot frames wholesale-replace the cached snapshot, and
 *   - non-snapshot frames are shell stream *events* (their `kind` is one of
 *     `project-upserted` / `project-removed` / `thread-upserted` /
 *     `thread-removed`, with a top-level `sequence`), fed straight to
 *     `applyShellStreamEvent`, which already guards `event.sequence <=
 *     snapshot.snapshotSequence` and returns the prior reference unchanged.
 *
 * Decoupling: like `session.ts` / `chatThreadMap.ts`, the live `subscribeShell`
 * stream is injected by the caller (`bot.ts` binds it to
 * `registry.followStream(environmentId, …subscribeShell)`), so this module never
 * builds a connection itself.
 */
import type {
  OrchestrationShellSnapshot,
  OrchestrationShellStreamItem,
  OrchestrationThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import { applyShellStreamEvent } from "@t3tools/client-runtime/state/shell";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

/**
 * Read + observe access to the resident shell snapshot.
 *
 * `current` / `activeThreads` / `threadById` are point-in-time reads of the
 * folded cache; `changes` is a broadcast of the folded snapshot after every fold
 * step (snapshot replace or applied event). `changes` is backed by an unbounded
 * `PubSub`, so it carries only frames published *after* a consumer subscribes —
 * consumers that also need the current state seed it with `current` first.
 */
export interface ShellSnapshotCache {
  /** The latest folded shell snapshot, or `null` before the first frame lands. */
  readonly current: Effect.Effect<OrchestrationShellSnapshot | null>;
  /**
   * Active (non-archived) threads from the current snapshot, newest first:
   * sorted by `latestUserMessageAt` (falling back to `updatedAt`) descending.
   * Empty before the first frame.
   */
  readonly activeThreads: Effect.Effect<ReadonlyArray<OrchestrationThreadShell>>;
  /** The thread with `id` in the current snapshot, or `null` if absent. */
  readonly threadById: (id: ThreadId) => Effect.Effect<OrchestrationThreadShell | null>;
  /** One folded snapshot per fold step (post-snapshot-replace / post-event). */
  readonly changes: Stream.Stream<OrchestrationShellSnapshot>;
}

/** Dependencies the cache fiber needs, injected by the caller. */
export interface RunShellCacheDeps {
  /**
   * The live `subscribeShell` stream. `bot.ts` binds this to
   * `registry.followStream(environmentId, …subscribeShell)`, which replays a full
   * snapshot first and never fails (already `Stream.orDie`d). This module only
   * folds it; it does not open the connection.
   */
  readonly shellStream: Stream.Stream<OrchestrationShellStreamItem>;
}

/** Sort key for "newest activity first": latest user message, else updatedAt. */
const activityKey = (thread: OrchestrationThreadShell): string =>
  thread.latestUserMessageAt ?? thread.updatedAt;

/**
 * Coarse live status of a thread shell, classified once for every consumer that
 * needs to map it to display text. `null` shell (thread absent from the snapshot)
 * is `"unknown"`; otherwise a running latest turn wins, then a pending approval,
 * else idle. Callers map the result to their own surface (a Chinese card line, a
 * short status tag, …) instead of each re-deriving this three/four-way split.
 */
export type ShellStatus = "running" | "pending-approval" | "idle" | "unknown";

/** Classify a thread shell's coarse live status (see {@link ShellStatus}). */
export const shellStatus = (shell: OrchestrationThreadShell | null): ShellStatus => {
  if (shell === null) {
    return "unknown";
  }
  if (shell.latestTurn?.state === "running") {
    return "running";
  }
  if (shell.hasPendingApprovals) {
    return "pending-approval";
  }
  return "idle";
};

/**
 * Start the resident shell-cache fold fiber on the caller's scope.
 *
 * Forks `shellStream` folding into a scoped fiber (interrupted when the scope
 * closes): the snapshot frame seeds/replaces the cached snapshot wholesale, and
 * each subsequent event is folded via `applyShellStreamEvent` (which guards stale
 * sequences itself). After every fold step the resulting snapshot is published to
 * the `changes` PubSub for notification / reconcile consumers. Returns the
 * {@link ShellSnapshotCache} read+observe handle.
 */
export const runShellCacheFiber = (
  deps: RunShellCacheDeps,
): Effect.Effect<ShellSnapshotCache, never, Scope.Scope> =>
  Effect.gen(function* () {
    // Latest folded shell snapshot. The injected stream always replays a snapshot
    // frame first, which seeds this before any event needs a base.
    const snapshotRef = yield* Ref.make<OrchestrationShellSnapshot | null>(null);
    // Broadcast of post-fold snapshots. Retention is *unbounded* (an unbounded
    // `PubSub` never drops): correctness relies on the sole consumer (the
    // `shellWatcher` fold) always keeping up, so the queue cannot grow without
    // bound in practice. The cache remains the source of truth for the current
    // state; `changes` is only a change signal. (Kept unbounded deliberately —
    // switching to a dropping/sliding PubSub would change delivery behaviour.)
    const hub = yield* PubSub.unbounded<OrchestrationShellSnapshot>();

    const applyItem = (item: OrchestrationShellStreamItem) =>
      Effect.gen(function* () {
        if (item.kind === "snapshot") {
          // Snapshot frame: wholesale replace the cached snapshot.
          yield* Ref.set(snapshotRef, item.snapshot);
          yield* PubSub.publish(hub, item.snapshot);
          return;
        }
        // Non-snapshot frame: the item *is* a shell stream event (top-level
        // `kind` + `sequence`). `applyShellStreamEvent` guards
        // `event.sequence <= snapshot.snapshotSequence` and returns the prior
        // reference unchanged, so no manual lastSequence bookkeeping is needed.
        const current = yield* Ref.get(snapshotRef);
        if (current === null) {
          // No snapshot yet — cannot fold an event without a base snapshot.
          return;
        }
        const next = applyShellStreamEvent(current, item);
        if (next === current) {
          // Stale / unrecognised event: nothing changed, do not re-publish.
          return;
        }
        yield* Ref.set(snapshotRef, next);
        yield* PubSub.publish(hub, next);
      });

    // Fold the subscription in a scoped fiber; torn down when the scope closes.
    yield* deps.shellStream.pipe(Stream.runForEach(applyItem), Effect.forkScoped);

    return {
      current: Ref.get(snapshotRef),
      activeThreads: Ref.get(snapshotRef).pipe(
        Effect.map((snapshot) =>
          snapshot === null
            ? []
            : snapshot.threads
                .filter((thread) => thread.archivedAt === null)
                .toSorted((a, b) => (activityKey(a) < activityKey(b) ? 1 : -1)),
        ),
      ),
      threadById: (id) =>
        Ref.get(snapshotRef).pipe(
          Effect.map((snapshot) => snapshot?.threads.find((thread) => thread.id === id) ?? null),
        ),
      changes: Stream.fromPubSub(hub),
    } satisfies ShellSnapshotCache;
  });
