import type { FeishuChatConfig } from "@t3tools/contracts";

/**
 * Pure helpers for the Feishu per-chat approval editor (M-2 PR2c).
 *
 * The web edits two ServerSettings fields with WHOLE-VALUE replacement semantics
 * (see `applyServerSettingsPatch`): `feishuChatDefaults` (a single config) and
 * `feishuChatConfigs` (a `Record<chatId, FeishuChatConfig>`). These helpers
 * produce the next value to hand to `useUpdatePrimarySettings`. Kept pure so the
 * config/map manipulation is unit-testable without rendering (the repo's
 * settings test convention).
 *
 * Approval-mode model (must stay faithful to the bot's `effectiveChatConfig`
 * field-level fallback: per-chat field → `feishuChatDefaults` field → built-in
 * `initiator`):
 * - A per-chat entry that omits `approvalMode` inherits the default mode AND the
 *   default approvers — so "inherit" clears BOTH fields.
 * - `designated` means the chat has its OWN approver roster, so `approvers` is
 *   always PRESENT for a designated entry — an empty `[]` is a real value
 *   ("only the owner may approve", via the owner-always overlay) and must NOT be
 *   dropped, otherwise the absent field would silently field-fallback to the
 *   default approvers. `initiator`/`all` ignore approvers, so it is dropped there.
 * This keeps what the editor shows equal to what the bot enforces.
 *
 * M-3 fields:
 * - `commands` / `workspaces` are now web-editable (PR-C). Both use the SAME
 *   presence semantics the bot's `authorizeCommand` / `isWorkspaceAuthorized`
 *   enforce: absent = "not configured" (inherit default → unrestricted), a
 *   present list = an override. The two EMPTY-list meanings are OPPOSITE and both
 *   real overrides that must be kept: `commands: []` = only the floor commands
 *   (`/help`, `/whoami`) are allowed; `workspaces: []` = NO workspace is allowed
 *   (the chat can run nothing). `toolPolicy` is preserved untouched (PR-B paused).
 */

export type ApprovalMode = NonNullable<FeishuChatConfig["approvalMode"]>;

export type FeishuChatConfigMap = { readonly [chatId: string]: FeishuChatConfig };

/** The three approval modes in display order, plus their Chinese labels. */
export const APPROVAL_MODES: readonly ApprovalMode[] = ["initiator", "designated", "all"];

export const APPROVAL_MODE_LABELS: Record<ApprovalMode, string> = {
  initiator: "仅发起人",
  designated: "指定审批人",
  all: "任意群成员",
};

/** Sentinel select value for a per-chat entry that inherits the default mode. */
export const INHERIT_MODE = "inherit" as const;
export type ChatModeSelection = ApprovalMode | typeof INHERIT_MODE;

/**
 * Structural deep-equality for plain JSON values (objects key-order-independent,
 * arrays order-sensitive). Used to settle the optimistic settings overlay when
 * the server echoes back exactly what we last wrote. Kept here (pure) rather than
 * pulling an undeclared transitive dependency.
 */
