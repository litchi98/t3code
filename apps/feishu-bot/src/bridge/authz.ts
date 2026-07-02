/**
 * Approval-card authorization (M4-1 authz decoupling, M-2 owner-always + three-state).
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
