/**
 * Turn-scoped shared layer: payload reading, turn filtering, and stable
 * activity ordering (extracted from `eventRenderer.ts`; M6, card render v3,
 * M2b-4). This is the cross-dimension coupling hub — every render section
 * filters by the rendered turn and orders activities through here. Strictly
 * pure: no IO.
 */
import type { OrchestrationMessage, OrchestrationThreadActivity, TurnId } from "@t3tools/contracts";

// ── Payload reading ───────────────────────────────────────────────────────

/**
 * Read a string field off an activity payload without trusting its shape
 * (payload is `Schema.Unknown`; see `ProviderRuntimeIngestion` for the keys
 * the server actually writes — `itemType`/`status`/`detail`/`data`/`summary`).
 * Returns "" when absent.
 */
export const payloadString = (
  payload: unknown,
  key: "detail" | "summary" | "itemType" | "status" | "message",
): string => {
  if (typeof payload !== "object" || payload === null) {
    return "";
  }
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
};

// ── Turn scoping (shared by every section) ──────────────────────────────────

/**
 * Latest assistant message text for the turn being rendered.
 *
 * Scoped to `activeTurnId` when a turn is running: on a **reused** thread the
 * folded `messages` carry every prior turn's assistant reply, so without this
 * scope a freshly-started turn's card would show the *previous* turn's answer
 * until this turn's first assistant event lands (then jump). This scope only
 * **narrows** that stale-reply window — it does not eliminate it: between
 * subscribe and the turn-start event that folds `activeTurnId` in, `activeTurnId`
 * is still null and we briefly fall back to the previous turn's reply (see the
 * null branch below). While a turn runs we otherwise only consider messages
 * belonging to it (empty ⇒ the caller shows "Working…").
 *
 * The `activeTurnId` argument is the resolved filter basis (the caller passes
 * `opts.currentTurnId ?? thread.session.activeTurnId`). On the `driveTurn` path
 * this stays non-null through completion (it carries this turn's id), so the
 * terminal card shows *this turn's* reply rather than "latest assistant
 * overall". When the basis is null (a non-`driveTurn` render, or before the turn
 * starts) we fall back to the most recent assistant message overall — which is
 * this turn's reply once it has completed, given the bridge serialises turns
 * single-ended.
 *
 * Providers may emit several assistant messages per turn (commentary between
 * tool calls); we render the most recent matching one as the primary body.
 */
export const latestAssistantText = (
  messages: ReadonlyArray<OrchestrationMessage>,
  activeTurnId: TurnId | null,
): string => {
  let text = "";
  for (const message of messages) {
    if (message.role !== "assistant" || message.text.length === 0) {
      continue;
    }
    // turnId=null tolerance: only exclude messages *explicitly* tagged for a
    // different turn. A null `message.turnId` means the provider didn't tag this
    // streaming chunk's turn (some providers omit it on streaming text) — we
    // treat unknown-turn as the current turn and let it through, otherwise the
    // whole turn would stay stuck on the `⏳ 处理中…` working indicator and this
    // turn's text would be wrongly dropped.
    if (activeTurnId !== null && message.turnId !== null && message.turnId !== activeTurnId) {
      continue;
    }
    text = message.text;
  }
  return text;
};

/**
 * True when an activity belongs to the turn being rendered.
 *
 * Mirrors {@link latestAssistantText}'s body scope so the activity stream / plan
 * / changed-files sections don't show the *previous* turn's activity during a
 * reused thread's working-indicator (`⏳ 处理中…`) window — or the *whole thread's*
 * history on a completed turn's terminal card. The `activeTurnId` argument is the
 * resolved filter basis (`opts.currentTurnId ?? thread.session.activeTurnId`):
 * when `driveTurn` passes `currentTurnId`, this stays non-null through completion
 * and keeps the terminal render pinned to this turn. Same turnId=null tolerance:
 * when the basis is null (no turn folded in yet, or a non-`driveTurn`
 * post-completion render) every activity is in scope; when scoped we keep
 * activities tagged for it **plus** those with an untagged (null) turnId — only
 * activities *explicitly* tagged for a different turn are dropped.
 */
export const activityInTurn = (
  activity: OrchestrationThreadActivity,
  activeTurnId: TurnId | null,
): boolean => activeTurnId === null || activity.turnId === null || activity.turnId === activeTurnId;

/**
 * Lifecycle rank for an activity `kind`, used as a tie-break when two activities
 * share the same `sequence`/`createdAt`. Mirrors client-runtime's
 * `compareActivityLifecycleRank` (threadActivity.ts): started → 0,
 * progress/updated → 1, completed/resolved → 2 (default 1).
 */
const compareActivityLifecycleRank = (kind: string): number => {
  if (kind.endsWith(".started") || kind === "tool.started") {
    return 0;
  }
  if (kind.endsWith(".progress") || kind.endsWith(".updated")) {
    return 1;
  }
  if (kind.endsWith(".completed") || kind.endsWith(".resolved")) {
    return 2;
  }
  return 1;
};

/**
 * Stable order for the rendered work log. Mirrors the same sort keys as web's
 * `compareActivitiesByOrder` (sequence → createdAt → lifecycle-rank → id) so the
 * list order matches what web shows. Written locally (the web comparator is not
 * exported and lives in React-coupled session-logic); this is a pure
 * re-derivation of the same ordering — not a copy of a reusable export.
 */
export const compareWorkLogOrder = (
  left: OrchestrationThreadActivity,
  right: OrchestrationThreadActivity,
): number => {
  if (left.sequence !== undefined && right.sequence !== undefined) {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
  } else if (left.sequence !== undefined) {
    return 1;
  } else if (right.sequence !== undefined) {
    return -1;
  }
  const byCreatedAt = left.createdAt.localeCompare(right.createdAt);
  if (byCreatedAt !== 0) {
    return byCreatedAt;
  }
  const byLifecycleRank =
    compareActivityLifecycleRank(left.kind) - compareActivityLifecycleRank(right.kind);
  if (byLifecycleRank !== 0) {
    return byLifecycleRank;
  }
  return left.id.localeCompare(right.id);
};
