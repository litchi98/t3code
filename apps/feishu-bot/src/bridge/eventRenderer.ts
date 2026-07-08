/**
 * Pure renderer: reducer state → CardKit 2.0 card JSON (M6; card render v3, M2b-4).
 *
 * Consumes an {@link OrchestrationThread} (the local state maintained by
 * `session.ts` via `applyThreadDetailEvent`) and produces the card to push.
 * Assistant text comes from `thread.messages` (role `"assistant"`); tool/sub-task
 * activity comes from `thread.activities`; the plan comes from the latest
 * `turn.plan.updated` activity; changed-file line counts come from
 * `thread.checkpoints` (per-turn diff summary). Every element is byte-estimated
 * and degraded (folded activity history, truncated detail, trimmed long output)
 * to stay under Feishu's ~30KB per-element ceiling — exceeding it aborts the
 * whole stream with a 400.
 *
 * Card layout (v3, top→bottom; aligned to web's information architecture):
 *   1. Header     `🧵 title  <runtime badge>`           (chrome only)
 *   2. Error banner `⚠️ {session.lastError}`             (session.lastError; kept even chrome=false)
 *   3. Status line `⏳ 处理中…` / `✅ 完成 · 用时 X` / `⏹️ 已停止 …`  — workspace/branch
 *      (` · 📁 ws · 🌿 branch`) fold into this line; there is no separate subtitle row.
 *   4. Plan panel  `📋 完整计划 (X/N)` collapsible (latest `turn.plan.updated`) — above
 *      the activity stream: the plan is the high-level structure, tools the detail.
 *   5. Unified activity stream: current step (always visible markdown) + a
 *      single-level collapsible "🛠️ 完整调用 (X✓ Y✗)" holding the full log (tool.*
 *      + task.* + turn-scoped error activities merged in order; task entries use
 *      🧠; failed steps are marked ✗).
 *   6. Changed files `📝 改动 N 文件 (+X -Y)` collapsible (checkpoint files;
 *      DONE/terminal only — RUNNING expresses changes via the activity stream).
 *   7. Assistant body (markdown; only when the assistant has emitted text —
 *      the running state is already expressed by the status line above).
 *   8. Interaction section (injected via opts).
 *
 * There is **no v2-style independent error footer**: turn-scoped `tone:"error"`
 * activities (`tool.denied` / `runtime.error`) fold into the activity stream
 * (marked ✗); the session-level `lastError` surfaces as the top banner —
 * mirroring web.
 *
 * Strictly pure: no IO, no clock, no randomness. The card JSON is hand-built
 * CardKit 2.0 DSL (the SDK treats it as an opaque `object`). Only CardKit 2.0
 * tags are used (markdown / hr / collapsible_panel — never `checkbox`, which
 * 400s the whole stream). **Never nest collapsible_panel inside collapsible_panel**
 * (the outer panel serializes the inner content into the same element → 30KB
 * 400 bomb): the activity history, plan, and changed-files panels are each an
 * independent single-level panel, each protected by its own {@link clampElement}.
 */
import type { OrchestrationThread } from "@t3tools/contracts";

import type { CardElement, CardJson } from "../lark/card.ts";
import {
  aggregateWorkLog,
  formatWorkCounts,
  renderActivityStream,
  renderCurrentStep,
  tallyWorkCounts,
} from "./render/activityStream.ts";
import { SAFE_ELEMENT_BYTES, clampElement, elementBytes, trimToBytes } from "./render/budget.ts";
import { renderChangedFiles, renderChangedFilesSummary } from "./render/changedFiles.ts";
import { divider, markdown } from "./render/elements.ts";
import { derivePlanSteps, renderPlanPanel, renderPlanSummary } from "./render/plan.ts";
import {
  deriveTurnDisplayStatus,
  renderErrorBanner,
  renderErrorBannerFirstLine,
  renderHeader,
  renderStatusLine,
  runtimeBadgeSuffix,
  statusMetaSuffix,
  turnDuration,
} from "./render/status.ts";
import { latestAssistantText } from "./render/turnScope.ts";
import type { RenderOptions as BaseRenderOptions, RenderResult } from "./types.ts";

