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
import type {
  OrchestrationCheckpointFile,
  OrchestrationMessage,
  OrchestrationThread,
  OrchestrationThreadActivity,
  RuntimeMode,
  TurnId,
} from "@t3tools/contracts";

import type { CardElement, CardJson } from "../lark/card.ts";
import type { RenderOptions as BaseRenderOptions, RenderResult } from "./types.ts";

/**
 * Forward seam for M3 group-chat noise control. `card` is the full v3 layout;
 * the other modes are reserved (today they fall back to `card`).
 */
export type RenderDensity = "card" | "markdown" | "text";

/**
 * Render options consumed by {@link renderThreadCard}. Extends the bridge-shared
 * {@link BaseRenderOptions} (streaming / currentTurnId / maxElementBytes /
 * interaction) with the renderer-local {@link RenderDensity} seam. Kept here
 * (not in `bridge/types.ts`) because `density` is purely a renderer concern.
 */
export interface RenderOptions extends BaseRenderOptions {
  /**
   * Output density. Defaults to `card`. Only `card` is implemented; `markdown`
   * and `text` currently fall back to the `card` layout (see the density switch
   * in {@link renderThreadCard}). TODO(M3): 群聊降噪密度.
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

// ── Degradation budgets ───────────────────────────────────────────────────
// Headroom below MAX_ELEMENT_BYTES so the JSON envelope (tag/field keys, escape
// expansion of the markdown content) can't push a "safe" element over the wire
// limit. We size content against this rather than the raw ceiling.
const SAFE_ELEMENT_BYTES = 28_000;
/** A single activity row's detail before it gets trimmed. */
const TOOL_DETAIL_MAX_CHARS = 800;
/** Marker appended to any text we had to cut. */
const TRUNCATION_MARKER = "\n\n… [truncated]";
/**
 * Appended to an activity detail row when its content was truncated. Diff/
 * file-change tools can carry far more than {@link TOOL_DETAIL_MAX_CHARS}; rather
 * than mint a deep link we point the operator at the terminal/Web where the full
 * diff lives.
 */
const DIFF_OVERFLOW_HINT = " (diff 较大,完整内容请见终端/Web)";

// ── Byte estimation ─────────────────────────────────────────────────────────

/**
 * UTF-8 byte length of a string. `Buffer.byteLength` is exact and allocation
 * free for length queries.
 */
const utf8Bytes = (value: string): number => Buffer.byteLength(value, "utf8");

/**
 * Estimate the serialized byte size of a card element. We serialize to JSON
 * (what actually goes on the wire) and measure its UTF-8 length, so key names,
 * nesting, and escape expansion are all counted — not just the visible text.
 */
const elementBytes = (element: CardElement): number => utf8Bytes(JSON.stringify(element));

/**
 * Trim `text` so its UTF-8 byte length (plus the truncation marker) stays at or
 * under `maxBytes`. Cuts on a code-point boundary; appends the marker only when
 * a cut actually happened.
 */
const trimToBytes = (
  text: string,
  maxBytes: number,
): { readonly text: string; readonly cut: boolean } => {
  if (utf8Bytes(text) <= maxBytes) {
    return { text, cut: false };
  }
  const markerBytes = utf8Bytes(TRUNCATION_MARKER);
  const budget = Math.max(0, maxBytes - markerBytes);
  // Walk code points (not UTF-16 units) so we never split a surrogate pair.
  let acc = "";
  let accBytes = 0;
  for (const ch of text) {
    const chBytes = utf8Bytes(ch);
    if (accBytes + chBytes > budget) {
      break;
    }
    acc += ch;
    accBytes += chBytes;
  }
  return { text: `${acc}${TRUNCATION_MARKER}`, cut: true };
};

/** Trim by character count, marking truncation. Cheaper pre-pass before bytes. */
const trimToChars = (
  text: string,
  maxChars: number,
): { readonly text: string; readonly cut: boolean } => {
  if (text.length <= maxChars) {
    return { text, cut: false };
  }
  return { text: `${text.slice(0, maxChars)}${TRUNCATION_MARKER}`, cut: true };
};

// ── Element constructors (CardKit 2.0 DSL) ──────────────────────────────────

interface MarkdownElement {
  readonly tag: "markdown";
  readonly content: string;
}

interface CollapsiblePanelElement {
  readonly tag: "collapsible_panel";
  readonly expanded: boolean;
  readonly header: {
    readonly title: { readonly tag: "markdown"; readonly content: string };
    readonly vertical_align: "center";
    readonly icon: {
      readonly tag: "standard_icon";
      readonly token: "down-small-ccm_outlined";
    };
    readonly icon_position: "right";
    readonly icon_expanded_angle: -180;
  };
  readonly elements: ReadonlyArray<MarkdownElement>;
}

interface DividerElement {
  readonly tag: "hr";
}

const markdown = (content: string): MarkdownElement => ({ tag: "markdown", content });

const divider = (): DividerElement => ({ tag: "hr" });

/**
 * Single-level collapsible panel: a header (`title` markdown + rotating angle
 * icon) over one markdown body. **Never put another collapsible_panel in the
 * body** — the outer panel serializes the inner content into the same element,
 * which both risks the 30KB per-element 400 bomb and is officially discouraged.
 * The activity history, plan, and changed-files panels each use this directly
 * with a multi-line markdown body for their inner rows.
 */
const collapsible = (
  title: string,
  content: string,
  expanded: boolean,
): CollapsiblePanelElement => ({
  tag: "collapsible_panel",
  expanded,
  header: {
    title: { tag: "markdown", content: title },
    vertical_align: "center",
    icon: { tag: "standard_icon", token: "down-small-ccm_outlined" },
    icon_position: "right",
    icon_expanded_angle: -180,
  },
  elements: [markdown(content)],
});

// ── Payload reading ───────────────────────────────────────────────────────

/**
 * Read a string field off an activity payload without trusting its shape
 * (payload is `Schema.Unknown`; see `ProviderRuntimeIngestion` for the keys
 * the server actually writes — `itemType`/`status`/`detail`/`data`/`summary`).
 * Returns "" when absent.
 */
const payloadString = (
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
const latestAssistantText = (
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
const activityInTurn = (
  activity: OrchestrationThreadActivity,
  activeTurnId: TurnId | null,
): boolean => activeTurnId === null || activity.turnId === null || activity.turnId === activeTurnId;

// ── Turn status ─────────────────────────────────────────────────────────────

/**
 * Coarse render state for the card, derived from `thread.session.status` and
 * `thread.latestTurn.{state,startedAt,completedAt}`. Mirrors web's turn view:
 * - RUNNING: a turn is in flight (status running/starting, or a turn is active
 *   and not yet settled). approval/user-input gating still reads as RUNNING
 *   (the turn is still running while the operator decides — web is the same).
 * - DONE: the turn settled successfully (started && completed && not running).
 * - INTERRUPTED: the operator stopped the response.
 * - ERROR: the session/turn errored. The status line is suppressed (the top
 *   error banner already expresses it).
 */
type TurnDisplayStatus = "running" | "done" | "interrupted" | "error";

/**
 * Settled = web's `isLatestTurnSettled`: the latest turn has both `startedAt`
 * and `completedAt` AND the session is not `running`. Only then is the turn
 * terminal (DONE/INTERRUPTED/ERROR) rather than in flight.
 */
const isLatestTurnSettled = (thread: OrchestrationThread): boolean => {
  const turn = thread.latestTurn;
  if (turn === null || turn.startedAt === null || turn.completedAt === null) {
    return false;
  }
  return thread.session?.status !== "running";
};

const deriveTurnDisplayStatus = (
  thread: OrchestrationThread,
  inProgress: boolean,
): TurnDisplayStatus => {
  const sessionStatus = thread.session?.status ?? null;
  const turnState = thread.latestTurn?.state ?? null;

  // Error wins regardless of settle: a session/turn error should always surface
  // the banner + suppress the working line, even mid-status-flux.
  if (sessionStatus === "error" || turnState === "error") {
    return "error";
  }
  // Idle/ready session that has never run a turn (latestTurn===null) is NOT in
  // flight — without this it would fail the settle gate (turn===null ⇒ false)
  // and be mislabelled "⏳ 处理中…". Treat it as done so we don't show a false
  // working indicator on an idle session (§4 IDLE; the caller may still suppress
  // the line). (#11)
  if (!inProgress && thread.latestTurn === null) {
    return "done";
  }
  // Settle gate, with a terminal-state rescue: a turn whose `state` is already
  // terminal (completed/interrupted) but whose timestamps are missing (server
  // snapshot decoded outside the reducer's guarantees) must NOT be re-classified
  // as running. §9.2: degrade to "✅ 完成" (no duration), not a false "⏳ 处理中…".
  // (#10)
  const isTerminalByState = turnState === "completed" || turnState === "interrupted";
  if (inProgress || (!isLatestTurnSettled(thread) && !isTerminalByState)) {
    return "running";
  }
  if (
    sessionStatus === "interrupted" ||
    sessionStatus === "stopped" ||
    turnState === "interrupted"
  ) {
    return "interrupted";
  }
  return "done";
};

/**
 * Human "用时 {X}" for a settled turn, from `completedAt - startedAt`. Returns
 * null when either timestamp is absent (so the status line drops the duration
 * gracefully rather than inventing one). Formats sub-minute as `Xs`, else `Xm Ys`.
 */
const turnDuration = (thread: OrchestrationThread): string | null => {
  const turn = thread.latestTurn;
  if (turn === null || turn.startedAt === null || turn.completedAt === null) {
    return null;
  }
  const startMs = Date.parse(turn.startedAt);
  const endMs = Date.parse(turn.completedAt);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
    return null;
  }
  const totalSeconds = Math.round((endMs - startMs) / 1_000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
};

/**
 * Status line (§7 文案). RUNNING → `⏳ 处理中…`; DONE → `✅ 完成 · 用时 {X}` (or just
 * `✅ 完成`); INTERRUPTED → `⏹️ 已停止 · 用时 {X}` (or `⏹️ 已停止`); ERROR → no line
 * (the top banner already expresses it). Returns null when nothing to show.
 */
const renderStatusLine = (
  status: TurnDisplayStatus,
  duration: string | null,
  meta: string,
): MarkdownElement | null => {
  switch (status) {
    case "running":
      return markdown(`⏳ 处理中…${meta}`);
    case "done":
      return markdown(`${duration !== null ? `✅ 完成 · 用时 ${duration}` : "✅ 完成"}${meta}`);
    case "interrupted":
      return markdown(`${duration !== null ? `⏹️ 已停止 · 用时 ${duration}` : "⏹️ 已停止"}${meta}`);
    case "error":
      return null;
  }
};

// ── Top error banner ─────────────────────────────────────────────────────────

/**
 * Top error banner from the **session-level** `lastError` only (NOT turn-scoped
 * error activities — those fold into the activity stream marked ✗, mirroring
 * web). Rendered above the body even when `chrome === false` (notice cards still
 * surface a hard session error). `lastError` is session-level (not turn-tagged)
 * and already reflects the latest error on the session, so no turn filter.
 */
const renderErrorBanner = (
  thread: OrchestrationThread,
  maxBytes: number,
): MarkdownElement | null => {
  const lastError = thread.session?.lastError ?? null;
  if (lastError === null || lastError.length === 0) {
    return null;
  }
  return markdown(trimToBytes(`⚠️ **错误**\n${lastError}`, maxBytes).text);
};

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
const compareWorkLogOrder = (
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

/**
 * Collapse the per-lifecycle tool/task activities into one entry each, keeping
 * the latest/terminal phase, then order them stably. This is the v2
 * `aggregateToolActivities` extended to also fold `task.*` entries into the same
 * unified stream (per §3 / FACTS). Tool calls collapse to their terminal phase;
 * sub-tasks (`task.progress`/`task.completed`) collapse by `taskId`;
 * `task.started` is filtered out (aligns with web).
 */
const aggregateWorkLog = (
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
const renderCurrentStep = (activity: OrchestrationThreadActivity): MarkdownElement => {
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

const tallyWorkCounts = (entries: ReadonlyArray<OrchestrationThreadActivity>): WorkCounts => {
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
const formatWorkCounts = (counts: WorkCounts): string => {
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
const renderActivityStream = (
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
const derivePlanSteps = (
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
const renderPlanPanel = (
  steps: ReadonlyArray<PlanStep>,
  maxBytes: number,
): { readonly elements: ReadonlyArray<CardElement>; readonly degraded: boolean } => {
  let completedCount = 0;
  const inProgressLines: Array<string> = [];
  const allLines: Array<string> = [];
  for (const step of steps) {
    if (step.status === "completed") {
      completedCount += 1;
    } else if (step.status === "inProgress") {
      inProgressLines.push(`${PLAN_STATUS_ICON.inProgress} ${step.step}`);
    }
    allLines.push(`${PLAN_STATUS_ICON[step.status]} ${step.step}`);
  }
  const elements: Array<CardElement> = [];
  let degraded = false;
  if (inProgressLines.length > 0) {
    const outer = trimToBytes(inProgressLines.join("\n\n"), maxBytes);
    elements.push(markdown(outer.text));
    degraded = outer.cut;
  }
  const full = trimToBytes(allLines.join("\n\n"), maxBytes);
  elements.push(collapsible(`📋 完整计划 (${completedCount}/${steps.length})`, full.text, false));
  degraded = degraded || full.cut;
  return { elements, degraded };
};

// ── Changed files summary (checkpoint files) ─────────────────────────────────

/**
 * Per-turn changed files for the turn being rendered, taken from
 * `thread.checkpoints`. Each {@link OrchestrationCheckpointSummary} is keyed by
 * `turnId` and carries `files: OrchestrationCheckpointFile[]` with real
 * `additions`/`deletions` line counts (the live `file_change` *activities* carry
 * no line counts). We pick the checkpoint matching the rendered turn; when the
 * basis is null (non-driveTurn render with no anchor) we take the latest
 * checkpoint by `completedAt`. Returns null when no checkpoint is associated with
 * this turn — the caller then falls back to the activity-derived path list.
 *
 * DECISION: this is the **primary (checkpoint) path** — `OrchestrationThread`
 * exposes `checkpoints[]` with per-turn `turnId` + `files[].{path,additions,
 * deletions}`, so we *can* associate the current turn and *do* have line counts
 * (mirrors web's `AssistantChangedFilesSection`, which reads `turnSummary.files`).
 */
const checkpointFilesForTurn = (
  thread: OrchestrationThread,
  activeTurnId: TurnId | null,
): ReadonlyArray<OrchestrationCheckpointFile> | null => {
  const checkpoints = thread.checkpoints;
  if (checkpoints.length === 0) {
    return null;
  }
  let chosen: (typeof checkpoints)[number] | null = null;
  if (activeTurnId !== null) {
    for (const checkpoint of checkpoints) {
      if (checkpoint.turnId === activeTurnId) {
        // Prefer the latest checkpoint for this turn (multiple may accrue).
        if (chosen === null || checkpoint.completedAt.localeCompare(chosen.completedAt) >= 0) {
          chosen = checkpoint;
        }
      }
    }
  } else {
    for (const checkpoint of checkpoints) {
      if (chosen === null || checkpoint.completedAt.localeCompare(chosen.completedAt) >= 0) {
        chosen = checkpoint;
      }
    }
  }
  if (chosen === null || chosen.files.length === 0) {
    return null;
  }
  return chosen.files;
};

/** Cap on the number of fallback changed-file paths (mirrors web's 12). */
const CHANGED_PATHS_MAX = 12;

/**
 * Recursively collect changed-file paths from a `file_change` activity payload's
 * `data` (the degraded fallback when no checkpoint is associated with the turn).
 * Mirrors web `collectChangedFiles` (session-logic.ts): handles arrays
 * (per-element recursion), collects **all** of path / filePath / relativePath /
 * filename / newPath / oldPath on a record (not just the first), and recurses
 * into item / result / input / data / changes / files / edits / patch / patches /
 * operations. Pushes deduped, non-empty paths into `target` up to
 * {@link CHANGED_PATHS_MAX}. Defensive against malformed/missing data (never throws).
 */
const PATH_KEYS = ["path", "filePath", "relativePath", "filename", "newPath", "oldPath"] as const;
const NESTED_KEYS = [
  "item",
  "result",
  "input",
  "data",
  "changes",
  "files",
  "edits",
  "patch",
  "patches",
  "operations",
] as const;

const collectChangedPaths = (
  data: unknown,
  depth: number,
  seen: Set<string>,
  target: Array<string>,
): void => {
  if (depth > 4 || target.length >= CHANGED_PATHS_MAX) {
    return;
  }
  if (Array.isArray(data)) {
    for (const entry of data) {
      collectChangedPaths(entry, depth + 1, seen, target);
      if (target.length >= CHANGED_PATHS_MAX) {
        return;
      }
    }
    return;
  }
  if (typeof data !== "object" || data === null) {
    return;
  }
  const record = data as Record<string, unknown>;
  for (const key of PATH_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0 && !seen.has(value)) {
      seen.add(value);
      target.push(value);
      if (target.length >= CHANGED_PATHS_MAX) {
        return;
      }
    }
  }
  for (const key of NESTED_KEYS) {
    if (!(key in record)) {
      continue;
    }
    collectChangedPaths(record[key], depth + 1, seen, target);
    if (target.length >= CHANGED_PATHS_MAX) {
      return;
    }
  }
};

/**
 * Fallback changed-file paths from `file_change` activities (no line counts).
 * Used only when no checkpoint is associated with the rendered turn. Capped at
 * {@link CHANGED_PATHS_MAX} across all activities (mirrors web).
 */
const changedPathsFromActivities = (
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  activeTurnId: TurnId | null,
): ReadonlyArray<string> => {
  const seen = new Set<string>();
  const paths: Array<string> = [];
  for (const activity of activities) {
    if (paths.length >= CHANGED_PATHS_MAX) {
      break;
    }
    if (!activityInTurn(activity, activeTurnId)) {
      continue;
    }
    const itemType = payloadString(activity.payload, "itemType");
    if (itemType !== "file_change" && !itemType.includes("diff")) {
      continue;
    }
    const data =
      typeof activity.payload === "object" && activity.payload !== null
        ? (activity.payload as Record<string, unknown>).data
        : null;
    collectChangedPaths(data, 0, seen, paths);
  }
  return paths;
};

/**
 * Render the changed-files summary (§6). Prefers the **checkpoint path**
 * (`📝 改动 N 文件 (+X -Y)`, one row `{path} (+a -b)` per file). When no checkpoint
 * is associated with the turn, falls back to file names extracted from
 * `file_change` activity payloads (`📝 改动 N 文件`, name-only rows + a
 * `详见终端 / Web 查看 diff` footer line). Never renders diff bodies. Returns null
 * when there are no changed files at all. Single-level collapsible; byte-clamped.
 */
const renderChangedFiles = (
  thread: OrchestrationThread,
  maxBytes: number,
  activeTurnId: TurnId | null,
): { readonly element: CardElement; readonly degraded: boolean } | null => {
  const checkpointFiles = checkpointFilesForTurn(thread, activeTurnId);
  if (checkpointFiles !== null) {
    let additions = 0;
    let deletions = 0;
    const lines: Array<string> = [];
    for (const file of checkpointFiles) {
      additions += file.additions;
      deletions += file.deletions;
      lines.push(`\`${file.path}\`  (+${file.additions} -${file.deletions})`);
    }
    const title = `📝 改动 ${checkpointFiles.length} 文件 (+${additions} -${deletions})`;
    const byBytes = trimToBytes(lines.join("\n\n"), maxBytes);
    return { element: collapsible(title, byBytes.text, false), degraded: byBytes.cut };
  }

  // Degraded fallback: file names only (no line counts) + a pointer footer.
  const paths = changedPathsFromActivities(thread.activities, activeTurnId);
  if (paths.length === 0) {
    return null;
  }
  const title = `📝 改动 ${paths.length} 文件`;
  const body = `${paths.map((path) => `\`${path}\``).join("\n\n")}\n\n详见终端 / Web 查看 diff`;
  const byBytes = trimToBytes(body, maxBytes);
  return { element: collapsible(title, byBytes.text, false), degraded: byBytes.cut };
};

// ── Header + subtitle ─────────────────────────────────────────────────────────

/**
 * Runtime-mode badge for the header: a colored `text_tag` pill that warns, with
 * escalating severity, how un-gated the agent is. Only the *un-gated* modes show
 * a badge — `auto-accept-edits` → yellow `editable`, `full-access` → red
 * `bypass`. `approval-required` (the safe default) shows **no badge**: there is
 * nothing to warn about. Unknown modes fall back to no badge — `RuntimeMode` is
 * a closed enum, so a new mode would need its own deliberate escalation choice
 * rather than a silent guess. `text_tag` renders inline in the header markdown.
 */
const RUNTIME_BADGE: Readonly<Record<RuntimeMode, string>> = {
  "approval-required": "",
  "auto-accept-edits": "<text_tag color='yellow'>editable</text_tag>",
  "full-access": "<text_tag color='red'>bypass</text_tag>",
};
const runtimeBadge = (mode: RuntimeMode): string => RUNTIME_BADGE[mode] ?? "";

/**
 * The runtime mode in effect for the render: the live session's mode when the
 * session exists (it can drift from the thread default mid-turn), else the
 * thread's configured mode.
 */
const effectiveRuntimeMode = (thread: OrchestrationThread): RuntimeMode =>
  thread.session?.runtimeMode ?? thread.runtimeMode;

/**
 * Best-effort workspace/project label for the subtitle: the basename of the
 * thread's worktree path (the closest project-scoped string the renderer is
 * handed — the project title itself lives on `OrchestrationProject`, which this
 * pure renderer never receives). Returns "" when no worktree is set so the
 * caller can gracefully omit the field rather than invent one.
 */
const workspaceLabel = (thread: OrchestrationThread): string => {
  const path = thread.worktreePath;
  if (path === null) {
    return "";
  }
  const segments = path.split("/").filter((segment) => segment.length > 0);
  return segments.length > 0 ? (segments[segments.length - 1] ?? "") : "";
};

/**
 * Header line: `🧵 <title>  <runtime badge?>`. Always renderable (`title` is a
 * required non-empty field). The badge is appended only for un-gated modes
 * (approval-required carries none), so the trailing spacing is conditional to
 * avoid a dangling gap. Small markdown element; still byte-clamped globally.
 */
const renderHeader = (thread: OrchestrationThread): MarkdownElement => {
  const badge = runtimeBadge(effectiveRuntimeMode(thread));
  return markdown(badge.length > 0 ? `🧵 **${thread.title}**  ${badge}` : `🧵 **${thread.title}**`);
};

/**
 * Status-line meta suffix: ` · 📁 <workspace> · 🌿 <branch>`. Each segment is
 * included only when its source field is present (missing workspace / null
 * branch gracefully omitted). Folded into the status line instead of a separate
 * subtitle row — workspace/branch are low-value in 1:1 chat and don't warrant a
 * dedicated line. Returns "" when nothing to show. Runtime mode is NOT here: the
 * header badge ({@link runtimeBadge}) already carries it.
 */
const statusMetaSuffix = (thread: OrchestrationThread): string => {
  const segments: Array<string> = [];
  const workspace = workspaceLabel(thread);
  if (workspace.length > 0) {
    segments.push(`📁 ${workspace}`);
  }
  if (thread.branch !== null) {
    segments.push(`🌿 ${thread.branch}`);
  }
  return segments.length > 0 ? ` · ${segments.join(" · ")}` : "";
};

// ── Card envelope ───────────────────────────────────────────────────────────

/** A short plain-text summary for the card's notification/preview line. */
const truncateSummary = (text: string): string => {
  const firstLine = text.split("\n", 1)[0] ?? "";
  return firstLine.length > 80 ? `${firstLine.slice(0, 80)}…` : firstLine;
};

/**
 * Final guard: any element still over the hard ceiling after section-level
 * trimming gets its markdown content clamped to bytes. Guarantees no element
 * can abort the stream regardless of how content was composed.
 */
const clampElement = (
  element: CardElement,
  maxBytes: number,
): { readonly element: CardElement; readonly degraded: boolean } => {
  if (elementBytes(element) <= maxBytes) {
    return { element, degraded: false };
  }
  // Re-clamp the visible markdown content against a content-only budget. We
  // subtract the element's structural overhead (its serialized size minus the
  // content) from the ceiling so the whole element lands under the limit.
  const e = element as { tag?: string; content?: string };
  if (e.tag === "markdown" && typeof e.content === "string") {
    const overhead = elementBytes({ ...e, content: "" } as CardElement);
    const budget = Math.max(0, maxBytes - overhead);
    const candidate = markdown(trimToBytes(e.content, budget).text);
    // `trimToBytes` measures the *raw* UTF-8 content, but the wire bytes are the
    // JSON-serialized element — escape expansion (\n, ", \\, control chars each
    // cost +1 byte) can push a "fits the budget" content back over the ceiling
    // (e.g. a multi-line stack-trace lastError banner). Re-measure the serialized
    // element; if it still overflows, fall through to the marker fallback. (#7/#8)
    if (elementBytes(candidate) <= maxBytes) {
      return { element: candidate, degraded: true };
    }
  }
  // Collapsible (or unknown) element, or markdown whose escape expansion still
  // overflows: collapse to a degraded marker.
  return { element: markdown("… [content too large; collapsed]"), degraded: true };
};

/**
 * Render the current thread state into a card (v3 layout — see the module
 * docstring for the full top→bottom section order). Every element is
 * byte-estimated and degraded to stay under `opts.maxElementBytes ??
 * MAX_ELEMENT_BYTES`. `streaming_mode` is set from `opts.streaming`.
 *
 * `opts.density` is a forward seam for M3 group-chat noise control. Only `card`
 * (the full layout) is implemented today; `markdown`/`text` fall back to the
 * `card` behaviour (see the density switch below).
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

  // Density seam (M2b-2). Resolve to a layout mode; only `card` is implemented.
  // TODO(M3): 群聊降噪密度 — `markdown` (drop chrome, body-only) / `text` (plain
  // line) for noisy group chats. Until then both fall back to the `card` layout.
  const density = opts.density ?? "card";
  switch (density) {
    case "markdown":
    case "text":
    // TODO(M3): 群聊降噪密度 — distinct low-noise layouts. Fall through to `card`.
    case "card":
      break;
  }

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
  // body and have no meaningful title to surface).
  const withChrome = opts.chrome !== false;
  if (withChrome) {
    elements.push(renderHeader(thread));
  }

  // 2. Top error banner (session.lastError). Above the body; kept even when
  // chrome=false (a hard session error still surfaces on a notice card). Turn
  // error-tone activities are NOT here — they fold into the activity stream.
  const banner = renderErrorBanner(thread, contentBytes);
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
    const statusLine = suppressIdleDone
      ? null
      : renderStatusLine(turnStatus, turnDuration(thread), statusMetaSuffix(thread));
    if (statusLine) {
      elements.push(statusLine);
    } else if (turnStatus === "error" && banner === null) {
      elements.push(markdown("⚠️ 出错"));
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
    startProcessGroup();
    const plan = renderPlanPanel(planSteps, contentBytes);
    for (const planElement of plan.elements) {
      elements.push(planElement);
    }
    degraded = degraded || plan.degraded;
  }

  // 5. Unified activity stream (tool.* + task.* merged): current step always
  // visible + single-level history fold (RUNNING), or one folded summary (DONE).
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

  // 6. Changed files summary (📝 改动 N 文件 …). Checkpoint path (with line counts)
  // when a checkpoint is associated with this turn, else degraded file-name list.
  // Only on a settled (non-RUNNING) turn (§9.4 default: DONE-only): mid-turn
  // checkpoints can carry the running turn's files, and the same edits already
  // show as 🔧 rows in the activity stream — rendering both would double-display.
  if (!isRunning) {
    const changed = renderChangedFiles(thread, contentBytes, turnIdForFilter);
    if (changed) {
      startProcessGroup();
      elements.push(changed.element);
      degraded = degraded || changed.degraded;
    }
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
    const trimmed = trimToBytes(assistant, contentBytes);
    degraded = degraded || trimmed.cut;
    elements.push(markdown(trimmed.text));
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
