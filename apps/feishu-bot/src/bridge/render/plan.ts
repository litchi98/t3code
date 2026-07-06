/**
 * The plan panel: derive plan steps from the latest `turn.plan.updated` and
 * render the full collapsible or the low-noise single-line summary (extracted
 * from `eventRenderer.ts`; M6, card render v3, M2b-4). Strictly pure: no IO.
 */
import type { OrchestrationThreadActivity, TurnId } from "@t3tools/contracts";

import type { CardElement } from "../../lark/card.ts";
import { trimToBytes } from "./budget.ts";
import { type MarkdownElement, collapsible, markdown } from "./elements.ts";
import { activityInTurn, compareWorkLogOrder } from "./turnScope.ts";

// ── Plan panel (turn.plan.updated) ───────────────────────────────────────────

interface PlanStep {
  readonly step: string;
  readonly status: "pending" | "inProgress" | "completed";
}

/**
 * Derive the plan steps from the latest `turn.plan.updated` activity (§5).
 * Lifecycle = "carry over, clear on complete": prefer the **current turn's**
 * latest plan (always shown, even fully-completed, so the user sees this turn's
 * own result); when the current turn emitted none, fall back to the most recent
 * `turn.plan.updated` from **any** turn so a TodoWrite plan persists across
 * follow-up messages — **except** once that carried-over plan is fully completed
 * it stops showing (the task is done; the next turn's card no longer repeats it).
 * Reads `payload.plan[].{step,status}` defensively (payload is `Schema.Unknown`).
 * Returns null when there is no usable/active plan (caller omits the section).
 */
export const derivePlanSteps = (
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  activeTurnId: TurnId | null,
): ReadonlyArray<PlanStep> | null => {
  // Track both the current-turn latest plan and the thread-wide latest plan, in
  // render order (sequence → createdAt → lifecycle-rank → id).
  let latestInTurn: OrchestrationThreadActivity | null = null;
  let latestAny: OrchestrationThreadActivity | null = null;
  for (const activity of activities) {
    if (activity.kind !== "turn.plan.updated") {
      continue;
    }
    if (latestAny === null || compareWorkLogOrder(activity, latestAny) >= 0) {
      latestAny = activity;
    }
    if (activityInTurn(activity, activeTurnId)) {
      if (latestInTurn === null || compareWorkLogOrder(activity, latestInTurn) >= 0) {
        latestInTurn = activity;
      }
    }
  }
  // Prefer the current turn's plan; fall back to the most recent plan from any
  // turn (TodoWrite persistence across follow-up messages).
  const latest = latestInTurn ?? latestAny;
  if (latest === null) {
    return null;
  }
  const payload =
    typeof latest.payload === "object" && latest.payload !== null
      ? (latest.payload as Record<string, unknown>)
      : null;
  const rawPlan = payload?.plan;
  if (!Array.isArray(rawPlan)) {
    return null;
  }
  const steps: Array<PlanStep> = [];
  for (const entry of rawPlan) {
    if (entry === null || typeof entry !== "object") {
      continue;
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.step !== "string") {
      continue;
    }
    const status =
      record.status === "completed" || record.status === "inProgress" ? record.status : "pending";
    steps.push({ step: record.step, status });
  }
  if (steps.length === 0) {
    return null;
  }
  // "Carry over, clear on complete": a plan carried over from an *earlier* turn
  // (the current turn emitted none) stops showing once every step is completed —
  // the task is done, so the next turn's card no longer repeats it. A plan the
  // *current* turn produced always shows (incl. fully-completed) so the user sees
  // this turn's own result.
  const carriedOver = latestInTurn === null;
  if (carriedOver && steps.every((step) => step.status === "completed")) {
    return null;
  }
  return steps;
};

const PLAN_STATUS_ICON: Readonly<Record<PlanStep["status"], string>> = {
  completed: "✅",
  inProgress: "🔄",
  pending: "⬜",
};

/**
 * Plan progress counts (completed / total). Shared by the full collapsible panel
 * ({@link renderPlanPanel}) and the low-noise single-line summary
 * ({@link renderPlanSummary}) so both agree on `X/N`.
 */
const planProgress = (
  steps: ReadonlyArray<PlanStep>,
): { readonly completed: number; readonly total: number } => {
  let completed = 0;
  for (const step of steps) {
    if (step.status === "completed") {
      completed += 1;
    }
  }
  return { completed, total: steps.length };
};

/**
 * Render the plan panel (§5), mirroring the activity stream's "current visible,
 * rest folded" shape (per user): the **in-progress** steps (`🔄`) render inline
 * with no separate title row (TodoWrite normally has one active step — this is
 * "what's being done right now"). The progress count lives on the collapsible
 * header instead: a single default-collapsed `📋 完整计划 ({completed}/{total})`
 * holds the **full** step list in original order (`✅/🔄/⬜`, including the
 * in-progress steps again) so the complete plan and its ordering stay available
 * without piling the whole accumulating TodoWrite list in the operator's face.
 * In-progress steps thus appear in both places by design. When there's no
 * in-progress step the inline part is empty and only the collapsible shows
 * (carried-over fully-completed plans are dropped upstream). Returns 1–2
 * elements. Byte-clamped here and globally.
 */
export const renderPlanPanel = (
  steps: ReadonlyArray<PlanStep>,
  maxBytes: number,
): { readonly elements: ReadonlyArray<CardElement>; readonly degraded: boolean } => {
  const inProgressLines: Array<string> = [];
  const allLines: Array<string> = [];
  for (const step of steps) {
    if (step.status === "inProgress") {
      inProgressLines.push(`${PLAN_STATUS_ICON.inProgress} ${step.step}`);
    }
    allLines.push(`${PLAN_STATUS_ICON[step.status]} ${step.step}`);
  }
  const { completed } = planProgress(steps);
  const elements: Array<CardElement> = [];
  let degraded = false;
  if (inProgressLines.length > 0) {
    const outer = trimToBytes(inProgressLines.join("\n\n"), maxBytes);
    elements.push(markdown(outer.text));
    degraded = outer.cut;
  }
  const full = trimToBytes(allLines.join("\n\n"), maxBytes);
  elements.push(collapsible(`📋 完整计划 (${completed}/${steps.length})`, full.text, false));
  degraded = degraded || full.cut;
  return { elements, degraded };
};

/**
 * Low-noise plan summary (`markdown` density): a single-line `📋 计划 {X}/{N}`
 * replacing the {@link renderPlanPanel} collapsible — same progress counts (via
 * {@link planProgress}), no per-step list, no collapsible. Only invoked when
 * {@link derivePlanSteps} returned steps.
 */
export const renderPlanSummary = (steps: ReadonlyArray<PlanStep>): MarkdownElement => {
  const { completed, total } = planProgress(steps);
  return markdown(`📋 计划 ${completed}/${total}`);
};
