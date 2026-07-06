/**
 * The unified activity stream (tool.* + task.* + turn-scoped errors merged into
 * one ordered work log), plus the aggregation helpers the low-noise densities
 * consume directly (extracted from `eventRenderer.ts`; M6, card render v3,
 * M2b-4). Strictly pure: no IO.
 */
import type { OrchestrationThreadActivity, TurnId } from "@t3tools/contracts";

import type { CardElement } from "../../lark/card.ts";
import {
  DIFF_OVERFLOW_HINT,
  TOOL_DETAIL_MAX_CHARS,
  TRUNCATION_MARKER,
  trimToBytes,
  trimToChars,
} from "./budget.ts";
import { type MarkdownElement, collapsible, markdown } from "./elements.ts";
import { activityInTurn, compareWorkLogOrder, payloadString } from "./turnScope.ts";

// ── Unified activity stream (tool.* + task.*) ────────────────────────────────

/**
 * The lifecycle phases the server emits for one tool call, as activity `kind`s
 * (see `ProviderRuntimeIngestion`). We merge a call's three rows into one,
 * preferring its terminal phase, and order phases so the latest wins.
 */
const TOOL_PHASE_RANK: Readonly<Record<string, number>> = {
  "tool.started": 0,
  "tool.updated": 1,
  "tool.completed": 2,
};

/**
 * An activity contributes to the unified work log when it is a tool call OR a
 * sub-task entry OR a turn-scoped error activity. `task.started` is filtered out
 * (it's just a "starting" marker that web also drops); `task.progress`/
 * `task.completed` become work-log entries with the 🧠 icon. Tool activities are
 * detected by tone `"tool"` (consistent with v2 aggregation). `tool.denied` and
 * `runtime.error` (tone `"error"`) also fold into the stream marked ✗ (§3.1/§59):
 * without this they would be lost from the card entirely (no v2 error footer, and
 * the top banner only surfaces session-level `lastError`).
 */
const isToolActivity = (activity: OrchestrationThreadActivity): boolean => activity.tone === "tool";

const isTaskEntryActivity = (activity: OrchestrationThreadActivity): boolean =>
  activity.kind === "task.progress" || activity.kind === "task.completed";

const isErrorActivity = (activity: OrchestrationThreadActivity): boolean =>
  activity.kind === "tool.denied" ||
  activity.kind === "runtime.error" ||
  activity.kind === "runtime.warning";

/**
 * Plan-boundary tool (`ExitPlanMode:`): the plan it carries is already rendered
 * by the dedicated plan panel (`turn.plan.updated`), so excluding it from the
 * activity stream avoids showing the same plan twice — mirrors web's
 * `isPlanBoundaryToolActivity` (session-logic.ts).
 */
const isPlanBoundaryToolActivity = (activity: OrchestrationThreadActivity): boolean =>
  (activity.kind === "tool.updated" || activity.kind === "tool.completed") &&
  payloadString(activity.payload, "detail").startsWith("ExitPlanMode:");

const isWorkLogActivity = (activity: OrchestrationThreadActivity): boolean =>
  !isPlanBoundaryToolActivity(activity) &&
  (isToolActivity(activity) || isTaskEntryActivity(activity) || isErrorActivity(activity));

/**
 * Stable label for a tool *instance* within a turn. The activity payload that
 * reaches us carries `itemType` but not the provider's per-call `itemId`, and
 * `summary` is phase-decorated (`"… started"` on start). We strip that suffix
 * so the three lifecycle rows of one call normalize to the same label, while
 * distinct calls (different titles) stay separate.
 */
const STARTED_SUFFIX = " started";
const toolInstanceLabel = (activity: OrchestrationThreadActivity): string => {
  const summary = activity.summary;
  if (activity.kind === "tool.started" && summary.endsWith(STARTED_SUFFIX)) {
    return summary.slice(0, summary.length - STARTED_SUFFIX.length);
  }
  return summary;
};

/**
 * Grouping key for a single work-log entry. Tool calls collapse their three
 * lifecycle rows by `turn + itemType + normalized label`. Task entries collapse
 * by `turn + taskId` (so a sub-task's progress→completed rows merge into one);
 * task entries are keyed under a `task::` namespace so they never collide with a
 * tool of the same label. Error activities (`tool.denied`/`runtime.error`) are
 * each their own entry under an `error::` namespace keyed by `turn + activity.id`
 * (they are not tool-lifecycle rows, so they must not reuse the `tool::` key
 * structure and collide with a tool of the same label).
 */
