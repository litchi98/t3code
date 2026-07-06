/**
 * Per-chat authorization primitives (M4-1 decoupling, M-2 owner-always +
 * three-state approval, M-3 command allowlist + workspace authorization).
 *
 * `authorizeApprovalClick` decides WHO may act on an approval card. M-3 adds two
 * sibling gates — `authorizeCommand` (per-chat slash-command allowlist) and
 * `isWorkspaceAuthorized` (per-chat workspace allowlist) — that reuse the SAME
 * owner-always overlay (`isOwnerExempt`): the configured binding owner bypasses
 * every per-chat restriction, in any gate. All three are pure + IO-free.
 *
 * Decides WHO may act on a verified approval card, after `CallbackAuth.verify`
 * has already proved the card's INTEGRITY (right chat/thread/policy, untampered
 * token). Kept pure and IO-free so the bot's cardAction gate stays a thin Effect
 * wrapper that resolves the effective config + Refs (owner, mode, approvers) and
 * delegates the decision here — keeping the branches unit-testable.
 *
 * The rule (M-2 / PR2b):
 *  - Empty `clicker` is never authorized (an empty operator open_id must not match).
 *  - The configured binding **owner** may ALWAYS act (owner-always overlay), in any mode.
 *  - Otherwise the per-chat approval **mode** decides:
 *      · `initiator`  — only the turn initiator (the signed `payload.o`) may act.
 *      · `designated` — only an open_id in the configured `approvers` list may act.
 *      · `all`        — any chat member may act. A cardAction can only originate
 *                       from a member of the chat the card lives in, so any
 *                       non-empty `clicker` IS a member — no roster fetch needed.
 *
 * PR2a's env/store allowlist branch is gone: authority is now `owner` (binding)
 * + per-chat mode. `initiator` correctness rests on `payload.o` = the real turn
 * initiator, which the card token now signs directly (initiator-only, in
 * `buildInteraction`) and the per-turn operator pin (idle-guarded `chatOperators`
 * + `driveTurn`'s `operatorOverride`) keeps un-flippable by a mid-turn bystander.
 */
import { FEISHU_COMMAND_FLOOR } from "@t3tools/contracts";

import type { ApprovalMode } from "./chatConfig.ts";

/** Inputs to the approval-card authorization decision. All identities are Feishu open_ids. */
export interface ApprovalClickAuthzInput {
  /** The configured binding owner (`feishuBinding.ownerOpenId`), or `null` if no bot is bound. */
  readonly owner: string | null;
  /** The effective approval mode for this chat (resolved via `effectiveChatConfig`). */
  readonly mode: ApprovalMode;
  /** open_ids allowed to approve when `mode === "designated"` (empty otherwise). */
  readonly approvers: ReadonlyArray<string>;
  /** The open_id of whoever clicked the card button (`evt.operator.openId`). */
  readonly clicker: string;
  /** The signed initiator open_id embedded in the verified card payload (`payload.o`). */
  readonly initiator: string;
}

/**
 * Return whether `clicker` is authorized to act on the (already integrity-verified)
 * approval card. Pure; see the module doc for the rule.
 */
export const authorizeApprovalClick = (input: ApprovalClickAuthzInput): boolean => {
  const { owner, mode, approvers, clicker, initiator } = input;
  // An empty operator open_id never matches — guard before every branch.
  if (clicker.length === 0) {
    return false;
  }
  // Owner-always: the configured owner may act in any mode (overlay).
  if (owner !== null && clicker === owner) {
    return true;
  }
  switch (mode) {
    case "initiator":
      return clicker === initiator;
    case "designated":
      return approvers.includes(clicker);
    case "all":
      // Any chat member; a clicker of an in-chat card is a member by construction.
      return true;
  }
};

// ── M-3: command allowlist + workspace authorization (shared owner overlay) ──

