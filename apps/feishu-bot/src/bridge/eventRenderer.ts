/**
 * Pure renderer: reducer state → CardKit 2.0 card JSON (M6, v2 card render M2b-2).
 *
 * Consumes an {@link OrchestrationThread} (the local state maintained by
 * `session.ts` via `applyThreadDetailEvent`) and produces the card to push.
 * Assistant text comes from `thread.messages` (role `"assistant"`); reasoning
 * and tool activity come from `thread.activities`. Reasoning is folded by
 * default. Every element is byte-estimated and degraded (folded tool output,
 * truncated reasoning, trimmed long output) to stay under Feishu's ~30KB
 * per-element ceiling — exceeding it aborts the whole stream with a 400.
 *
 * Card layout (v2): header line (🧵 title + runtime badge) → subtitle
 * (📁 workspace · 🌿 branch · 🔒 runtimeMode) → assistant body (or a "⏳ 处理中…"
 * working indicator while streaming and empty) → reasoning panel (🧠, dynamic
 * expand/collapse) → tools panel (single 🔧 collapsible, one row per tool) →
 * interaction section (injected) → error footer. Every element — including the
 * header/subtitle/working/tool rows — passes through {@link clampElement}.
 *
 * Strictly pure: no IO, no clock, no randomness. The card JSON is hand-built
 * CardKit 2.0 DSL (the SDK treats it as an opaque `object`). Only CardKit 2.0
 * tags are used (markdown / hr / collapsible_panel — never `checkbox`, which
 * 400s the whole stream).
 */
import type {
  OrchestrationMessage,
  OrchestrationThread,
  OrchestrationThreadActivity,
  RuntimeMode,
  TurnId,
} from "@t3tools/contracts";

import type { CardElement, CardJson } from "../lark/card.ts";
import type { RenderOptions as BaseRenderOptions, RenderResult } from "./types.ts";

/**
 * Forward seam for M3 group-chat noise control. `card` is the full v2 layout
 * (header + subtitle + body + reasoning + tools + interaction + error); the
 * other modes are reserved (today they fall back to `card`).
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
   * Whether to render the v2 chrome: header line (🧵 title + runtime badge) and
   * subtitle (📁 workspace · 🌿 branch · 🔒 runtimeMode). Defaults to `true`.
   *
   * Set to `false` for notice/status cards (makeNoticeThread / sendNotice paths)
   * that carry only a short text body — the chrome is meaningless there (the
   * notice thread has no real title or workspace) and adds visual noise. All
   * other sections (body, reasoning, tools, interaction, error footer) are
   * unaffected; every element still passes through {@link clampElement}.
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
/** Reasoning panels are folded and trimmed hard — they're secondary content. */
const REASONING_MAX_CHARS = 1_500;
/** A single tool's detail line before it gets trimmed. */
const TOOL_DETAIL_MAX_CHARS = 800;
/** Marker appended to any text we had to cut. */
const TRUNCATION_MARKER = "\n\n… [truncated]";
/**
 * Appended to a tool detail row when its content was truncated. Diff/file-change
 * tools can carry far more than {@link TOOL_DETAIL_MAX_CHARS}; rather than mint a
 * deep link we point the operator at the terminal/Web where the full diff lives.
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

// ── Activity classification ─────────────────────────────────────────────────

const isToolActivity = (activity: OrchestrationThreadActivity): boolean => activity.tone === "tool";

const isReasoningActivity = (activity: OrchestrationThreadActivity): boolean =>
  activity.kind === "task.progress" ||
  activity.kind === "task.started" ||
  activity.kind === "task.completed";

const isErrorActivity = (activity: OrchestrationThreadActivity): boolean =>
  activity.tone === "error";

/**
 * Read a string field off an activity payload without trusting its shape
 * (payload is `Schema.Unknown`; see `ProviderRuntimeIngestion` for the keys
 * the server actually writes — `itemType`/`status`/`detail`/`data`). Returns ""
 * when absent.
 */
const payloadString = (
  payload: unknown,
  key: "detail" | "summary" | "itemType" | "status",
): string => {
  if (typeof payload !== "object" || payload === null) {
    return "";
  }
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
};

