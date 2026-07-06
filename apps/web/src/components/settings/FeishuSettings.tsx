"use client";

import type {
  FeishuChatConfig,
  FeishuChatDirectoryEntry,
  FeishuChatMember,
} from "@t3tools/contracts";
import { FEISHU_COMMAND_REGISTRY, FEISHU_CONFIGURABLE_COMMANDS } from "@t3tools/contracts";
import { LinkIcon, PlusIcon, UsersIcon, XIcon } from "lucide-react";
import { useCallback, useRef, useState } from "react";

import { useProjects } from "~/state/entities";
import { usePrimaryEnvironment } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { FeishuBindingDialog } from "./FeishuBindingDialog";
import {
  APPROVAL_MODE_LABELS,
  APPROVAL_MODES,
  chatModeSelection,
  type ChatModeSelection,
  deepEqual,
  defaultsModeSelection,
  describeInheritedCommands,
  describeInheritedWorkspaces,
  type FeishuChatConfigMap,
  INHERIT_MODE,
  setConfigApprovalMode,
  setConfigCommands,
  setConfigWorkspaces,
  setDefaultsApprovalMode,
  toggleConfigApprover,
  toggleConfigCommand,
  toggleConfigWorkspace,
  toggleDefaultsApprover,
  writeChatConfig,
} from "./FeishuSettings.logic";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

/** Minimal project shape the workspace-allowlist editor needs. */
interface WorkspaceOption {
  readonly id: string;
  readonly title: string;
  readonly workspaceRoot: string;
}

/**
 * Feishu bot binding + per-chat approval configuration.
 *
 * Bind the bot first (QR-scan flow), then configure who may approve — a default
 * mode plus optional per-chat overrides. The binding owner is always allowed to
 * approve regardless of these settings (owner-always overlay in the bot).
 */
export function FeishuSettingsPanel() {
  return (
    <SettingsPageContainer>
      <FeishuBindingSection />
      <FeishuChatConfigSection />
    </SettingsPageContainer>
  );
}

/**
 * Current Feishu bot binding state + entry point to the QR-scan binding flow.
 *
 * Reads the public binding identity (`ServerSettings.feishuBinding`; no secret)
 * and exposes unbind. Binding/unbinding flips this section via the server's
 * live settings refresh — no manual reload needed. The `appSecret` never
 * reaches the web (it lives only in the server secret store).
 */
function FeishuBindingSection() {
  const binding = usePrimarySettings((s) => s.feishuBinding);
  const environmentId = usePrimaryEnvironment()?.environmentId ?? null;
  const clearBinding = useAtomCommand(serverEnvironment.feishuClearBinding, "feishu unbind");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleUnbind = useCallback(async () => {
    if (!environmentId) return;
    setClearing(true);
    setError(null);
    const result = await clearBinding({ environmentId, input: {} });
    setClearing(false);
    if (result._tag === "Failure") {
      setError("解绑失败,请重试。");
    }
    // On success the server live-refreshes `feishuBinding` away, flipping this
    // section back to the unbound state on its own.
  }, [clearBinding, environmentId]);

  return (
    <SettingsSection title="飞书 Bot 绑定" icon={<LinkIcon className="size-3" />}>
      <div className="px-4 py-3 sm:px-5">
        {binding ? (
          <div className="space-y-3">
            <dl className="space-y-1.5 text-xs">
              <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3">
                <dt className="text-muted-foreground">App ID</dt>
                <dd className="truncate text-right font-mono text-foreground/90">
                  {binding.appId}
                </dd>
              </div>
              <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3">
                <dt className="text-muted-foreground">部署</dt>
                <dd className="text-right text-foreground/90">
                  {binding.tenant === "lark" ? "Lark" : "飞书"}
                </dd>
              </div>
              <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3">
                <dt className="text-muted-foreground">授权人</dt>
                <dd className="truncate text-right font-mono text-foreground/90">
                  {binding.ownerOpenId}
                </dd>
              </div>
            </dl>
            <div className="flex items-center justify-end gap-2">
              {error ? <span className="mr-auto text-xs text-destructive">{error}</span> : null}
              <Button
                variant="outline"
                size="sm"
                onClick={handleUnbind}
                disabled={clearing || !environmentId}
              >
                {clearing ? "解绑中…" : "解绑"}
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground/80">
              尚未绑定飞书 Bot。绑定后即可在飞书中与本服务交互并审批;绑定的授权人始终可审批。
            </p>
            <div className="flex justify-end">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setDialogOpen(true)}
                disabled={!environmentId}
              >
                绑定飞书 Bot
              </Button>
            </div>
          </div>
        )}
      </div>

      {environmentId ? (
        <FeishuBindingDialog
          open={dialogOpen}
          environmentId={environmentId}
          onOpenChange={setDialogOpen}
        />
      ) : null}
    </SettingsSection>
  );
}