/**
 * Output density for group-chat noise control (M3b). `card` is the full v3
 * layout; `markdown` and `text` are low-noise variants that swap the collapsible
 * plan / activity / changed-files panels for single-line markdown summaries
 * (`text` further drops the header, plan and changed-files sections). All three
 * keep the assistant body and the interaction section.
 *
 * The runtime array is the single in-bot source of the density literals; the type
 * is derived from it so a parity test (`chatConfig.test.ts`) can assert this set
 * equals the contracts' `FEISHU_RENDER_DENSITIES` — the web editor renders that
 * contract list, so drift between the two would silently desync editor and bot.
 */
export const RENDER_DENSITIES = ["card", "markdown", "text"] as const;
export type RenderDensity = (typeof RENDER_DENSITIES)[number];

/**
 * Render options consumed by {@link renderThreadCard}. Extends the bridge-shared
 * {@link BaseRenderOptions} (streaming / currentTurnId / maxElementBytes /
 * interaction) with the renderer-local {@link RenderDensity} seam. Kept here
 * (not in `bridge/types.ts`) because `density` is purely a renderer concern.
 */
export interface RenderOptions extends BaseRenderOptions {
  /**
   * Output density. Defaults to `card` (full v3 layout). `markdown` drops the
   * header, swaps the plan / activity / changed-files collapsibles for single-line
   * markdown summaries, and strips the status-line workspace/branch meta. `text`
   * is the most compact: it additionally drops the plan and changed-files
   * sections and the activity current-step line, keeping only a one-line error
   * banner, the status line, an activity tally, the full body, and the
   * interaction. See the density branches in {@link renderThreadCard}.
   */
  readonly density?: RenderDensity;
  /**
   * Whether to render the v3 chrome: header line (🧵 title + runtime badge) and
   * subtitle (📁 workspace · 🌿 branch · 🔒 runtimeMode). Defaults to `true`.
   *
   * Set to `false` for notice/status cards (makeNoticeThread / sendNotice paths)
   * that carry only a short text body — the chrome is meaningless there (the
   * notice thread has no real title or workspace) and adds visual noise. All
   * other sections (error banner, body, status line, activity stream, plan,
   * changed files, interaction) are unaffected; every element still passes
   * through {@link clampElement}.
   */
  readonly chrome?: boolean;
}

/** Feishu's per-element size limit. Elements estimated above this are degraded. */
export const MAX_ELEMENT_BYTES = 30_000;

// ── Card envelope ───────────────────────────────────────────────────────────

/** A short plain-text summary for the card's notification/preview line. */
const truncateSummary = (text: string): string => {
  const firstLine = text.split("\n", 1)[0] ?? "";
  return firstLine.length > 80 ? `${firstLine.slice(0, 80)}…` : firstLine;
};

/**
 * Render the current thread state into a card (v3 layout — see the module
 * docstring for the full top→bottom section order). Every element is
 * byte-estimated and degraded to stay under `opts.maxElementBytes ??
 * MAX_ELEMENT_BYTES`. `streaming_mode` is set from `opts.streaming`.
 *
 * `opts.density` selects the layout (M3b group-chat noise control): `card` is
 * the full v3 layout; `markdown`/`text` are low-noise variants (single-line
 * summaries instead of collapsible panels — see the density branches below). All
 * three densities keep the assistant body and the interaction section.
 *
 * Turn scope: every dynamic section (body / status line / activity stream / plan
 * / changed files) filters by `opts.currentTurnId ?? thread.session.activeTurnId`
 * with turnId=null tolerance, so a reused thread's working-indicator window
 * never surfaces the previous turn's content and a completed turn's terminal card
 * stays pinned to this turn (see {@link activityInTurn} / {@link latestAssistantText}).
 *
 * NOTE on streaming: the card-producer path (`lark.stream`) refreshes the whole
 * card via throttled full patches — it does NOT drive Feishu's native per-text
 * typewriter animation. `streaming_mode: true` only marks the card as mid-stream
 * (e.g. suppresses some client chrome); it does not turn whole-card replacements
 * into incremental text. So this flag here is a state marker, not a typewriter
 * trigger. See the producer in the lark/bridge wiring for the throttle.
 */