// ── Section renderers ───────────────────────────────────────────────────────

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
 * Mirrors {@link latestAssistantText}'s body scope so the reasoning/tool/error
 * panels don't show the *previous* turn's activity during a reused thread's
 * working-indicator (`⏳ 处理中…`) window — or the *whole thread's* history on a completed turn's
 * terminal card. The `activeTurnId` argument is the resolved filter basis
 * (`opts.currentTurnId ?? thread.session.activeTurnId`): when `driveTurn` passes
 * `currentTurnId`, this stays non-null through completion and keeps the terminal
 * render pinned to this turn. Same turnId=null tolerance: when the basis is null
 * (no turn folded in yet, or a non-`driveTurn` post-completion render) every
 * activity is in scope; when scoped we keep activities tagged for it **plus**
 * those with an untagged (null) turnId — only activities *explicitly* tagged for
 * a different turn are dropped.
 */
const activityInTurn = (
  activity: OrchestrationThreadActivity,
  activeTurnId: TurnId | null,
): boolean => activeTurnId === null || activity.turnId === null || activity.turnId === activeTurnId;

/**
 * Render the reasoning panel from `task.progress` activities. Prefers
 * `payload.summary` (the reasoning_summary_text) over `payload.detail`.
 * Hard-trimmed to {@link REASONING_MAX_CHARS} then to bytes. Scoped to
 * `activeTurnId` (see {@link activityInTurn}) to stay consistent with the body.
 *
 * Dynamic expand/collapse (v2): while the turn is still running we surface the
 * thinking expanded with a "🧠 思考中…" header so the operator sees it stream;
 * once the turn completes we collapse it to "🧠 思考完成,点击查看" so the terminal
 * card stays compact. Either way the (possibly large) joined content is byte-
 * clamped here AND again by the global {@link clampElement} guard. This panel
 * appears ONLY when there is real reasoning activity — it is never the working
 * indicator (that is `⏳ 处理中…` in the body position).
 */
const renderReasoning = (
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  maxBytes: number,
  activeTurnId: TurnId | null,
  inProgress: boolean,
): { readonly element: CollapsiblePanelElement; readonly degraded: boolean } | null => {
  const lines: Array<string> = [];
  for (const activity of activities) {
    if (!isReasoningActivity(activity) || !activityInTurn(activity, activeTurnId)) {
      continue;
    }
    const summary = payloadString(activity.payload, "summary");
    const detail = payloadString(activity.payload, "detail");
    const line = (summary || detail || activity.summary).trim();
    if (line.length > 0) {
      lines.push(line);
    }
  }
  if (lines.length === 0) {
    return null;
  }
  const joined = lines.join("\n\n");
  const byChars = trimToChars(joined, REASONING_MAX_CHARS);
  const byBytes = trimToBytes(byChars.text, maxBytes);
  const title = inProgress ? "🧠 思考中…" : "🧠 思考完成,点击查看";
  return {
    element: collapsible(title, byBytes.text, inProgress),
    degraded: byChars.cut || byBytes.cut,
  };
};

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
 * Grouping key for a single tool call: turn + canonical item type + the
 * normalized instance label. `itemType` alone collides when one turn runs two
 * tools of the same kind, so the label disambiguates them.
 */
const toolInstanceKey = (activity: OrchestrationThreadActivity): string =>
  `${activity.turnId ?? ""}::${payloadString(activity.payload, "itemType")}::${toolInstanceLabel(
    activity,
  )}`;

/**
 * Collapse the per-lifecycle tool activities into one entry per tool instance,
 * keeping the latest/terminal phase of each. Insertion order = first-seen order
 * so the rendered list is stable as updates stream in.
 */
const aggregateToolActivities = (
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  activeTurnId: TurnId | null,
): ReadonlyArray<OrchestrationThreadActivity> => {
  const latestByKey = new Map<string, OrchestrationThreadActivity>();
  for (const activity of activities) {
    if (!isToolActivity(activity) || !activityInTurn(activity, activeTurnId)) {
      continue;
    }
    const key = toolInstanceKey(activity);
    const prev = latestByKey.get(key);
    if (prev === undefined || isLaterPhase(activity, prev)) {
      latestByKey.set(key, activity);
    }
  }
  return Array.from(latestByKey.values());
};