/**
 * Feishu per-chat approval configuration editor.
 *
 * Edits two ServerSettings fields with whole-value replacement semantics:
 * `feishuChatDefaults` (the default config every chat inherits) and
 * `feishuChatConfigs` (a `Record<chatId, FeishuChatConfig>` of per-chat
 * overrides). The bot resolves the effective approval mode per chat via
 * field-level fallback (`effectiveChatConfig`): per-chat override → defaults →
 * built-in `initiator`. The binding owner is always allowed (owner-always
 * overlay), so they never need to be listed as an approver.
 *
 * Pure map/entry manipulation lives in `FeishuSettings.logic.ts`.
 *
 * The whole `feishuChatConfigs` map is edited by many independent per-chat cards
 * yet persisted as one wholesale-replaced value with no optimistic server echo.
 * To stop a card from clobbering a sibling it wrote moments ago (the atom
 * snapshot stays stale for the write round-trip), this section owns the draft map
 * and mutates a ref synchronously on every commit, so each edit derives the next
 * whole map from the freshest accumulated draft rather than a render snapshot.
 */
/**
 * Optimistic overlay over a server-backed setting value.
 *
 * The settings write path is fire-and-forget with no local echo — the atom value
 * only advances when the server re-emits the config over the ws (which is also
 * how live-refresh + first-load HYDRATION arrive). So rendering from a seed-once
 * local copy is wrong: it freezes whatever the atom held at mount (often the
 * pre-hydration empty default), and a page refresh then shows stale/empty.
 *
 * Instead render the SERVER value by default, and hold a local `pending` value
 * ONLY while our own write is in flight so a rapid sequence of edits accumulates
 * (instead of each recomputing from a snapshot the round-trip hasn't updated yet).
 * The overlay settles back to the server value once the server catches up to our
 * latest write (deepEqual echo) or moves to something we didn't write (external
 * change / hydration) — both cases follow the server.
 */
function useOptimisticSetting<T>(
  serverValue: T,
  write: (next: T) => void,
): readonly [T, (updater: (current: T) => T) => void] {
  const [pending, setPending] = useState<T | null>(null);
  const pendingRef = useRef<T | null>(null);
  const lastWrittenRef = useRef<T | null>(null);
  const prevServerRef = useRef(serverValue);
  const serverRef = useRef(serverValue);
  serverRef.current = serverValue;

  if (prevServerRef.current !== serverValue) {
    prevServerRef.current = serverValue;
    if (lastWrittenRef.current === null || deepEqual(serverValue, lastWrittenRef.current)) {
      lastWrittenRef.current = null;
      pendingRef.current = null;
      if (pending !== null) setPending(null);
    }
  }

  const commit = useCallback(
    (updater: (current: T) => T) => {
      const next = updater(pendingRef.current ?? serverRef.current);
      pendingRef.current = next;
      lastWrittenRef.current = next;
      setPending(next);
      write(next);
    },
    [write],
  );

  return [pending ?? serverValue, commit];
}

