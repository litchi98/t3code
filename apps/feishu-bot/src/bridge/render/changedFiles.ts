/**
 * Changed-files summary: the checkpoint path (with +/- line counts) or the
 * degraded file-name fallback from `file_change` activities, as a collapsible
 * panel or a low-noise single-line summary (extracted from `eventRenderer.ts`;
 * M6, card render v3, M2b-4). Strictly pure: no IO.
 */
import type {
  OrchestrationCheckpointFile,
  OrchestrationThread,
  OrchestrationThreadActivity,
  TurnId,
} from "@t3tools/contracts";

import type { CardElement } from "../../lark/card.ts";
import { trimToBytes } from "./budget.ts";
import { type MarkdownElement, collapsible, markdown } from "./elements.ts";
import { activityInTurn, payloadString } from "./turnScope.ts";

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
 * Aggregate changed-file data for the rendered turn: the checkpoint files (with
 * summed +/- line counts) when a checkpoint is associated with the turn, else the
 * degraded file-name fallback from `file_change` activities. Shared by the full
 * collapsible ({@link renderChangedFiles}) and the low-noise single-line summary
 * ({@link renderChangedFilesSummary}) so both agree on count/totals/title. Returns
 * null when there are no changed files at all.
 */
type ChangedFilesData =
  | {
      readonly kind: "checkpoint";
      readonly files: ReadonlyArray<OrchestrationCheckpointFile>;
      readonly additions: number;
      readonly deletions: number;
    }
  | { readonly kind: "fallback"; readonly paths: ReadonlyArray<string> };

const aggregateChangedFiles = (
  thread: OrchestrationThread,
  activeTurnId: TurnId | null,
): ChangedFilesData | null => {
  const checkpointFiles = checkpointFilesForTurn(thread, activeTurnId);
  if (checkpointFiles !== null) {
    let additions = 0;
    let deletions = 0;
    for (const file of checkpointFiles) {
      additions += file.additions;
      deletions += file.deletions;
    }
    return { kind: "checkpoint", files: checkpointFiles, additions, deletions };
  }
  const paths = changedPathsFromActivities(thread.activities, activeTurnId);
  if (paths.length === 0) {
    return null;
  }
  return { kind: "fallback", paths };
};

/** Title line shared by the collapsible panel and the low-noise summary. */
const changedFilesTitle = (data: ChangedFilesData): string =>
  data.kind === "checkpoint"
    ? `📝 改动 ${data.files.length} 文件 (+${data.additions} -${data.deletions})`
    : `📝 改动 ${data.paths.length} 文件`;

/**
 * Render the changed-files summary (§6). Prefers the **checkpoint path**
 * (`📝 改动 N 文件 (+X -Y)`, one row `{path} (+a -b)` per file). When no checkpoint
 * is associated with the turn, falls back to file names extracted from
 * `file_change` activity payloads (`📝 改动 N 文件`, name-only rows + a
 * `详见终端 / Web 查看 diff` footer line). Never renders diff bodies. Returns null
 * when there are no changed files at all. Single-level collapsible; byte-clamped.
 */
export const renderChangedFiles = (
  thread: OrchestrationThread,
  maxBytes: number,
  activeTurnId: TurnId | null,
): { readonly element: CardElement; readonly degraded: boolean } | null => {
  const data = aggregateChangedFiles(thread, activeTurnId);
  if (data === null) {
    return null;
  }
  const title = changedFilesTitle(data);
  if (data.kind === "checkpoint") {
    const lines = data.files.map(
      (file) => `\`${file.path}\`  (+${file.additions} -${file.deletions})`,
    );
    const byBytes = trimToBytes(lines.join("\n\n"), maxBytes);
    return { element: collapsible(title, byBytes.text, false), degraded: byBytes.cut };
  }
  // Degraded fallback: file names only (no line counts) + a pointer footer.
  const body = `${data.paths.map((path) => `\`${path}\``).join("\n\n")}\n\n详见终端 / Web 查看 diff`;
  const byBytes = trimToBytes(body, maxBytes);
  return { element: collapsible(title, byBytes.text, false), degraded: byBytes.cut };
};

/**
 * Low-noise changed-files summary (`markdown` density): the same
 * `📝 改动 N 文件 (+X -Y)` title as {@link renderChangedFiles} (via
 * {@link changedFilesTitle}) as one markdown line, dropping the collapsible
 * per-file list. Returns null when there are no changed files.
 */
export const renderChangedFilesSummary = (
  thread: OrchestrationThread,
  activeTurnId: TurnId | null,
): MarkdownElement | null => {
  const data = aggregateChangedFiles(thread, activeTurnId);
  return data === null ? null : markdown(changedFilesTitle(data));
};
