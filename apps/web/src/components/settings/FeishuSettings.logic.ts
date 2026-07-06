import { FEISHU_RENDER_DENSITIES, type FeishuChatConfig } from "@t3tools/contracts";

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

// `initiator` is session-grain, NOT per-turn: it means the session's current Feishu
// operator (the most recent person to drive/`/resume` this session). The label says
// "会话发起者" rather than "发起人" so it does not read as a per-turn author. See the
// bot's authz.ts SEMANTICS note.
export const APPROVAL_MODE_LABELS: Record<ApprovalMode, string> = {
  initiator: "仅会话发起者",
  designated: "指定审批人",
  all: "任意群成员",
};

/** The render density values (M-3 PR-C3), non-optional form of `FeishuChatConfig.density`. */
export type RenderDensity = NonNullable<FeishuChatConfig["density"]>;

/**
 * The densities in display order (segmented control), from the SAME contract list
 * the bot's `RENDER_DENSITIES` is parity-checked against — one source, so the
 * editor can never offer a density the bot can't render.
 */
export const DENSITY_MODES: readonly RenderDensity[] = FEISHU_RENDER_DENSITIES;

export const DENSITY_LABELS: Record<RenderDensity, string> = {
  card: "卡片",
  markdown: "Markdown",
  text: "纯文本",
};

/**
 * Built-in group render density when neither the chat nor the defaults set one.
 * Mirrors the bot's `densityForRuntime` group default (`card`) so "what the editor
 * shows == what the bot renders". (p2p is always `card` in the bot, but p2p chats
 * are not configurable here — the group section only.)
 */
export const DEFAULT_GROUP_DENSITY: RenderDensity = "card";

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
  config.toolPolicy === undefined &&
  // PR-C3 red line: a chat whose ONLY override is `density` is a REAL override and
  // must NOT be dropped, or `writeChatConfig`'s drop-empty would silently delete it
  // and the per-chat density could never persist.
  config.density === undefined;

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
 * Set (or clear) the render density on a config (per-chat or defaults). Passing
 * `undefined` REMOVES the field (per-chat: inherit the default; defaults: fall back
 * to the built-in `card`); a value is a real override kept in the map. Unlike
 * commands/workspaces there is no empty-list case — density is a single literal.
 */
export const setConfigDensity = (
  config: FeishuChatConfig,
  density: RenderDensity | undefined,
): FeishuChatConfig => {
  if (density === undefined) {
    const { density: _dropped, ...rest } = config;
    return normalizeConfig(rest);
  }
  return normalizeConfig({ ...config, density });
};

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

// ─────────────────────────────────────────────────────────────────────────────
// Effective config (resting-state summaries + the drawer's effective-preview card)
//
// The list-row灰字 and the drawer preview both show a chat's RESOLVED config —
// "what the bot enforces". Both consume the SAME `effectiveConfig` here, which is
// a byte-faithful mirror of the bot's `effectiveChatConfig` (see
// `apps/feishu-bot/src/bridge/chatConfig.ts`): every field falls back
// INDEPENDENTLY, `configs[chatId]?.field ?? defaults.field ?? built-in`. The web
// MUST NOT re-derive a second fallback — one source of truth so "what the editor
// shows == what the bot enforces". PR-C3 adds `density`: the web built-in group
// default is `card`, matching the bot's `densityForRuntime` group default (the
// bot's binding-density tier is a bot-only fallback that only applies when neither
// per-chat nor defaults set density, so it never diverges from what the web shows).
// ─────────────────────────────────────────────────────────────────────────────

/** Built-in approval mode when neither the chat nor the defaults set one (mirrors the bot). */
export const DEFAULT_APPROVAL_MODE: ApprovalMode = "initiator";

/** Where a resolved field's value came from, mirroring the three fallback tiers. */
export type ConfigSource = "chat" | "default" | "builtin";

/** Human labels for a field's source tier, for the drawer's `[本群]/[默认]/[内置]` badges. */
export const SOURCE_LABELS: Record<ConfigSource, string> = {
  chat: "本群",
  default: "默认",
  builtin: "内置",
};

/** A resolved field: its effective value plus which tier it was taken from. */
export interface EffectiveField<T> {
  readonly value: T;
  readonly source: ConfigSource;
}

/** A chat's fully-resolved config (per M-3 PR-C2 dimensions; density arrives in PR-C3). */
export interface EffectiveConfig {
  readonly approvalMode: EffectiveField<ApprovalMode>;
  readonly approvers: EffectiveField<ReadonlyArray<string>>;
  /** `undefined` = unrestricted (every command allowed); `[]` = only the floor commands. */
  readonly commands: EffectiveField<ReadonlyArray<string> | undefined>;
  /** `undefined` = unrestricted (every workspace allowed); `[]` = no workspace authorized. */
  readonly workspaces: EffectiveField<ReadonlyArray<string> | undefined>;
  /** Resolved render density; built-in group default is `card`. */
  readonly density: EffectiveField<RenderDensity>;
}