function FeishuChatConfigSection() {
  const environmentId = usePrimaryEnvironment()?.environmentId ?? null;
  const { data, error, isPending } = useEnvironmentQuery(
    environmentId === null ? null : serverEnvironment.feishuListChats({ environmentId, input: {} }),
  );

  const serverConfigs = usePrimarySettings((s) => s.feishuChatConfigs) as FeishuChatConfigMap;
  // The default config a chat with no per-chat override inherits. Read here (not
  // just inside the defaults editor) so each per-chat card can show its TRUE
  // inherited command/workspace state — the bot resolves per-chat-absent fields
  // against these defaults, so a card must not claim "allows all" when the default
  // itself restricts. (Informational only; a one-round-trip lag vs the defaults
  // editor's own optimistic value is harmless for hint text.)
  const serverDefaults = usePrimarySettings((s) => s.feishuChatDefaults);
  // The binding owner is always allowed to approve (owner-always overlay), so
  // their roster checkbox is shown pre-checked and locked, not toggleable.
  const bindingOwnerOpenId = usePrimarySettings((s) => s.feishuBinding?.ownerOpenId);
  const update = useUpdatePrimarySettings();
  const writeConfigs = useCallback(
    (next: FeishuChatConfigMap) => update({ feishuChatConfigs: next }),
    [update],
  );
  const [configs, commitConfigs] = useOptimisticSetting(serverConfigs, writeConfigs);
  const commitChat = useCallback(
    (chatId: string, updater: (config: FeishuChatConfig) => FeishuChatConfig) => {
      commitConfigs((current) => writeChatConfig(current, chatId, updater(current[chatId] ?? {})));
    },
    [commitConfigs],
  );

  // Workspace-allowlist options: the projects on THIS (primary) environment — the
  // one the bot is bound to. `useProjects()` aggregates every environment, so
  // filter to the primary one (a projectId is only meaningful within its env).
  const allProjects = useProjects();
  const projects: ReadonlyArray<WorkspaceOption> =
    environmentId === null
      ? []
      : allProjects.filter((project) => project.environmentId === environmentId);

  // Group/topic chats only — p2p (single-user) chats have no approval roster and
  // always fall back to the initiator/owner path, so there is nothing to configure.
  const chats = (data?.chats ?? []).filter((chat) => chat.chatMode !== "p2p");

  return (
    <SettingsSection title="飞书审批配置" icon={<UsersIcon className="size-3" />}>
      <div className="space-y-2 px-4 py-3 text-xs text-muted-foreground/80 sm:px-5">
        <p>
          控制飞书审批卡片可由谁点击审批。审批模式分三档:
          <strong className="font-medium text-foreground/90">仅发起人</strong>(默认)、
          <strong className="font-medium text-foreground/90">指定审批人</strong>、
          <strong className="font-medium text-foreground/90">任意群成员</strong>。绑定飞书 Bot
          的授权人始终可审批,无需在此列出。
        </p>
        <p>
          先设默认,再按需为单个群覆盖:每个群可单独限制{" "}
          <strong className="font-medium text-foreground/90">可用命令</strong>与
          <strong className="font-medium text-foreground/90">可用工作区</strong>
          。在群里发{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px] text-foreground">
            /whoami
          </code>{" "}
          可获取自己的 open_id。绑定的授权人不受这些限制约束。
        </p>
      </div>

      <div className="border-t border-border/60 px-4 py-3 sm:px-5">
        <FeishuDefaultsEditor projects={projects} />
      </div>

      <div className="border-t border-border/60 px-4 py-3 sm:px-5">
        <h4 className="mb-2 font-medium text-foreground/90 text-xs">分群覆盖</h4>
        {environmentId === null ? (
          <p className="text-xs text-muted-foreground">未连接环境。</p>
        ) : isPending ? (
          <p className="text-xs text-muted-foreground">加载群列表…</p>
        ) : error ? (
          <p className="text-xs text-destructive">群列表加载失败:{error}</p>
        ) : chats.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            暂无群聊。Bot 加入群聊后会自动同步到这里。
          </p>
        ) : (
          <div className="space-y-3">
            {chats.map((chat) => (
              <FeishuChatConfigCard
                key={chat.chatId}
                chat={chat}
                config={configs[chat.chatId]}
                bindingOwnerOpenId={bindingOwnerOpenId}
                projects={projects}
                defaultCommands={serverDefaults.commands}
                defaultWorkspaces={serverDefaults.workspaces}
                onCommit={commitChat}
              />
            ))}
          </div>
        )}
      </div>
    </SettingsSection>
  );
}

/**
 * Default-config editor (`feishuChatDefaults`); always shows an explicit approval
 * mode. Commands/workspaces here are the baseline every un-overridden chat
 * inherits; absent = unrestricted (the built-in default).
 */