export const deepEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const aIsArray = Array.isArray(a);
  if (aIsArray || Array.isArray(b)) {
    if (!aIsArray || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(
    (key) =>
      Object.hasOwn(b, key) &&
      deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  );
};

/** Toggle an open_id in an approver list (add if absent, remove if present). */
export const toggleApprover = (
  approvers: ReadonlyArray<string>,
  openId: string,
): ReadonlyArray<string> =>
  approvers.includes(openId) ? approvers.filter((id) => id !== openId) : [...approvers, openId];

/**
 * Canonicalize a config so `approvers` is present (incl. `[]`) exactly when the
 * mode is `designated`, and absent otherwise. Contract fields are readonly, so
 * fields are added/omitted by construction rather than mutation.
 */
const normalizeConfig = (config: FeishuChatConfig): FeishuChatConfig => {
  if (config.approvalMode === "designated") {
    return { ...config, approvers: config.approvers ?? [] };
  }
  const { approvers: _approvers, ...rest } = config;
  return rest;
};

/**
 * True when a per-chat config carries no override at all — an "inherit
 * everything" no-op that is dropped from the map. Note a `designated` entry with
 * an empty roster is NOT empty (its `approvalMode` is a real override).
 */
export const isChatConfigEmpty = (config: FeishuChatConfig): boolean =>
  config.approvalMode === undefined &&
  (config.approvers === undefined || config.approvers.length === 0) &&
  config.workspaces === undefined &&
  config.commands === undefined &&
  config.toolPolicy === undefined;

/** Apply a mode selection to a single config. `inherit` clears mode + approvers. */
export const setConfigApprovalMode = (
  config: FeishuChatConfig,
  selection: ChatModeSelection,
): FeishuChatConfig => {
  if (selection === INHERIT_MODE) {
    const { approvalMode: _mode, ...rest } = config;
    return normalizeConfig(rest);
  }
  return normalizeConfig({ ...config, approvalMode: selection });
};

/** Toggle a designated approver open_id on a single config, preserving its mode. */
export const toggleConfigApprover = (config: FeishuChatConfig, openId: string): FeishuChatConfig =>
  normalizeConfig({ ...config, approvers: toggleApprover(config.approvers ?? [], openId) });

/**
 * Set (or clear) the command allowlist on a config (per-chat or defaults). Passing
 * `undefined` REMOVES the field (inherit default → all commands allowed); a list —
 * including the empty `[]` ("only the floor commands `/help`, `/whoami`") — is a
 * real override kept in the map. Floor commands are always allowed by the bot and
 * are never stored here. Fields are added/omitted by construction (contract fields
 * are readonly), then re-normalized to keep the `approvers`-presence invariant.
 */
export const setConfigCommands = (
  config: FeishuChatConfig,
  commands: ReadonlyArray<string> | undefined,
): FeishuChatConfig => {
  if (commands === undefined) {
    const { commands: _dropped, ...rest } = config;
    return normalizeConfig(rest);
  }
  return normalizeConfig({ ...config, commands });
};

/** Toggle one command token in the allowlist (materializing `[]` first if absent). */
export const toggleConfigCommand = (config: FeishuChatConfig, token: string): FeishuChatConfig =>
  // `toggleApprover` is a pure add-if-absent/remove-if-present string-list toggle.
  setConfigCommands(config, toggleApprover(config.commands ?? [], token));

/**
 * Set (or clear) the workspace allowlist on a config (per-chat or defaults).
 * Passing `undefined` REMOVES the field (inherit default → every workspace
 * authorized); a list — including the empty `[]` ("NO workspace authorized", the
 * opposite of the empty-command case) — is a real override kept in the map. Values
 * are bare `ProjectId` strings.
 */
export const setConfigWorkspaces = (
  config: FeishuChatConfig,
  workspaces: ReadonlyArray<string> | undefined,
): FeishuChatConfig => {
  if (workspaces === undefined) {
    const { workspaces: _dropped, ...rest } = config;
    return normalizeConfig(rest);
  }
  return normalizeConfig({ ...config, workspaces });
};

/** Toggle one projectId in the workspace allowlist (materializing `[]` first if absent). */
export const toggleConfigWorkspace = (
  config: FeishuChatConfig,
  projectId: string,
): FeishuChatConfig =>
  setConfigWorkspaces(config, toggleApprover(config.workspaces ?? [], projectId));

/**
 * Describe what commands a chat with NO own `commands` override inherits, faithful
 * to the bot's field-level fallback (per-chat absent → `feishuChatDefaults.commands`
 * → built-in unrestricted). A per-chat card must NOT hardcode "allows all" — the
 * default itself may be a restriction or an empty ("only floor") list, and the
 * shown text has to equal what the bot enforces ("what the editor shows == what
 * the bot enforces"). `defaultCommands` is `feishuChatDefaults.commands`.
 */
export const describeInheritedCommands = (
  defaultCommands: ReadonlyArray<string> | undefined,
): string => {
  if (defaultCommands === undefined) {
    return "继承默认配置(默认:允许全部命令)。";
  }
  if (defaultCommands.length === 0) {
    return "继承默认配置(默认:仅基础命令 /help、/whoami)。";
  }
  return `继承默认配置(默认:限制为 ${defaultCommands.length} 项命令 + 基础)。`;
};

/**
 * Describe what workspaces a chat with NO own `workspaces` override inherits,
 * faithful to the bot's field-level fallback. Note the OPPOSITE empty meaning: a
 * default of `[]` authorizes NO workspace (the chat can run nothing), so the hint
 * must say so rather than claim "allows all". `defaultWorkspaces` is
 * `feishuChatDefaults.workspaces`.
 */
export const describeInheritedWorkspaces = (
  defaultWorkspaces: ReadonlyArray<string> | undefined,
): string => {
  if (defaultWorkspaces === undefined) {
    return "继承默认配置(默认:允许全部工作区)。";
  }
  if (defaultWorkspaces.length === 0) {
    return "继承默认配置(默认:未授权任何工作区,本群无法使用工作区)。";
  }
  return `继承默认配置(默认:限制为 ${defaultWorkspaces.length} 个工作区)。`;
};

/**
 * Write a per-chat config into the map with whole-map replacement, canonicalizing
 * it first and dropping an entry that becomes an inherit-everything no-op. The
 * other chats' entries are carried through unchanged.
 */
export const writeChatConfig = (
  configs: FeishuChatConfigMap,
  chatId: string,
  config: FeishuChatConfig,
): FeishuChatConfigMap => {
  const normalized = normalizeConfig(config);
  if (isChatConfigEmpty(normalized)) {
    const { [chatId]: _removed, ...rest } = configs;
    return rest;
  }
  return { ...configs, [chatId]: normalized };
};

/** The select value to show for a chat: its own mode, or the inherit sentinel. */
export const chatModeSelection = (config: FeishuChatConfig | undefined): ChatModeSelection =>
  config?.approvalMode ?? INHERIT_MODE;

/** Set the default approvalMode (defaults are always an explicit mode). */
export const setDefaultsApprovalMode = (
  defaults: FeishuChatConfig,
  mode: ApprovalMode,
): FeishuChatConfig => normalizeConfig({ ...defaults, approvalMode: mode });

/** The default mode shown in the selector (absent → built-in `initiator`). */
export const defaultsModeSelection = (defaults: FeishuChatConfig): ApprovalMode =>
  defaults.approvalMode ?? "initiator";

/** Toggle a default approver open_id, preserving the (designated) default mode. */
export const toggleDefaultsApprover = (
  defaults: FeishuChatConfig,
  openId: string,
): FeishuChatConfig =>
  normalizeConfig({ ...defaults, approvers: toggleApprover(defaults.approvers ?? [], openId) });