const fieldSource = (own: unknown, def: unknown): ConfigSource =>
  own !== undefined ? "chat" : def !== undefined ? "default" : "builtin";

/**
 * Resolve a chat's effective config by field-level fallback, faithful to the bot's
 * `effectiveChatConfig`. `configs[chatId]` absent (a clean, un-overridden chat) is
 * fine — every field then resolves from `defaults` or the built-in.
 */
export const effectiveConfig = (
  chatId: string,
  configs: FeishuChatConfigMap,
  defaults: FeishuChatConfig,
): EffectiveConfig => {
  const perChat = configs[chatId];
  return {
    approvalMode: {
      value: perChat?.approvalMode ?? defaults.approvalMode ?? DEFAULT_APPROVAL_MODE,
      source: fieldSource(perChat?.approvalMode, defaults.approvalMode),
    },
    approvers: {
      value: perChat?.approvers ?? defaults.approvers ?? [],
      source: fieldSource(perChat?.approvers, defaults.approvers),
    },
    commands: {
      value: perChat?.commands ?? defaults.commands,
      source: fieldSource(perChat?.commands, defaults.commands),
    },
    workspaces: {
      value: perChat?.workspaces ?? defaults.workspaces,
      source: fieldSource(perChat?.workspaces, defaults.workspaces),
    },
    density: {
      value: perChat?.density ?? defaults.density ?? DEFAULT_GROUP_DENSITY,
      source: fieldSource(perChat?.density, defaults.density),
    },
  };
};

/**
 * True when a chat carries a real override (so its list row shows the "changed"
 * signal rather than the quiet inherited灰字). An entry present in the map is
 * always non-empty (`writeChatConfig` drops empties), but a hand-edited
 * settings.json could leave an empty entry — so gate on `!isChatConfigEmpty`.
 */
export const isChatOverridden = (config: FeishuChatConfig | undefined): boolean =>
  config !== undefined && !isChatConfigEmpty(config);

/** Compact label for an effective approval mode (with approver count when designated). */
export const approvalSummary = (mode: ApprovalMode, approverCount: number): string =>
  mode === "designated"
    ? `${APPROVAL_MODE_LABELS.designated} · ${approverCount} 人`
    : APPROVAL_MODE_LABELS[mode];

/** Compact label for a command allowlist: `undefined`→全部, `[]`→仅基础, list→N 项. */
export const commandsSummary = (commands: ReadonlyArray<string> | undefined): string =>
  commands === undefined ? "全部" : commands.length === 0 ? "仅基础" : `${commands.length} 项`;

/** Compact label for a workspace allowlist: `undefined`→全部, `[]`→未授权, list→N 个. */
export const workspacesSummary = (workspaces: ReadonlyArray<string> | undefined): string =>
  workspaces === undefined
    ? "全部"
    : workspaces.length === 0
      ? "未授权"
      : `${workspaces.length} 个`;

/**
 * One-line resting summary for a chat's list row. A clean chat reads
 * "继承默认 · <effective approval>"; an overridden chat leads with its effective
 * approval and appends only the dimensions IT overrides (commands/workspaces),
 * so the row communicates the real enforced state at a glance without opening the
 * drawer. Both branches show effective values only (owner-always弱化: no
 * "+授权人" tail).
 */
export const restingChatSummary = (effective: EffectiveConfig, overridden: boolean): string => {
  const approval = approvalSummary(effective.approvalMode.value, effective.approvers.value.length);
  if (!overridden) return `继承默认 · ${approval}`;
  const parts = [approval];
  if (effective.commands.source === "chat") {
    parts.push(`命令 ${commandsSummary(effective.commands.value)}`);
  }
  if (effective.workspaces.source === "chat") {
    parts.push(`工作区 ${workspacesSummary(effective.workspaces.value)}`);
  }
  if (effective.density.source === "chat") {
    parts.push(`密度 ${DENSITY_LABELS[effective.density.value]}`);
  }
  return parts.join(" · ");
};

/**
 * The default-config baseline entry's own compact summary (keyed dimensions). The
 * defaults are explicit values (not resolved against anything), so this reads them
 * directly — absent command/workspace lists mean "全部", the built-in baseline.
 */
export const defaultsSummary = (
  defaults: FeishuChatConfig,
): ReadonlyArray<{ readonly key: string; readonly value: string }> => [
  {
    key: "审批",
    value: approvalSummary(
      defaults.approvalMode ?? DEFAULT_APPROVAL_MODE,
      (defaults.approvers ?? []).length,
    ),
  },
  { key: "命令", value: commandsSummary(defaults.commands) },
  { key: "工作区", value: workspacesSummary(defaults.workspaces) },
  { key: "密度", value: DENSITY_LABELS[defaults.density ?? DEFAULT_GROUP_DENSITY] },
];