function FeishuDefaultsEditor({ projects }: { projects: ReadonlyArray<WorkspaceOption> }) {
  const serverDefaults = usePrimarySettings((s) => s.feishuChatDefaults);
  const update = useUpdatePrimarySettings();
  const writeDefaults = useCallback(
    (next: FeishuChatConfig) => update({ feishuChatDefaults: next }),
    [update],
  );
  const [draft, commit] = useOptimisticSetting(serverDefaults, writeDefaults);
  const mode = defaultsModeSelection(draft);

  return (
    <div className="space-y-2">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="font-medium text-foreground/90 text-xs">默认审批模式</p>
          <p className="text-[11px] text-muted-foreground/80">未单独配置的群聊都用这个模式。</p>
        </div>
        <ModeSelect
          value={mode}
          includeInherit={false}
          ariaLabel="默认审批模式"
          onChange={(selection) => {
            if (selection === INHERIT_MODE) return;
            commit((current) => setDefaultsApprovalMode(current, selection));
          }}
        />
      </div>
      {mode === "designated" ? (
        <ApproversEditor
          approvers={draft.approvers ?? []}
          idPrefix="feishu-default-approvers"
          onToggle={(openId) => commit((current) => toggleDefaultsApprover(current, openId))}
        />
      ) : null}
      <CommandsEditor commands={draft.commands} offHint="不限制,允许全部命令。" onChange={commit} />
      <WorkspacesEditor
        workspaces={draft.workspaces}
        projects={projects}
        offHint="不限制,允许全部工作区。"
        onChange={commit}
      />
    </div>
  );
}

/**
 * One group's override card — fully controlled by `FeishuChatConfigSection`,
 * which owns the draft map. `onCommit` takes an updater over THIS chat's current
 * config so the section can apply it against the freshest accumulated draft.
 */
function FeishuChatConfigCard({
  chat,
  config,
  bindingOwnerOpenId,
  projects,
  defaultCommands,
  defaultWorkspaces,
  onCommit,
}: {
  chat: FeishuChatDirectoryEntry;
  config: FeishuChatConfig | undefined;
  bindingOwnerOpenId?: string | undefined;
  projects: ReadonlyArray<WorkspaceOption>;
  defaultCommands: ReadonlyArray<string> | undefined;
  defaultWorkspaces: ReadonlyArray<string> | undefined;
  onCommit: (chatId: string, updater: (config: FeishuChatConfig) => FeishuChatConfig) => void;
}) {
  const mode = chatModeSelection(config);
  const memberCount = chat.memberCount ?? chat.members.length;
  // A card is fully controlled by the section; every editor emits an updater over
  // THIS chat's current config, applied against the freshest accumulated draft.
  const change = useCallback(
    (updater: (current: FeishuChatConfig) => FeishuChatConfig) => onCommit(chat.chatId, updater),
    [onCommit, chat.chatId],
  );

  return (
    <div className="rounded-lg border border-border/60 p-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="truncate font-medium text-foreground/90 text-sm">
            {chat.name || chat.chatId}
          </p>
          <p className="truncate text-[11px] text-muted-foreground/80">
            {memberCount} 名成员 · <span className="font-mono">{chat.chatId}</span>
          </p>
        </div>
        <ModeSelect
          value={mode}
          includeInherit
          ariaLabel={`${chat.name || chat.chatId} 审批模式`}
          onChange={(selection) => change((current) => setConfigApprovalMode(current, selection))}
        />
      </div>
      {mode === "designated" ? (
        <ApproversEditor
          approvers={config?.approvers ?? []}
          members={chat.members}
          bindingOwnerOpenId={bindingOwnerOpenId}
          idPrefix={`feishu-chat-${chat.chatId}`}
          onToggle={(openId) => change((current) => toggleConfigApprover(current, openId))}
        />
      ) : null}
      <CommandsEditor
        commands={config?.commands}
        offHint={describeInheritedCommands(defaultCommands)}
        onChange={change}
      />
      <WorkspacesEditor
        workspaces={config?.workspaces}
        projects={projects}
        offHint={describeInheritedWorkspaces(defaultWorkspaces)}
        onChange={change}
      />
    </div>
  );
}