export const renderThreadCard = (
  thread: OrchestrationThread,
  opts: RenderOptions,
): RenderResult => {
  const ceiling = opts.maxElementBytes ?? MAX_ELEMENT_BYTES;
  // Content budget = a fixed safe margin under the requested ceiling so the
  // JSON envelope can't push us over the actual wire limit.
  const contentBytes = Math.min(SAFE_ELEMENT_BYTES, Math.max(0, ceiling - 2_000));

  // Density (M3b group-chat noise control). `card` = full v3 layout; `markdown` /
  // `text` are low-noise variants assembled section-by-section below (collapsible
  // panels become single-line markdown summaries; `text` drops more sections).
  // All three keep the assistant body and the interaction section.
  const density = opts.density ?? "card";

  const elements: Array<CardElement> = [];
  let degraded = false;

  // Turn scope shared by the body and the activity-stream / plan / changed-files
  // sections so a reused thread's working-indicator (`⏳ 处理中…`) window doesn't
  // surface the previous turn's content (see latestAssistantText / activityInTurn).
  //
  // Basis = `opts.currentTurnId ?? thread.session.activeTurnId`. `driveTurn`
  // drives one specific turn and passes that turn's id as `currentTurnId`, so
  // the scope survives the turn completing: once the turn ends `activeTurnId`
  // flips to `null` (which would otherwise let the whole thread's history
  // through), but `currentTurnId` keeps the terminal card pinned to this turn.
  // Other render paths omit `currentTurnId` and fall back to `activeTurnId`,
  // preserving the prior behaviour.
  const turnIdForFilter = opts.currentTurnId ?? thread.session?.activeTurnId ?? null;

  // Turn-in-progress signal: the session is mid-turn (a turn is active, or the
  // provider status is `running`/`starting`). Drives the activity-stream/plan
  // expand/collapse and the status line. `streaming` alone isn't enough — it's a
  // card-state marker the caller sets — so we also read the live session.
  // Session-less placeholder threads (notices) read as not-in-progress: their
  // `activeTurnId` is absent, not null, so we check the session exists first.
  const sessionStatus = thread.session?.status ?? null;
  const inProgress =
    opts.streaming ||
    (thread.session != null && thread.session.activeTurnId !== null) ||
    sessionStatus === "running" ||
    sessionStatus === "starting";

  const turnStatus = deriveTurnDisplayStatus(thread, inProgress);
  const isRunning = turnStatus === "running";

  // 1. Header (title + runtime badge; always renderable). Skipped when
  // `opts.chrome === false` (notice/status cards that carry only a short text
  // body and have no meaningful title to surface). Only `card` renders the header;
  // the low-noise `markdown` / `text` densities drop the title header and instead
  // append the runtime badge to the END of the status line (see `badgeSuffix`
  // below) — a full-access (`bypass`) / auto-accept-edits (`editable`) mode is a
  // security signal that must stay visible at every density, without its own row.
  const withChrome = opts.chrome !== false;
  if (density === "card" && withChrome) {
    elements.push(renderHeader(thread));
  }
  // The runtime badge suffix for the low-noise densities (card carries it in the
  // header instead; chrome=false notice cards suppress it like the header). Folded
  // onto the status line / error-fallback line below.
  const badgeSuffix = density !== "card" && withChrome ? runtimeBadgeSuffix(thread) : "";

  // 2. Top error banner (session.lastError). Above the body; kept even when
  // chrome=false (a hard session error still surfaces on a notice card). Turn
  // error-tone activities are NOT here — they fold into the activity stream.
  // card/markdown: the full (multi-line) banner; text: a single ≤120-char first
  // line. `banner === null` below still drives the status-line error fallback.
  const banner =
    density === "text"
      ? renderErrorBannerFirstLine(thread)
      : renderErrorBanner(thread, contentBytes);
  if (banner) {
    elements.push(banner);
  }

  // Resolve assistant body text now (used later for the body section and the
  // card summary config field).
  const assistant = latestAssistantText(thread.messages, turnIdForFilter);

  // 3. Status line (⏳ 处理中… / ✅ 完成 · 用时 X / ⏹️ 已停止 …). ERROR normally emits
  // no line (the top banner expresses it) — but when the turn errored yet no
  // banner fired (session.lastError empty, e.g. a checkpoint-error sets
  // latestTurn.state="error" without touching the session), we synthesize a
  // "⚠️ 出错" fallback so the error state is never silent (§4 ERROR). (#13)
  // Suppressed entirely for session-less placeholder notice threads.
  if (thread.session != null) {
    // A never-run idle/ready session (latestTurn===null, classified "done" by
    // deriveTurnDisplayStatus #11) has no turn to describe — suppress the line
    // rather than show a misleading "✅ 完成". A real DONE turn always carries a
    // latestTurn, and a streaming-but-snapshot-lagging turn is "running" (not
    // "done"), so this filters only the genuine never-run case. (#11 follow-up)
    const suppressIdleDone = thread.latestTurn === null && turnStatus === "done";
    // Low-noise densities drop the ` · 📁 ws · 🌿 branch` meta suffix (only `card`
    // carries it — workspace/branch are low value in a noisy group thread) but fold
    // the runtime badge onto the status line's end instead of a dedicated row.
    const statusMeta = density === "card" ? statusMetaSuffix(thread) : badgeSuffix;
    const statusLine = suppressIdleDone
      ? null
      : renderStatusLine(turnStatus, turnDuration(thread), statusMeta);
    if (statusLine) {
      elements.push(statusLine);
    } else if (turnStatus === "error" && banner === null) {
      // ERROR emits no status line; the ⚠️ fallback carries the badge suffix so a
      // full-access errored turn still surfaces `bypass` at the low-noise densities.
      elements.push(markdown(`⚠️ 出错${badgeSuffix}`));
    }
  }

  // The process group (plan → activity stream → changed files) shares a single
  // leading divider separating it from the status line above; sections within
  // the group are not divided from each other (kept compact).
  let processGroupStarted = false;
  const startProcessGroup = (): void => {
    if (!processGroupStarted && elements.length > 0) {
      elements.push(divider());
    }
    processGroupStarted = true;
  };

  // 4. Plan panel (📋 完整计划 (X/N)). Above the activity stream — the plan is the
  // high-level structure ("what"); the tools below are the execution detail.
  // Only when the turn carried a `turn.plan.updated`.
  const planSteps = derivePlanSteps(thread.activities, turnIdForFilter);
  if (planSteps) {
    if (density === "card") {
      startProcessGroup();
      const plan = renderPlanPanel(planSteps, contentBytes);
      for (const planElement of plan.elements) {
        elements.push(planElement);
      }
      degraded = degraded || plan.degraded;
    } else if (density === "markdown") {
      // Low-noise: a single-line `📋 计划 X/N` summary instead of the collapsible.
      startProcessGroup();
      elements.push(renderPlanSummary(planSteps));
    }
    // density === "text": the plan section is dropped entirely.
  }

  // 5. Unified activity stream (tool.* + task.* merged): current step always
  // visible + single-level history fold (RUNNING), or one folded summary (DONE).
  if (density === "card") {
    const activity = renderActivityStream(
      thread.activities,
      contentBytes,
      turnIdForFilter,
      isRunning,
    );
    if (activity.elements.length > 0) {
      startProcessGroup();
      for (const activityElement of activity.elements) {
        elements.push(activityElement);
      }
      degraded = degraded || activity.degraded;
    }
  } else {
    // Low-noise: replace the collapsible work log with a single-line tally
    // `🛠️ X✓ Y✗ [Z⏳]` (same aggregation/counts as the card panel). `markdown`
    // keeps the always-visible current step while running; `text` shows only the
    // tally. No activity ⇒ nothing rendered (mirrors the card empty case).
    const entries = aggregateWorkLog(thread.activities, turnIdForFilter);
    if (entries.length > 0) {
      startProcessGroup();
      if (density === "markdown" && isRunning) {
        const current = entries[entries.length - 1];
        if (current !== undefined) {
          elements.push(renderCurrentStep(current));
        }
      }
      elements.push(markdown(`🛠️ ${formatWorkCounts(tallyWorkCounts(entries))}`));
    }
  }

  // 6. Changed files summary (📝 改动 N 文件 …). Checkpoint path (with line counts)
  // when a checkpoint is associated with this turn, else degraded file-name list.
  // Only on a settled (non-RUNNING) turn (§9.4 default: DONE-only): mid-turn
  // checkpoints can carry the running turn's files, and the same edits already
  // show as 🔧 rows in the activity stream — rendering both would double-display.
  if (!isRunning) {
    if (density === "card") {
      const changed = renderChangedFiles(thread, contentBytes, turnIdForFilter);
      if (changed) {
        startProcessGroup();
        elements.push(changed.element);
        degraded = degraded || changed.degraded;
      }
    } else if (density === "markdown") {
      // Low-noise: a single-line `📝 改动 N 文件 (+X -Y)` summary, no collapsible.
      const summary = renderChangedFilesSummary(thread, turnIdForFilter);
      if (summary) {
        startProcessGroup();
        elements.push(summary);
      }
    }
    // density === "text": the changed-files section is dropped entirely.
  }

  // 7. Assistant body (primary). Only rendered when the assistant has emitted
  // text — the running state is already expressed by the status line above, so
  // we never emit a working indicator here. Placed after the activity/plan/files
  // sections so the final answer surfaces at the bottom of the content area,
  // matching the web layout where the assistant reply follows the work log.
  if (assistant.length > 0) {
    if (elements.length > 0) {
      elements.push(divider());
    }
    if (density === "card") {
      const trimmed = trimToBytes(assistant, contentBytes);
      degraded = degraded || trimmed.cut;
      elements.push(markdown(trimmed.text));
    } else {
      // markdown/text: the body is the core value — no section-level pre-trim
      // (the final clampElement still enforces the 30KB per-element wire ceiling).
      elements.push(markdown(assistant));
    }
  }

  // 8. Interaction section (pre-rendered by interactionCard, injected via opts).
  // Each element passes through the same clampElement byte-degradation guard so
  // oversized interaction elements can't abort the stream. eventRenderer stays
  // pure: it receives already-rendered CardElement values and knows nothing about
  // callbackAuth or interactionCard internals.
  if (opts.interaction && opts.interaction.elements.length > 0) {
    if (elements.length > 0) {
      elements.push(divider());
    }
    for (const interactionElement of opts.interaction.elements) {
      elements.push(interactionElement);
    }
  }

  // Final hard clamp + max-byte measurement.
  let maxElementBytes = 0;
  const safeElements = elements.map((element) => {
    const clamped = clampElement(element, ceiling);
    degraded = degraded || clamped.degraded;
    const size = elementBytes(clamped.element);
    if (size > maxElementBytes) {
      maxElementBytes = size;
    }
    return clamped.element;
  });

  // Never emit a body-less card; Feishu rejects empty card bodies.
  const body = safeElements.length > 0 ? safeElements : [markdown("_…_")];

  const card: CardJson = {
    schema: "2.0",
    config: {
      // Mid-stream state marker only. The card path replaces the whole card on
      // each throttled patch, so this does not produce Feishu's native
      // per-token typewriter — it just flags the card as still updating.
      streaming_mode: opts.streaming,
      summary: { content: assistant.length > 0 ? truncateSummary(assistant) : "Working…" },
    },
    body: { elements: body },
  };

  return { card, degraded, maxElementBytes };
};