const taskId = (activity: OrchestrationThreadActivity): string => {
  if (typeof activity.payload !== "object" || activity.payload === null) {
    return "";
  }
  const value = (activity.payload as Record<string, unknown>).taskId;
  return typeof value === "string" ? value : "";
};

const workLogKey = (activity: OrchestrationThreadActivity): string => {
  if (isTaskEntryActivity(activity)) {
    return `task::${activity.turnId ?? ""}::${taskId(activity) || activity.id}`;
  }
  if (isErrorActivity(activity)) {
    return `error::${activity.turnId ?? ""}::${activity.id}`;
  }
  return `tool::${activity.turnId ?? ""}::${payloadString(
    activity.payload,
    "itemType",
  )}::${toolInstanceLabel(activity)}`;
};

/**
 * Order rank within one collapsed entry: prefer later tool lifecycle phase, then
 * (for tasks, which have no tool phase) a completed entry over a progress entry.
 */
const TASK_PHASE_RANK: Readonly<Record<string, number>> = {
  "task.progress": 0,
  "task.completed": 1,
};

const phaseRank = (activity: OrchestrationThreadActivity): number =>
  TOOL_PHASE_RANK[activity.kind] ?? TASK_PHASE_RANK[activity.kind] ?? 0;

/**
 * True when `next` represents a later lifecycle state than `current` for the
 * same entry. Ranks by phase first, then by `sequence` (monotonic per thread)
 * so re-emitted updates don't regress.
 */
const isLaterPhase = (
  next: OrchestrationThreadActivity,
  current: OrchestrationThreadActivity,
): boolean => {
  const nextRank = phaseRank(next);
  const currentRank = phaseRank(current);
  if (nextRank !== currentRank) {
    return nextRank > currentRank;
  }
  return (next.sequence ?? 0) >= (current.sequence ?? 0);
};

/**
 * Collapse the per-lifecycle tool/task activities into one entry each, keeping
 * the latest/terminal phase, then order them stably. This is the v2
 * `aggregateToolActivities` extended to also fold `task.*` entries into the same
 * unified stream (per §3 / FACTS). Tool calls collapse to their terminal phase;
 * sub-tasks (`task.progress`/`task.completed`) collapse by `taskId`;
 * `task.started` is filtered out (aligns with web).
 */
export const aggregateWorkLog = (
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  activeTurnId: TurnId | null,
): ReadonlyArray<OrchestrationThreadActivity> => {
  const latestByKey = new Map<string, OrchestrationThreadActivity>();
  for (const activity of activities) {
    if (!isWorkLogActivity(activity) || !activityInTurn(activity, activeTurnId)) {
      continue;
    }
    const key = workLogKey(activity);
    const prev = latestByKey.get(key);
    if (prev === undefined || isLaterPhase(activity, prev)) {
      latestByKey.set(key, activity);
    }
  }
  return Array.from(latestByKey.values()).sort(compareWorkLogOrder);
};

/**
 * Tri-state status of one aggregated work-log entry.
 * - failure ✗: tone flipped to error (failed tool / failed task), or a
 *   `tool.completed` whose status payload says failed/error.
 * - success ✓: a `tool.completed` (non-failed) or a `task.completed` (non-failed).
 * - inProgress ⏳: anything earlier (tool.started/updated, task.progress).
 */
type WorkStatus = "success" | "failure" | "inProgress";

const workStatus = (activity: OrchestrationThreadActivity): WorkStatus => {
  if (activity.tone === "error") {
    return "failure";
  }
  if (activity.kind === "tool.completed") {
    const status = payloadString(activity.payload, "status").toLowerCase();
    return status === "failed" || status === "error" ? "failure" : "success";
  }
  if (activity.kind === "task.completed") {
    const status = payloadString(activity.payload, "status").toLowerCase();
    return status === "failed" || status === "stopped" || status === "error"
      ? "failure"
      : "success";
  }
  return "inProgress";
};