/**
 * The command tokens ALWAYS allowed, bypassing the per-chat command allowlist —
 * a self-lock floor (M-3, user-confirmed). Both are side-effect-free
 * introspection commands: `/help` is the sole discovery surface for a chat's
 * available commands and `/whoami` echoes the caller's own open_id, so a
 * mis-configured allowlist can never lock a chat out of discovering how to fix
 * itself. Tokens are normalised (lowercase, leading `/`) to match the registry.
 *
 * The tokens live in `@t3tools/contracts` (`FEISHU_COMMAND_FLOOR`) as the single
 * source of truth shared with the web command-allowlist editor (M-3 PR-C); this
 * re-export keeps the bot's existing `COMMAND_FLOOR` consumers unchanged.
 */
export const COMMAND_FLOOR: ReadonlyArray<string> = FEISHU_COMMAND_FLOOR;

/**
 * The owner-always overlay, shared by every per-chat gate: the configured
 * binding owner (`ownerRef`'s open_id) bypasses ALL per-chat restrictions.
 * Same authority source and comparison as `authorizeApprovalClick`'s owner
 * branch; an empty `sender` never matches (guards an unresolved open_id).
 */
export const isOwnerExempt = (owner: string | null, sender: string): boolean =>
  owner !== null && sender.length > 0 && sender === owner;

/** Inputs to the per-chat command-allowlist decision. All identities are open_ids. */
export interface CommandAuthzInput {
  /** The configured binding owner, or `null` when unbound. Owner is exempt. */
  readonly owner: string | null;
  /** The open_id of whoever sent the command (`message.senderId`). */
  readonly sender: string;
  /** The normalised command token, including its leading `/` (e.g. `/workspace`). */
  readonly command: string;
  /**
   * The per-chat command allowlist (`effectiveChatConfig(chatId).commands`).
   * `undefined` = "not configured" → every command allowed; an empty list =
   * "only the floor" (owner + {@link COMMAND_FLOOR}).
   */
  readonly allowlist: ReadonlyArray<string> | undefined;
  /** Commands always allowed regardless of the allowlist (self-lock floor). */
  readonly floor: ReadonlyArray<string>;
}

/**
 * Whether `sender` may run `command` in a chat with this allowlist. Pure.
 * Owner-exempt → always; floor command → always; no allowlist → always; else
 * membership in the allowlist.
 */
export const authorizeCommand = (input: CommandAuthzInput): boolean => {
  if (isOwnerExempt(input.owner, input.sender)) {
    return true;
  }
  if (input.floor.includes(input.command)) {
    return true;
  }
  if (input.allowlist === undefined) {
    return true;
  }
  // Config values may be hand-authored (settings.json), so normalise their case
  // to the already-lowercased command token — `/Workspace` must not silently
  // never-match. (The registry lowercases the incoming token; the floor is
  // lowercase too.)
  return input.allowlist.some((entry) => entry.toLowerCase() === input.command);
};

/** Inputs to the per-chat workspace-authorization decision. */
export interface WorkspaceAuthzInput {
  /** The configured binding owner, or `null` when unbound. Owner is exempt. */
  readonly owner: string | null;
  /** The open_id of whoever sent the message/command (`message.senderId`). */
  readonly sender: string;
  /** The `ProjectId` (as a bare string) being checked. */
  readonly projectId: string;
  /**
   * The per-chat workspace allowlist (`effectiveChatConfig(chatId).workspaces`).
   * `undefined` = "not configured" → every project authorized.
   */
  readonly authorized: ReadonlyArray<string> | undefined;
}

/**
 * Whether `sender` may select/act on `projectId` in this chat. Pure.
 * Owner-exempt → always; no allowlist → always; else membership. This is a
 * selection/authorization layer, NOT a runtime path guard (M-3 red line).
 */
export const isWorkspaceAuthorized = (input: WorkspaceAuthzInput): boolean => {
  if (isOwnerExempt(input.owner, input.sender)) {
    return true;
  }
  if (input.authorized === undefined) {
    return true;
  }
  return input.authorized.includes(input.projectId);
};
