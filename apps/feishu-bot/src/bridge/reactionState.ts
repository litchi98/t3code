/**
 * Turn-status reaction state machine (batch B).
 *
 * The bridge marks the *triggering* Feishu message with an emoji reaction that
 * tracks the turn's lifecycle: a `running` receipt while the agent works, then a
 * terminal emoji (`completed` / `failed` / `interrupted`) once the turn settles.
 * This is a card-independent visual channel — the streaming mirror card is the
 * other — anchored to the merged dispatch's `sources[0]` message ONLY, never per
 * message (a message-rain's follow-ups carry no reaction; red line: single
 * anchor).
 *
 * IMPORTANT: `emoji_type` values are Feishu's fixed *named* enum (NOT unicode).
 * Every key below is drawn from the open-platform `im.message.reaction` emoji
 * list (verified against the published enum). They are centralised here so a
 * real-machine e2e can retune any single key in one place if Feishu rejects it.
 *
 * The transitions are performed best-effort by the caller (`turnRunner`): a
 * reaction failure (missing scope, unknown emoji_type, network) is logged and
 * swallowed — it must NEVER touch the turn / card / approval flow (M1 principle).
 * This module is strictly pure: it only maps a settled thread to its emoji key.
 */
import type { OrchestrationThread } from "@t3tools/contracts";

import { deriveTurnDisplayStatus } from "./render/status.ts";

/**
 * Running receipt: the agent is working on the turn. Feishu `Typing` — the same
 * key the legacy offline ⏳ receipt used, so the running state reads identically.
 */
export const REACTION_RUNNING = "Typing";
/** Terminal: the turn completed successfully (Feishu `DONE`, a green check). */
export const REACTION_COMPLETED = "DONE";
/** Terminal: the turn failed / errored (Feishu `CrossMark`, a red ✗). */
export const REACTION_FAILED = "CrossMark";
/**
 * Terminal: the user stopped the turn (interrupted). Feishu has no plain "stop"
 * glyph in the reaction enum; `GeneralDoNotDisturb` is the closest confirmed key
 * and reads as a stop/⛔ status, distinct from the failure ✗ (so an interrupted
 * turn is visibly NOT a failure — matches the card's ⏹️ 已停止).
 */
export const REACTION_INTERRUPTED = "GeneralDoNotDisturb";

/**
 * The terminal reaction emoji for a settled turn, derived from the SAME
 * classification the card status line uses ({@link deriveTurnDisplayStatus},
 * read from the authoritative server-folded thread — never a local optimistic
 * guess, even when the bot itself sent the interrupt). Returns `null` when the
 * thread is still `running` (no terminal swap yet) so a caller reading a
 * not-yet-settled observation leaves the running receipt in place rather than
 * mislabelling an in-flight turn.
 */
export const terminalReactionEmoji = (thread: OrchestrationThread): string | null => {
  switch (deriveTurnDisplayStatus(thread, false)) {
    case "done":
      return REACTION_COMPLETED;
    case "interrupted":
      return REACTION_INTERRUPTED;
    case "error":
      return REACTION_FAILED;
    case "running":
      return null;
  }
};
