/**
 * Per-chat effective configuration (M-2 PR2b / M-3).
 *
 * Resolves the effective `FeishuChatConfig` for a chat by **field-level** (not
 * object-level) fallback: each field is taken from the per-chat entry, else the
 * defaults, else a built-in. Keyed by **bare chatId** (the authz gate matches on
 * `evt.chatId`) — a different key grain from the `/workspace` selection state.
 *
 * Pure + IO-free: the caller snapshots the two Refs (`chatConfigsRef` /
 * `chatDefaultsRef`, live-refreshed by the resident watcher) and passes them in,
 * so this stays unit-testable and the gate keeps a thin Effect wrapper.
 *
 * PR2b consumes `approvalMode` + `approvers` (three-state authz). `workspaces` /
 * `commands` / `toolPolicy` are surfaced here but consumed later (M-3).
 */
import type { FeishuChatConfig } from "@t3tools/contracts";

/**
 * Resolved approval-gate mode (the non-optional form of `FeishuChatConfig.approvalMode`).
 * `initiator` = the session's current Feishu operator (session grain — the most recent
 * driver/`/resume` taker — NOT the per-turn author; see `authz.ts` SEMANTICS);
 * `designated` = the `approvers` list; `all` = any chat member.
 */
export type ApprovalMode = NonNullable<FeishuChatConfig["approvalMode"]>;

/** Built-in default when neither the per-chat entry nor the defaults set `approvalMode`. */
export const DEFAULT_APPROVAL_MODE: ApprovalMode = "initiator";

export interface EffectiveChatConfig {
  readonly approvalMode: ApprovalMode;
  readonly approvers: ReadonlyArray<string>;
  // M-3 (surfaced now, consumed later): undefined means "not configured" so the
  // consumer can apply its own "all allowed" default distinct from an empty list.
  readonly workspaces: ReadonlyArray<string> | undefined;
  readonly commands: ReadonlyArray<string> | undefined;
  readonly toolPolicy: FeishuChatConfig["toolPolicy"];
}

/**
 * Compute the effective config for `chatId`. Every field falls back
 * independently: `configs[chatId]?.field ?? defaults.field ?? built-in`.
 */
export const effectiveChatConfig = (
  chatId: string,
  configs: { readonly [chatId: string]: FeishuChatConfig },
  defaults: FeishuChatConfig,
): EffectiveChatConfig => {
  const perChat = configs[chatId];
  const pick = <K extends keyof FeishuChatConfig>(key: K): FeishuChatConfig[K] =>
    perChat?.[key] ?? defaults[key];
  return {
    approvalMode: pick("approvalMode") ?? DEFAULT_APPROVAL_MODE,
    approvers: pick("approvers") ?? [],
    workspaces: pick("workspaces"),
    commands: pick("commands"),
    toolPolicy: pick("toolPolicy"),
  };
};
