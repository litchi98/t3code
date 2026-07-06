/**
 * Status chrome: turn display status, duration, status line, error banners,
 * header, runtime badge and subtitle meta (extracted from `eventRenderer.ts`;
 * M6, card render v3, M2b-4). Strictly pure: no IO.
 */
import type { OrchestrationThread, RuntimeMode } from "@t3tools/contracts";

import { trimToBytes } from "./budget.ts";
import { type MarkdownElement, markdown } from "./elements.ts";

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

export const deriveTurnDisplayStatus = (
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
export const turnDuration = (thread: OrchestrationThread): string | null => {
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
export const renderStatusLine = (
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
export const renderErrorBanner = (
  thread: OrchestrationThread,
  maxBytes: number,
): MarkdownElement | null => {
  const lastError = thread.session?.lastError ?? null;
  if (lastError === null || lastError.length === 0) {
    return null;
  }
  return markdown(trimToBytes(`⚠️ **错误**\n${lastError}`, maxBytes).text);
};

/** Max chars of the session error's first line kept in the `text`-density banner. */
const ERROR_FIRST_LINE_MAX_CHARS = 120;

/**
 * Compact error banner for the `text` density: the first line of the session
 * `lastError`, truncated to {@link ERROR_FIRST_LINE_MAX_CHARS} chars and prefixed
 * with ⚠️. Drops the bold "错误" label and any multi-line stack trace — `text`
 * density keeps only a one-line error signal above the body. Returns null when
 * there is no session error (same source/gate as {@link renderErrorBanner}).
 */
export const renderErrorBannerFirstLine = (thread: OrchestrationThread): MarkdownElement | null => {
  const lastError = thread.session?.lastError ?? null;
  if (lastError === null || lastError.length === 0) {
    return null;
  }
  const firstLine = lastError.split("\n", 1)[0] ?? "";
  const clipped =
    firstLine.length > ERROR_FIRST_LINE_MAX_CHARS
      ? `${firstLine.slice(0, ERROR_FIRST_LINE_MAX_CHARS)}…`
      : firstLine;
  return markdown(`⚠️ ${clipped}`);
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
export const renderHeader = (thread: OrchestrationThread): MarkdownElement => {
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
export const statusMetaSuffix = (thread: OrchestrationThread): string => {
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
