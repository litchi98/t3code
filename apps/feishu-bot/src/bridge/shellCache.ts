/**
 * Resident shell snapshot cache + change stream (M2a).
 *
 * Subscribes to the environment shell (`subscribeShell`, opened by the caller),
 * folds every snapshot/event into a single cached {@link OrchestrationShellSnapshot}
 * via `applyShellStreamEvent` (the SAME pure reducer the web/mobile clients use —
 * this module never hand-derives shell state), and exposes:
 *   - typed reads of the current cache ({@link ShellSnapshotCache.current},
 *     `activeThreads`, `threadById`),
 *   - {@link ShellSnapshotCache.firstSnapshot}, the deterministic true-startup snapshot
 *     (for cold-start baselines), and
 *   - a broadcast {@link ShellSnapshotCache.snapshotAndChanges} stream — the current
 *     snapshot followed by one folded snapshot per later `fold(snapshot/event)`, for
 *     notification / reconcile consumers to react to thread upserts/removals across all
 *     ends without missing the present state at subscription time.
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
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

/**
 * Read + observe access to the resident shell snapshot.
 *
 * `current` / `activeThreads` / `threadById` are point-in-time reads of the
 * folded cache; `snapshotAndChanges` is a broadcast of the folded snapshot after
 * every fold step (snapshot replace or applied event), PREFIXED with the current
 * snapshot at subscription time (see its doc) so a new consumer never misses the
 * present state.
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
  /**
   * The current snapshot (at subscription time) FOLLOWED BY one folded snapshot per
   * later fold step. When a consumer runs this stream it FIRST subscribes to the
   * underlying change `PubSub`, THEN reads `current` and emits it as the leading
   * element — so there is no "read current then subscribe" gap in which a fold could
   * be lost, and no separate reconciliation pass is needed. A frame folded between the
   * subscribe and the `current` read appears in BOTH (leading snapshot and queue);
   * fold consumers are idempotent, so the overlap is harmless. This replaces the older
   * change-only `changes` stream, whose gap forced callers to seed from `current`
   * separately (which raced fold-vs-subscribe at startup). Backed by an unbounded
   * `PubSub`; the sole consumer (the shell watcher) must keep up so it cannot grow
   * without bound.
   */
  readonly snapshotAndChanges: Stream.Stream<OrchestrationShellSnapshot>;
  /**
   * Resolves with the VERY FIRST folded snapshot — the full snapshot `subscribeShell`
   * always replays before any event, i.e. the environment's state at the moment this
   * cache (and thus this bot uptime) started following the shell. Deterministic and
   * race-free: captured by the fold fiber at its first snapshot fold, so it is immune
   * to how `current` may have advanced past startup by the time a consumer reads it,
   * and to any check-then-subscribe timing on the `changes` PubSub. A later reconnect
   * that replays a fresh snapshot does NOT change it (the first value wins). Awaits
   * until that first snapshot lands (bound it with a timeout at the call site if a
   * never-delivering shell must not block). Used to seed cold-start baselines that
   * must reflect true startup state (e.g. the shell watcher's observe baseline).
   */
  readonly firstSnapshot: Effect.Effect<OrchestrationShellSnapshot>;
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
 * sequences itself). The folded snapshot lives in a {@link SubscriptionRef}, whose
 * `changes` gives the atomic "current value + all later updates" stream backing
 * {@link ShellSnapshotCache.snapshotAndChanges} — the same primitive the web/mobile
 * clients fold shell state with. Returns the {@link ShellSnapshotCache} handle.
 */
export const runShellCacheFiber = (
  deps: RunShellCacheDeps,
): Effect.Effect<ShellSnapshotCache, never, Scope.Scope> =>
  Effect.gen(function* () {
    // Latest folded shell snapshot, held in a SubscriptionRef so `snapshotAndChanges`
    // (its `changes`) atomically replays the current value to each new subscriber and
    // then streams every update — no separate PubSub, and no "read current then
    // subscribe" gap. The injected stream always replays a snapshot frame first, which
    // seeds this before any event needs a base.
    const snapshotRef = yield* SubscriptionRef.make<OrchestrationShellSnapshot | null>(null);
    // Latch for the first folded snapshot (see `firstSnapshot`). `Deferred.succeed` is
    // a no-op once resolved, so calling it on every snapshot fold keeps only the first.
    const firstSnapshotLatch = yield* Deferred.make<OrchestrationShellSnapshot>();

    const applyItem = (item: OrchestrationShellStreamItem) =>
      Effect.gen(function* () {
        if (item.kind === "snapshot") {
          // Snapshot frame: wholesale replace the cached snapshot.
          yield* SubscriptionRef.set(snapshotRef, item.snapshot);
          // Capture the FIRST snapshot exactly once (later replays are no-ops), so
          // `firstSnapshot` consumers always see true startup state (see interface doc).
          yield* Deferred.succeed(firstSnapshotLatch, item.snapshot);
          return;
        }
        // Non-snapshot frame: the item *is* a shell stream event (top-level
        // `kind` + `sequence`). `applyShellStreamEvent` guards
        // `event.sequence <= snapshot.snapshotSequence` and returns the prior
        // reference unchanged, so no manual lastSequence bookkeeping is needed.
        const current = yield* SubscriptionRef.get(snapshotRef);
        if (current === null) {
          // No snapshot yet — cannot fold an event without a base snapshot.
          return;
        }
        const next = applyShellStreamEvent(current, item);
        if (next === current) {
          // Stale / unrecognised event: nothing changed, do not re-publish.
          return;
        }
        yield* SubscriptionRef.set(snapshotRef, next);
      });

    // Fold the subscription in a scoped fiber; torn down when the scope closes.
    yield* deps.shellStream.pipe(Stream.runForEach(applyItem), Effect.forkScoped);

    return {
      current: SubscriptionRef.get(snapshotRef),
      activeThreads: SubscriptionRef.get(snapshotRef).pipe(
        Effect.map((snapshot) =>
          snapshot === null
            ? []
            : snapshot.threads
                .filter((thread) => thread.archivedAt === null)
                .toSorted((a, b) => (activityKey(a) < activityKey(b) ? 1 : -1)),
        ),
      ),
      threadById: (id) =>
        SubscriptionRef.get(snapshotRef).pipe(
          Effect.map((snapshot) => snapshot?.threads.find((thread) => thread.id === id) ?? null),
        ),
      // Atomic "current-then-changes" from the SubscriptionRef: `changes` replays the
      // current value at subscription time then every later update, all under one
      // subscription — no fold-vs-subscribe gap. Drop the leading `null` (pre-first-
      // snapshot) so the stream is typed to real snapshots; consumers that also fire on
      // the trigger read `current` themselves, so a coalesced value never loses state.
      snapshotAndChanges: SubscriptionRef.changes(snapshotRef).pipe(
        Stream.filter((snapshot): snapshot is OrchestrationShellSnapshot => snapshot !== null),
      ),
      firstSnapshot: Deferred.await(firstSnapshotLatch),
    } satisfies ShellSnapshotCache;
  });