/**
 * True when `next` represents a later lifecycle state than `current` for the
 * same tool call. Ranks by phase first (started → updated → completed), then by
 * `sequence` (monotonic per thread) so re-emitted updates don't regress.
 */
const isLaterPhase = (
  next: OrchestrationThreadActivity,
  current: OrchestrationThreadActivity,
): boolean => {
  const nextRank = TOOL_PHASE_RANK[next.kind] ?? 0;
  const currentRank = TOOL_PHASE_RANK[current.kind] ?? 0;
  if (nextRank !== currentRank) {
    return nextRank > currentRank;
  }
  return (next.sequence ?? 0) >= (current.sequence ?? 0);
};

/**
 * Terminal status of one aggregated tool instance, derived from its kept phase.
 * `tool.completed` → completed/failed (failed when its status payload says so or
 * its tone flipped to error); anything earlier (started/updated) → inProgress.
 */
type ToolStatus = "completed" | "inProgress" | "failed";

const toolStatus = (activity: OrchestrationThreadActivity): ToolStatus => {
  if (activity.tone === "error") {
    return "failed";
  }
  if (activity.kind === "tool.completed") {
    const status = payloadString(activity.payload, "status").toLowerCase();
    return status === "failed" || status === "error" ? "failed" : "completed";
  }
  return "inProgress";
};

const TOOL_STATUS_ICON: Readonly<Record<ToolStatus, string>> = {
  completed: "✓",
  inProgress: "⏳",
  failed: "✗",
};

/**
 * Render one aggregated tool instance as a single markdown line inside the tools
 * panel: `<status icon> \`<label>\`  <truncated detail>`.
 *
 * Truncation suffix policy (no double-suffix):
 * - Not truncated → detail as-is.
 * - Truncated, NOT a diff/file_change type → detail ends with
 *   {@link TRUNCATION_MARKER} (already baked in by {@link trimToChars}).
 * - Truncated AND diff/file_change → replace the generic
 *   {@link TRUNCATION_MARKER} suffix with {@link DIFF_OVERFLOW_HINT} so the
 *   operator knows where to see the full diff without a redundant double-suffix.
 */
const renderToolLine = (activity: OrchestrationThreadActivity): string => {
  const icon = TOOL_STATUS_ICON[toolStatus(activity)] ?? "•";
  const head = `${icon} \`${toolInstanceLabel(activity)}\``;
  const detail = payloadString(activity.payload, "detail");
  if (detail.length === 0) {
    return head;
  }
  const clipped = trimToChars(detail, TOOL_DETAIL_MAX_CHARS);
  let tail: string;
  if (clipped.cut) {
    const itemType = payloadString(activity.payload, "itemType");
    const isDiff = itemType === "file_change" || itemType.includes("diff");
    if (isDiff) {
      // Strip the generic TRUNCATION_MARKER already embedded by trimToChars and
      // replace it with the diff-specific hint. The marker is a fixed string so
      // slicing it off is safe and allocation-minimal.
      const base = clipped.text.endsWith(TRUNCATION_MARKER)
        ? clipped.text.slice(0, clipped.text.length - TRUNCATION_MARKER.length)
        : clipped.text;
      tail = `${base}${DIFF_OVERFLOW_HINT}`;
    } else {
      // Non-diff truncation: TRUNCATION_MARKER is already baked into clipped.text.
      tail = clipped.text;
    }
  } else {
    tail = clipped.text;
  }
  return `${head}  ${tail}`;
};

/**
 * Render tool activity (v2). Lifecycle rows are first aggregated to one entry
 * per tool instance (started/updated/completed → its terminal state). Regardless
 * of count, every tool renders into ONE collapsed `collapsible_panel`: the
 * folded header reads `🔧 N 个工具 (X✓ Y⏳ [Z✗])` (Z omitted when no failures) and
 * the expanded body is one markdown line per tool. The combined body is byte-
 * clamped here and again by the global {@link clampElement} guard. Returns null
 * when there are no tools (0-tool turns render nothing). Scoped to `activeTurnId`
 * (see {@link activityInTurn}) to stay consistent with the body.
 */
