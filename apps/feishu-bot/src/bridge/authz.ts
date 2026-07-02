/**
 * Approval-card authorization (M4-1 authz decoupling, M-2 owner-always).
 *
 * Decides WHO may act on a verified approval card, after `CallbackAuth.verify`
 * has already proved the card's INTEGRITY (right chat/thread/policy, untampered
 * token). Kept pure and IO-free so the bot's cardAction gate stays a thin Effect
 * wrapper that only resolves Refs (owner, effective allowlist) and delegates the
 * decision here — which in turn keeps the branches unit-testable.
 *
 * The rule (M-2 / PR2a):
 *  - The configured binding **owner** may ALWAYS act (prepended; owner-always).
 *  - Otherwise the pre-existing M4-1 rule holds: an active allowlist → membership
 *    check; an empty allowlist → the pre-M4 "initiator only" fallback matching
 *    the signed `initiator` (`payload.o`). The non-empty `clicker` guard on the
 *    fallback is preserved (an empty operator openId must never match).
 *
 * PR2b layers the three-state (all/designated/initiator) mode logic on top of
 * this function — mode resolution is intentionally centralized in the gate.
 */

/** Inputs to the approval-card authorization decision. All identities are Feishu open_ids. */
export interface ApprovalClickAuthzInput {
  /** The configured binding owner (`feishuBinding.ownerOpenId`), or `null` if no bot is bound. */
  readonly owner: string | null;
  /** The effective approval allowlist for this chat's runtime mode (empty for non-gated modes). */
  readonly effectiveAllowlist: ReadonlyArray<string>;
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
  const { owner, effectiveAllowlist, clicker, initiator } = input;
  // Owner-always: the configured owner may act in any mode (prepend). Owner is a
  // non-empty open_id when set, but keep the explicit non-empty `clicker` guard
  // for symmetry with the fallback branch.
  if (owner !== null && clicker.length > 0 && clicker === owner) {
    return true;
  }
  // M4-1 base rule, unchanged: allowlist membership when active, else initiator-only.
  return effectiveAllowlist.length > 0
    ? effectiveAllowlist.includes(clicker)
    : clicker.length > 0 && clicker === initiator;
};