const WORK_STATUS_ICON: Readonly<Record<WorkStatus, string>> = {
  success: "✓",
  failure: "✗",
  inProgress: "⏳",
};

/**
 * Leading icon for a work-log entry: 🧠 for sub-task entries (aligns with the v2
 * 🧠 sub-task panel; this is sub-task progress, NOT model reasoning), ⚠️ for
 * turn-scoped error activities (`tool.denied`/`runtime.error`), 🔧 for tool calls.
 */
const workIcon = (activity: OrchestrationThreadActivity): string => {
  if (isTaskEntryActivity(activity)) {
    return "🧠";
  }
  if (isErrorActivity(activity)) {
    return "⚠️";
  }
  return "🔧";
};

/**
 * Human label for a work-log entry. Tool entries use the normalized instance
 * label; task entries prefer their `summary` payload field (the
 * reasoning_summary_text) over the generic activity summary so the row reads as
 * the actual sub-task description rather than "Reasoning update".
 */
const workLabel = (activity: OrchestrationThreadActivity): string => {
  if (isTaskEntryActivity(activity)) {
    const summary = payloadString(activity.payload, "summary");
    return summary.length > 0 ? summary : activity.summary;
  }
  return toolInstanceLabel(activity);
};

/**
 * Truncated detail for one work-log entry, with the diff-overflow suffix policy
 * (no double-suffix). Task entries surface their `detail` payload; tool entries
 * their `detail` too. `runtime.error` stores its text under `payload.message`
 * (not `detail`), so we fall back to that for error activities. Diff/file_change
 * tools that overflow swap the generic truncation marker for
 * {@link DIFF_OVERFLOW_HINT}. Returns "" when no detail.
 *
 * For task entries the ingestion layer writes the same summary text into both
 * `payload.summary` (the label) and `payload.detail`; when they are identical we
 * suppress the detail so the row doesn't print the same text twice (#3).
 */
const workDetail = (activity: OrchestrationThreadActivity): string => {
  const detail =
    payloadString(activity.payload, "detail") ||
    (activity.kind === "runtime.error" ? payloadString(activity.payload, "message") : "");
  if (detail.length === 0) {
    return "";
  }
  if (isTaskEntryActivity(activity)) {
    const label = payloadString(activity.payload, "summary");
    if (label.length > 0 && detail === label) {
      return "";
    }
  }
  const clipped = trimToChars(detail, TOOL_DETAIL_MAX_CHARS);
  if (!clipped.cut) {
    return clipped.text;
  }
  const itemType = payloadString(activity.payload, "itemType");
  const isDiff = itemType === "file_change" || itemType.includes("diff");
  if (!isDiff) {
    // Non-diff truncation: TRUNCATION_MARKER is already baked into clipped.text.
    return clipped.text;
  }
  // Strip the generic TRUNCATION_MARKER and swap in the diff-specific hint.
  const base = clipped.text.endsWith(TRUNCATION_MARKER)
    ? clipped.text.slice(0, clipped.text.length - TRUNCATION_MARKER.length)
    : clipped.text;
  return `${base}${DIFF_OVERFLOW_HINT}`;
};

/**
 * One history row: `{icon} {status icon} {label}  {detail}`. The work-status icon
 * (✓/✗/⏳) and the kind icon (🧠/🔧) both appear so a glance reads both what kind
 * of step it was and how it resolved.
 */
const renderWorkLogRow = (activity: OrchestrationThreadActivity): string => {
  const icon = workIcon(activity);
  const status = WORK_STATUS_ICON[workStatus(activity)] ?? "•";
  const head = `${status} ${icon} \`${workLabel(activity)}\``;
  const detail = workDetail(activity);
  return detail.length > 0 ? `${head}  ${detail}` : head;
};

/**
 * Max chars for the current step's label. The current step is an always-visible
 * single-line markdown element (v3's only unbounded visible element — every other
 * work-log row lives inside a section-trimmed collapsible body), so we cap the
 * label here to keep it from feeding an oversized element into the final clamp.
 * A single line of ~200 chars is plenty for any tool/sub-task label.
 */
const CURRENT_STEP_LABEL_MAX_CHARS = 200;

