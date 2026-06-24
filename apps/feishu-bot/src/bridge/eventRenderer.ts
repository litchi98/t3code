/**
 * Pure renderer: reducer state → CardKit 2.0 card JSON (M6).
 *
 * Consumes an {@link OrchestrationThread} (the local state maintained by
 * `session.ts` via `applyThreadDetailEvent`) and produces the card to push.
 * Assistant text comes from `thread.messages` (role `"assistant"`); reasoning
 * and tool activity come from `thread.activities`. Reasoning is folded by
 * default. Every element is byte-estimated and degraded (folded tool output,
 * truncated reasoning, trimmed long output) to stay under Feishu's ~30KB
 * per-element ceiling — exceeding it aborts the whole stream with a 400.
 *
 * Strictly pure: no IO, no clock, no randomness. The card JSON is hand-built
 * CardKit 2.0 DSL (the SDK treats it as an opaque `object`).
 */
import type {
  OrchestrationMessage,
  OrchestrationThread,
  OrchestrationThreadActivity,
  TurnId,
} from "@t3tools/contracts";

import type { CardElement, CardJson } from "../lark/card.ts";
import type { RenderOptions, RenderResult } from "./types.ts";

/** Feishu's per-element size limit. Elements estimated above this are degraded. */
export const MAX_ELEMENT_BYTES = 30_000;

// ── Degradation budgets ───────────────────────────────────────────────────
// Headroom below MAX_ELEMENT_BYTES so the JSON envelope (tag/field keys, escape
// expansion of the markdown content) can't push a "safe" element over the wire
// limit. We size content against this rather than the raw ceiling.
const SAFE_ELEMENT_BYTES = 28_000;
/** Reasoning panels are folded and trimmed hard — they're secondary content. */
const REASONING_MAX_CHARS = 1_500;
/** A single tool's inline output before it gets folded/trimmed. */
const TOOL_DETAIL_MAX_CHARS = 800;
/**
 * Fold tool activity into one collapsible once this many *distinct tools*
 * appear. Counted per tool instance (started/updated/completed of one call
 * collapse to one), not per lifecycle activity row.
 */
const TOOL_FOLD_THRESHOLD = 3;
/** Marker appended to any text we had to cut. */
const TRUNCATION_MARKER = "\n\n… [truncated]";

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
 * When `activeTurnId` is null (the final render after completion, or before the
 * turn starts) we fall back to the most recent assistant message overall — which
 * is this turn's reply once it has completed. This fallback's correctness relies
 * on the bridge serializing turns single-ended: with one end's turn at a time,
 * "most recent" *is* this turn. M2 TODO: under cross-end concurrency this can
 * pick up a *different* end's reply at the completed terminal — the body then
 * needs anchoring on this turn's own `turnId` rather than "latest overall".
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
    // whole turn would stay stuck on `_thinking…_` and this turn's text would be
    // wrongly dropped.
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
 * Mirrors {@link latestAssistantText}'s body scope so the reasoning/tool panels
 * don't show the *previous* turn's activity during a reused thread's
 * `_thinking…_` window. Same turnId=null tolerance: when `activeTurnId` is null
 * (no turn folded in yet, or final post-completion render) every activity is in
 * scope; when a turn is running we keep activities tagged for it **plus** those
 * with an untagged (null) turnId — only activities *explicitly* tagged for a
 * different turn are dropped.
 */
const activityInTurn = (
  activity: OrchestrationThreadActivity,
  activeTurnId: TurnId | null,
): boolean => activeTurnId === null || activity.turnId === null || activity.turnId === activeTurnId;

/**
 * Render the reasoning panel from `task.progress` activities. Folded by default;
 * prefers `payload.summary` (the reasoning_summary_text) over `payload.detail`.
 * Hard-trimmed to {@link REASONING_MAX_CHARS} then to bytes. Scoped to
 * `activeTurnId` (see {@link activityInTurn}) to stay consistent with the body.
 */
const renderReasoning = (
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  maxBytes: number,
  activeTurnId: TurnId | null,
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
  return {
    element: collapsible("🧠 Reasoning", byBytes.text, false),
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
 * Render one aggregated tool instance as a single markdown line: its (de-suffixed)
 * label plus the terminal-phase detail, truncated.
 */
const renderToolLine = (activity: OrchestrationThreadActivity): string => {
  const detail = payloadString(activity.payload, "detail");
  const head = `\`${toolInstanceLabel(activity)}\``;
  if (detail.length === 0) {
    return head;
  }
  const trimmed = trimToChars(detail, TOOL_DETAIL_MAX_CHARS).text;
  return `${head}\n${trimmed}`;
};

/**
 * Render tool activity. Lifecycle rows are first aggregated to one entry per
 * tool instance (started/updated/completed → its terminal state), so the fold
 * threshold and degraded flag reflect the real tool count, not the activity
 * count. ≤ {@link TOOL_FOLD_THRESHOLD} tools render inline as a markdown
 * element; more fold into a single collapsed panel. Either way the combined
 * content is byte-clamped. Scoped to `activeTurnId` (see {@link activityInTurn})
 * to stay consistent with the body.
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
  const lines = tools.map(renderToolLine);
  const joined = lines.join("\n\n");
  const fold = tools.length >= TOOL_FOLD_THRESHOLD;
  const byBytes = trimToBytes(joined, maxBytes);
  const degraded = fold || byBytes.cut;
  if (fold) {
    return {
      element: collapsible(`🛠️ Tools (${tools.length})`, byBytes.text, false),
      degraded: true,
    };
  }
  return { element: markdown(byBytes.text), degraded };
};

/**
 * Render the error footer from session.lastError and any error-tone activities.
 */
const renderError = (thread: OrchestrationThread, maxBytes: number): MarkdownElement | null => {
  const parts: Array<string> = [];
  const lastError = thread.session?.lastError ?? null;
  if (lastError) {
    parts.push(lastError);
  }
  for (const activity of thread.activities) {
    if (isErrorActivity(activity)) {
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
 * Element order: assistant body → reasoning (folded) → tools → error footer.
 * Every element is byte-estimated and degraded to stay under
 * `opts.maxElementBytes ?? MAX_ELEMENT_BYTES`. `streaming_mode` is set from
 * `opts.streaming`.
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

  const elements: Array<CardElement> = [];
  let degraded = false;

  // Turn scope shared by the body and the reasoning/tool panels so a reused
  // thread's `_thinking…_` window doesn't surface the previous turn's content
  // (see latestAssistantText / activityInTurn).
  const activeTurnId = thread.session?.activeTurnId ?? null;

  // 1. Assistant body (primary). Empty → "thinking" placeholder while streaming.
  const assistant = latestAssistantText(thread.messages, activeTurnId);
  if (assistant.length > 0) {
    const trimmed = trimToBytes(assistant, contentBytes);
    degraded = degraded || trimmed.cut;
    elements.push(markdown(trimmed.text));
  } else if (opts.streaming) {
    elements.push(markdown("_thinking…_"));
  }

  // 2. Reasoning (folded by default).
  const reasoning = renderReasoning(thread.activities, contentBytes, activeTurnId);
  if (reasoning) {
    elements.push(reasoning.element);
    degraded = degraded || reasoning.degraded;
  }

  // 3. Tools (inline when few, folded when ≥ threshold).
  const tools = renderTools(thread.activities, contentBytes, activeTurnId);
  if (tools) {
    if (elements.length > 0) {
      elements.push(divider());
    }
    elements.push(tools.element);
    degraded = degraded || tools.degraded;
  }

  // 4. Error footer (already byte-clamped inside renderError).
  const error = renderError(thread, contentBytes);
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