const renderTools = (
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  maxBytes: number,
  activeTurnId: TurnId | null,
): { readonly element: CardElement; readonly degraded: boolean } | null => {
  const tools = aggregateToolActivities(activities, activeTurnId);
  if (tools.length === 0) {
    return null;
  }
  let completed = 0;
  let inProgress = 0;
  let failed = 0;
  for (const tool of tools) {
    const status = toolStatus(tool);
    if (status === "completed") {
      completed += 1;
    } else if (status === "failed") {
      failed += 1;
    } else {
      inProgress += 1;
    }
  }
  const counts = `${completed}✓ ${inProgress}⏳` + (failed > 0 ? ` ${failed}✗` : "");
  const title = `🔧 ${tools.length} 个工具 (${counts})`;
  const joined = tools.map(renderToolLine).join("\n\n");
  const byBytes = trimToBytes(joined, maxBytes);
  return {
    element: collapsible(title, byBytes.text, false),
    degraded: byBytes.cut,
  };
};

/**
 * Render the error footer from session.lastError and any error-tone activities.
 *
 * Error-tone activities are turn-scoped via {@link activityInTurn} (same basis
 * as reasoning/tools) so a completed turn's terminal card doesn't fold in
 * earlier turns' errors. `session.lastError` is session-level (not turn-tagged)
 * and is left as-is — it already reflects the latest error on the session.
 */
const renderError = (
  thread: OrchestrationThread,
  maxBytes: number,
  activeTurnId: TurnId | null,
): MarkdownElement | null => {
  const parts: Array<string> = [];
  const lastError = thread.session?.lastError ?? null;
  if (lastError) {
    parts.push(lastError);
  }
  for (const activity of thread.activities) {
    if (isErrorActivity(activity) && activityInTurn(activity, activeTurnId)) {
      const detail = payloadString(activity.payload, "detail");
      parts.push(detail.length > 0 ? `${activity.summary}: ${detail}` : activity.summary);
    }
  }
  if (parts.length === 0) {
    return null;
  }
  const body = `**⚠️ Error**\n${parts.join("\n")}`;
  return markdown(trimToBytes(body, maxBytes).text);
};

// ── Header + subtitle (v2) ───────────────────────────────────────────────────

/**
 * Emoji badge for a runtime mode, surfaced in the header line so the operator
 * sees at a glance what the agent is allowed to do. `approval-required` (🔒) is
 * the only gated mode; `full-access` (✅) and `auto-accept-edits` (✏️) run
 * un-gated. Unknown modes fall back to 🔒 (treat-as-gated, never under-warn).
 */
const RUNTIME_BADGE: Readonly<Record<RuntimeMode, string>> = {
  "approval-required": "🔒",
  "auto-accept-edits": "✏️",
  "full-access": "✅",
};
const runtimeBadge = (mode: RuntimeMode): string => RUNTIME_BADGE[mode] ?? "🔒";

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
 * Header line: `🧵 <title>  <runtime badge>`. Always renderable (`title` is a
 * required non-empty field). Small markdown element; still byte-clamped globally.
 */
const renderHeader = (thread: OrchestrationThread): MarkdownElement =>
  markdown(`🧵 **${thread.title}**  ${runtimeBadge(effectiveRuntimeMode(thread))}`);

/**
 * Subtitle line: `📁 <workspace> · 🌿 <branch> · 🔒 <runtimeMode>`. Each segment
 * is included only when its source field is present — a missing workspace or a
 * null branch is gracefully omitted (no placeholder/invented value). The runtime
 * mode is always present, so the subtitle always carries at least that segment.
 */
const renderSubtitle = (thread: OrchestrationThread): MarkdownElement => {
  const mode = effectiveRuntimeMode(thread);
  const segments: Array<string> = [];
  const workspace = workspaceLabel(thread);
  if (workspace.length > 0) {
    segments.push(`📁 ${workspace}`);
  }
  if (thread.branch !== null) {
    segments.push(`🌿 ${thread.branch}`);
  }
  segments.push(`${runtimeBadge(mode)} ${mode}`);
  return markdown(segments.join(" · "));
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
    return { element: markdown(trimToBytes(e.content, budget).text), degraded: true };
  }
  // Collapsible (or unknown) element: collapse to a degraded marker.
  return { element: markdown("… [content too large; collapsed]"), degraded: true };
};