/**
 * The "current step" single-line markdown, always visible (mirrors web's
 * most-recent-1 work-log row). The last aggregated entry is usually the
 * in-flight step (`{icon} 正在 \`{label}\``), but between tool calls it can
 * already be a finished/failed tool — then we lead with its ✓/✗ status icon
 * instead of a misleading "正在". Label wrapped in backticks (matches history
 * rows / §3.2) and capped at {@link CURRENT_STEP_LABEL_MAX_CHARS} so this
 * section-untrimmed element stays small.
 */
export const renderCurrentStep = (activity: OrchestrationThreadActivity): MarkdownElement => {
  const label = trimToChars(workLabel(activity), CURRENT_STEP_LABEL_MAX_CHARS).text;
  const status = workStatus(activity);
  if (status === "inProgress") {
    return markdown(`${workIcon(activity)} 正在 \`${label}\``);
  }
  return markdown(`${WORK_STATUS_ICON[status]} ${workIcon(activity)} \`${label}\``);
};

/** Tri-state tallies over a set of work-log entries. */
interface WorkCounts {
  readonly success: number;
  readonly failure: number;
  readonly inProgress: number;
}

export const tallyWorkCounts = (
  entries: ReadonlyArray<OrchestrationThreadActivity>,
): WorkCounts => {
  let success = 0;
  let failure = 0;
  let inProgress = 0;
  for (const entry of entries) {
    const status = workStatus(entry);
    if (status === "success") {
      success += 1;
    } else if (status === "failure") {
      failure += 1;
    } else {
      inProgress += 1;
    }
  }
  return { success, failure, inProgress };
};

/**
 * `X✓ Y✗` summary, plus ` Z⏳` only when some entries are still in progress (so
 * the parenthetical and the step count `N = X+Y+Z` stay consistent — a count of
 * `(1✓ 1✗)` over `3 步` would otherwise be self-contradictory).
 */
export const formatWorkCounts = (counts: WorkCounts): string => {
  const base = `${counts.success}✓ ${counts.failure}✗`;
  return counts.inProgress > 0 ? `${base} ${counts.inProgress}⏳` : base;
};

/**
 * Render the unified activity stream (§3). Tool.* + task.* + turn-scoped error
 * activities are aggregated into a single ordered work log. Mirrors the plan
 * panel's "current visible, full folded" style for visual consistency:
 *   - RUNNING: the current/last step as an always-visible single-line markdown,
 *     plus a default-collapsed `🛠️ 完整调用 (X✓ Y✗ [Z⏳])` panel holding the **full**
 *     log in order (the current step appears there too, by design — like the plan).
 *   - DONE/INTERRUPTED/ERROR: just the collapsed `🛠️ 完整调用 (…)` panel; there is
 *     no "current" step once the turn is settled, and the terminal state is shown
 *     by the status line above, so the fold title stays neutral.
 * The parenthetical tallies all three states so `X+Y+Z` = total entries (an entry
 * stuck at started/progress when the turn settled stays counted as ⏳). Returns an
 * empty list when the turn has no tool/task/error activity. Byte-clamped here and
 * by the global {@link clampElement} guard. **No nested collapsibles** — the panel
 * body is multi-line markdown.
 */
export const renderActivityStream = (
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  maxBytes: number,
  activeTurnId: TurnId | null,
  isRunning: boolean,
): { readonly elements: ReadonlyArray<CardElement>; readonly degraded: boolean } => {
  const entries = aggregateWorkLog(activities, activeTurnId);
  if (entries.length === 0) {
    return { elements: [], degraded: false };
  }
  // Full record (all entries, in order) folds into one collapsed panel whose
  // header carries the tally — same shape as the plan panel's 完整计划 fold.
  const counts = formatWorkCounts(tallyWorkCounts(entries));
  const body = trimToBytes(entries.map(renderWorkLogRow).join("\n\n"), maxBytes);
  const fold = collapsible(`🛠️ 完整调用 (${counts})`, body.text, false);
  if (!isRunning) {
    return { elements: [fold], degraded: body.cut };
  }
  // Running: the last step is always visible above the full-record fold.
  const current = entries[entries.length - 1];
  if (current === undefined) {
    return { elements: [fold], degraded: body.cut };
  }
  return { elements: [renderCurrentStep(current), fold], degraded: body.cut };
};