/** Approval-mode select. `includeInherit` adds an "inherit default" sentinel row. */
function ModeSelect({
  value,
  onChange,
  includeInherit,
  ariaLabel,
}: {
  value: ChatModeSelection;
  onChange: (selection: ChatModeSelection) => void;
  includeInherit: boolean;
  ariaLabel: string;
}) {
  const label = value === INHERIT_MODE ? "继承默认" : APPROVAL_MODE_LABELS[value];
  return (
    <Select value={value} onValueChange={(next) => onChange(next as ChatModeSelection)}>
      <SelectTrigger size="sm" className="w-full sm:w-40" aria-label={ariaLabel}>
        <SelectValue>{label}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        {includeInherit ? (
          <SelectItem hideIndicator value={INHERIT_MODE}>
            继承默认
          </SelectItem>
        ) : null}
        {APPROVAL_MODES.map((approvalMode) => (
          <SelectItem hideIndicator key={approvalMode} value={approvalMode}>
            {APPROVAL_MODE_LABELS[approvalMode]}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

/**
 * Designated-approver picker. When a group roster (`members`) is available, it
 * shows a checkbox per member labelled by display name (open_id on hover, or as
 * the label when the name is absent). The binding owner (`bindingOwnerOpenId`),
 * if on the roster, is shown pre-checked and LOCKED — they always approve via the
 * owner-always overlay, so unchecking them would be a no-op; they are not written
 * into `approvers`. Any approver open_id not on the roster (or when no roster
 * exists — e.g. the defaults editor) is shown as a removable chip, and a free-text
 * input adds off-roster open_ids. Emits per-open_id toggles; the caller owns the
 * map write.
 */
function ApproversEditor({
  approvers,
  onToggle,
  idPrefix,
  members,
  bindingOwnerOpenId,
}: {
  approvers: ReadonlyArray<string>;
  onToggle: (openId: string) => void;
  idPrefix: string;
  members?: ReadonlyArray<FeishuChatMember>;
  bindingOwnerOpenId?: string | undefined;
}) {
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const selected = new Set(approvers);
  const roster = members ?? [];
  const rosterOpenIds = new Set(roster.map((member) => member.openId));
  const extras = approvers.filter((openId) => !rosterOpenIds.has(openId));

  const handleAdd = () => {
    const openId = input.trim();
    if (!openId) {
      setError("请输入 open_id。");
      return;
    }
    if (selected.has(openId)) {
      setError("该 open_id 已是审批人。");
      return;
    }
    onToggle(openId);
    setInput("");
    setError(null);
  };

  return (
    <div className="mt-2 space-y-2 rounded-md border border-border/60 bg-muted/20 p-2.5">
      <p className="text-[11px] text-muted-foreground/80">
        指定群内可审批的成员(可多选)。未额外勾选时仅绑定的授权人可审批;授权人凭 owner-always
        始终可审批,已默认勾选且不可取消。
      </p>
      {roster.length > 0 ? (
        <div className="grid gap-1 sm:grid-cols-2">
          {roster.map((member) => {
            const isOwner = member.openId === bindingOwnerOpenId;
            return (
              <label
                key={member.openId}
                title={member.openId}
                className={
                  isOwner
                    ? "flex min-w-0 items-center gap-2 rounded-sm px-1 py-1"
                    : "flex min-w-0 cursor-pointer items-center gap-2 rounded-sm px-1 py-1 hover:bg-accent/50"
                }
              >
                <Checkbox
                  checked={isOwner || selected.has(member.openId)}
                  disabled={isOwner}
                  onCheckedChange={() => {
                    if (!isOwner) onToggle(member.openId);
                  }}
                  aria-label={`审批人 ${member.name ?? member.openId}${isOwner ? "(授权人)" : ""}`}
                />
                <span
                  className={
                    member.name
                      ? "min-w-0 flex-1 truncate text-[11px] text-foreground/90"
                      : "min-w-0 flex-1 truncate font-mono text-[11px] text-foreground/90"
                  }
                >
                  {member.name ?? member.openId}
                </span>
                {isOwner ? (
                  <span className="shrink-0 rounded bg-primary/12 px-1 py-0.5 text-[10px] text-primary">
                    授权人
                  </span>
                ) : null}
              </label>
            );
          })}
        </div>
      ) : null}
      {extras.length > 0 ? (
        <div className="space-y-1">
          {roster.length > 0 ? (
            <p className="text-[11px] text-muted-foreground/70">群成员名录外的 open_id:</p>
          ) : null}
          {extras.map((openId) => (
            <div
              key={openId}
              className="grid min-h-7 grid-cols-[minmax(0,1fr)_auto] items-center gap-2"
            >
              <span className="min-w-0 truncate font-mono text-[11px] text-foreground/90">
                {openId}
              </span>
              <Button
                size="icon-xs"
                variant="ghost"
                className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                aria-label={`移除 ${openId}`}
                onClick={() => onToggle(openId)}
              >
                <XIcon className="size-3" />
              </Button>
            </div>
          ))}
        </div>
      ) : null}
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          id={`${idPrefix}-input`}
          value={input}
          onChange={(event) => {
            setInput(event.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            handleAdd();
          }}
          placeholder="ou_xxxxxxxxxxxxxxxx"
          spellCheck={false}
          aria-label="审批人 open_id"
        />
        <Button className="shrink-0" variant="outline" onClick={handleAdd}>
          <PlusIcon className="size-3.5" />
          添加
        </Button>
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

/**
 * Per-chat (or default) slash-command allowlist editor.
 *
 * A leading "限制可用命令" toggle maps directly to the field's presence semantics
 * (faithful to the bot's `authorizeCommand`): OFF = field ABSENT (inherit default
 * → all commands allowed); ON = an explicit allowlist. Turning it ON materializes
 * every configurable command checked (a no-op-yet-explicit restriction, never a
 * silent lock-out), which the admin then narrows. The floor commands (`/help`,
 * `/whoami`) are shown locked-on — always allowed, never stored. An empty checked
 * set is a real "only the floor" override (kept in the map), flagged in-line.
 */
function CommandsEditor({
  commands,
  offHint,
  onChange,
}: {
  commands: ReadonlyArray<string> | undefined;
  offHint: string;
  onChange: (updater: (config: FeishuChatConfig) => FeishuChatConfig) => void;
}) {
  const restricted = commands !== undefined;
  const selected = new Set(commands ?? []);
  const configurable = FEISHU_COMMAND_REGISTRY.filter((command) => !command.floor);
  const floor = FEISHU_COMMAND_REGISTRY.filter((command) => command.floor);

  return (
    <div className="mt-2 space-y-2 rounded-md border border-border/60 bg-muted/20 p-2.5">
      <label className="flex cursor-pointer items-center gap-2">
        <Checkbox
          checked={restricted}
          onCheckedChange={() =>
            onChange((current) =>
              setConfigCommands(
                current,
                restricted ? undefined : [...FEISHU_CONFIGURABLE_COMMANDS],
              ),
            )
          }
          aria-label="限制可用命令"
        />
        <span className="font-medium text-[11px] text-foreground/90">限制可用命令</span>
      </label>
      {restricted ? (
        <div className="space-y-1.5">
          <p className="text-[11px] text-muted-foreground/70">勾选本群可用的命令:</p>
          <div className="grid gap-1 sm:grid-cols-2">
            {configurable.map((command) => (
              <label
                key={command.token}
                className="flex min-w-0 cursor-pointer items-center gap-2 rounded-sm px-1 py-1 hover:bg-accent/50"
              >
                <Checkbox
                  checked={selected.has(command.token)}
                  onCheckedChange={() =>
                    onChange((current) => toggleConfigCommand(current, command.token))
                  }
                  aria-label={`命令 ${command.token}`}
                />
                <span className="min-w-0 flex-1 truncate text-[11px] text-foreground/90">
                  <span className="font-mono">{command.token}</span>
                  <span className="text-muted-foreground/70"> · {command.label}</span>
                </span>
              </label>
            ))}
            {floor.map((command) => (
              <label
                key={command.token}
                title="基础命令,始终可用"
                className="flex min-w-0 items-center gap-2 rounded-sm px-1 py-1"
              >
                <Checkbox checked disabled aria-label={`命令 ${command.token}(基础,始终可用)`} />
                <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground/70">
                  <span className="font-mono">{command.token}</span>
                  <span> · {command.label}</span>
                </span>
                <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
                  基础
                </span>
              </label>
            ))}
          </div>
          {selected.size === 0 ? (
            <p className="text-[11px] text-amber-600 dark:text-amber-500">
              仅基础命令(/help、/whoami)可用,本群无法使用其它命令。
            </p>
          ) : null}
        </div>
      ) : (
        <p className="text-[11px] text-muted-foreground/70">{offHint}</p>
      )}
    </div>
  );
}

/**
 * Per-chat (or default) workspace allowlist editor.
 *
 * Same presence semantics as {@link CommandsEditor} but faithful to the bot's
 * `isWorkspaceAuthorized`, and with the OPPOSITE empty meaning: OFF = field ABSENT
 * (inherit → every workspace authorized); ON = an explicit allowlist of
 * `ProjectId`s. Turning it ON materializes every current project checked (never a
 * silent lock-out). An empty checked set means NO workspace is authorized — the
 * chat can run nothing — so it is flagged as a destructive state. Authorized ids
 * no longer in the project list (deleted/renamed, or hand-edited) are surfaced as
 * removable rows rather than hidden.
 */
function WorkspacesEditor({
  workspaces,
  projects,
  offHint,
  onChange,
}: {
  workspaces: ReadonlyArray<string> | undefined;
  projects: ReadonlyArray<WorkspaceOption>;
  offHint: string;
  onChange: (updater: (config: FeishuChatConfig) => FeishuChatConfig) => void;
}) {
  const restricted = workspaces !== undefined;
  const selected = new Set(workspaces ?? []);
  const knownIds = new Set(projects.map((project) => project.id));
  const extras = (workspaces ?? []).filter((id) => !knownIds.has(id));
  // Turning restriction ON materializes every current project. With no projects to
  // authorize (still hydrating, or a genuinely empty env) that would commit
  // `workspaces: []` = NOBODY authorized — a silent lock-out — so block enabling
  // restriction until there is something to authorize. (Once ON, keep the toggle
  // enabled so it can always be turned back OFF.)
  const cannotEnable = !restricted && projects.length === 0;

  return (
    <div className="mt-2 space-y-2 rounded-md border border-border/60 bg-muted/20 p-2.5">
      <label
        className={
          cannotEnable
            ? "flex items-center gap-2 opacity-60"
            : "flex cursor-pointer items-center gap-2"
        }
      >
        <Checkbox
          checked={restricted}
          disabled={cannotEnable}
          onCheckedChange={() =>
            onChange((current) =>
              setConfigWorkspaces(
                current,
                restricted ? undefined : projects.map((project) => project.id),
              ),
            )
          }
          aria-label="限制可用工作区"
        />
        <span className="font-medium text-[11px] text-foreground/90">限制可用工作区</span>
        {cannotEnable ? (
          <span className="text-[11px] text-muted-foreground/60">(暂无工作区可授权)</span>
        ) : null}
      </label>
      {restricted ? (
        <div className="space-y-1.5">
          <p className="text-[11px] text-muted-foreground/70">勾选本群可用的工作区:</p>
          {projects.length === 0 && extras.length === 0 ? (
            <p className="text-[11px] text-muted-foreground/60">当前没有工作区。</p>
          ) : (
            <div className="space-y-1">
              {projects.map((project) => (
                <label
                  key={project.id}
                  title={project.workspaceRoot}
                  className="flex min-w-0 cursor-pointer items-center gap-2 rounded-sm px-1 py-1 hover:bg-accent/50"
                >
                  <Checkbox
                    checked={selected.has(project.id)}
                    onCheckedChange={() =>
                      onChange((current) => toggleConfigWorkspace(current, project.id))
                    }
                    aria-label={`工作区 ${project.title}`}
                  />
                  <span className="min-w-0 flex-1 truncate text-[11px] text-foreground/90">
                    {project.title}
                    <span className="text-muted-foreground/60"> · {project.workspaceRoot}</span>
                  </span>
                </label>
              ))}
              {extras.map((id) => (
                <label
                  key={id}
                  className="flex min-w-0 cursor-pointer items-center gap-2 rounded-sm px-1 py-1 hover:bg-accent/50"
                >
                  <Checkbox
                    checked
                    onCheckedChange={() =>
                      onChange((current) => toggleConfigWorkspace(current, id))
                    }
                    aria-label={`工作区 ${id}`}
                  />
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground/80">
                    {id}(不在当前项目列表)
                  </span>
                </label>
              ))}
            </div>
          )}
          {selected.size === 0 ? (
            <p className="text-[11px] text-destructive">
              ⚠ 未授权任何工作区,本群将无法使用任何工作区。
            </p>
          ) : null}
        </div>
      ) : (
        <p className="text-[11px] text-muted-foreground/70">{offHint}</p>
      )}
    </div>
  );
}