/**
 * Render the current thread state into a card.
 *
 * Element order (v2): header (🧵 title + runtime badge) → subtitle
 * (📁 workspace · 🌿 branch · 🔒 runtimeMode) → assistant body (or `⏳ 处理中…`
 * working indicator while streaming with no body yet) → reasoning panel (🧠,
 * expanded while the turn runs, collapsed once it completes) → tools panel
 * (single 🔧 collapsible, one row per tool) → interaction section → error footer.
 * Every element is byte-estimated and degraded to stay under
 * `opts.maxElementBytes ?? MAX_ELEMENT_BYTES`. `streaming_mode` is set from
 * `opts.streaming`.
 *
 * `opts.density` is a forward seam for M3 group-chat noise control. Only `card`
 * (the full layout above) is implemented today; `markdown`/`text` fall back to
 * the `card` behaviour (see the density switch below).
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

  // Turn scope shared by the body and the reasoning/tool/error panels so a
  // reused thread's working-indicator (`⏳ 处理中…`) window doesn't surface the
  // previous turn's content (see latestAssistantText / activityInTurn).
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
  // provider status is `running`/`starting`). Drives the reasoning panel's
  // expand/collapse. `streaming` alone isn't enough — it's a card-state marker
  // the caller sets — so we also read the live session. Session-less placeholder
  // threads (notices) read as not-in-progress: their `activeTurnId` is absent,
  // not null, so we check the session exists before trusting it.
  const sessionStatus = thread.session?.status ?? null;
  const inProgress =
    opts.streaming ||
    (thread.session != null && thread.session.activeTurnId !== null) ||
    sessionStatus === "running" ||
    sessionStatus === "starting";

  // 1. Header + subtitle (always renderable: title/runtimeMode are required).
  // Skipped when `opts.chrome === false` (notice/status cards that carry only a
  // short text body and have no meaningful title or workspace to surface).
  const withChrome = opts.chrome !== false;
  if (withChrome) {
    elements.push(renderHeader(thread));
    elements.push(renderSubtitle(thread));
  }

  // 2. Assistant body (primary). Empty while streaming → `⏳ 处理中…` working
  // indicator (a working signal, NOT "thinking" — real reasoning lives in the
  // 🧠 panel below). Rendered in the body position, never as a fold.
  const assistant = latestAssistantText(thread.messages, turnIdForFilter);
  if (assistant.length > 0) {
    const trimmed = trimToBytes(assistant, contentBytes);
    degraded = degraded || trimmed.cut;
    elements.push(markdown(trimmed.text));
  } else if (opts.streaming) {
    elements.push(markdown("⏳ 处理中…"));
  }

  // 3. Reasoning (🧠). Expanded while the turn runs ("🧠 思考中…"), collapsed once
  // it completes ("🧠 思考完成,点击查看"). Only present with real reasoning activity.
  const reasoning = renderReasoning(thread.activities, contentBytes, turnIdForFilter, inProgress);
  if (reasoning) {
    elements.push(reasoning.element);
    degraded = degraded || reasoning.degraded;
  }

  // 4. Tools (single 🔧 collapsible, one row per tool; 0 tools → nothing).
  const tools = renderTools(thread.activities, contentBytes, turnIdForFilter);
  if (tools) {
    if (elements.length > 0) {
      elements.push(divider());
    }
    elements.push(tools.element);
    degraded = degraded || tools.degraded;
  }

  // 5. Interaction section (pre-rendered by interactionCard, injected via opts).
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

  // 6. Error footer (already byte-clamped inside renderError). Turn-scoped to
  // match the body/reasoning/tools so a completed turn's terminal card doesn't
  // surface earlier turns' errors.
  const error = renderError(thread, contentBytes, turnIdForFilter);
  if (error) {
    elements.push(divider());
    elements.push(error);
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
