"use client";

import type {
  FeishuChatConfig,
  FeishuChatDirectoryEntry,
  FeishuChatMember,
} from "@t3tools/contracts";
import { LinkIcon, PlusIcon, UsersIcon, XIcon } from "lucide-react";
import { useCallback, useRef, useState } from "react";

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
  defaultsModeSelection,
  type FeishuChatConfigMap,
  INHERIT_MODE,
  setConfigApprovalMode,
  setDefaultsApprovalMode,
  toggleConfigApprover,
  toggleDefaultsApprover,
  writeChatConfig,
} from "./FeishuSettings.logic";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

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
function FeishuChatConfigSection() {
  const environmentId = usePrimaryEnvironment()?.environmentId ?? null;
  const { data, error, isPending } = useEnvironmentQuery(
    environmentId === null ? null : serverEnvironment.feishuListChats({ environmentId, input: {} }),
  );

  const serverConfigs = usePrimarySettings((s) => s.feishuChatConfigs) as FeishuChatConfigMap;
  const update = useUpdatePrimarySettings();
  // Seed-once draft of the whole per-chat map; `draftRef` mirrors it and is
  // updated synchronously inside `commitChat` so back-to-back edits (same card or
  // different cards) accumulate instead of racing the settings-write round trip.
  const [draftConfigs, setDraftConfigs] = useState<FeishuChatConfigMap>(() => serverConfigs);
  const draftRef = useRef(draftConfigs);
  const commitChat = useCallback(
    (chatId: string, updater: (config: FeishuChatConfig) => FeishuChatConfig) => {
      const nextConfig = updater(draftRef.current[chatId] ?? {});
      const nextConfigs = writeChatConfig(draftRef.current, chatId, nextConfig);
      draftRef.current = nextConfigs;
      setDraftConfigs(nextConfigs);
      update({ feishuChatConfigs: nextConfigs });
    },
    [update],
  );

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
          先设默认,再按需为单个群覆盖。在群里发{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px] text-foreground">
            /whoami
          </code>{" "}
          可获取自己的 open_id。
        </p>
      </div>

      <div className="border-t border-border/60 px-4 py-3 sm:px-5">
        <FeishuDefaultsEditor />
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
                config={draftConfigs[chat.chatId]}
                onCommit={commitChat}
              />
            ))}
          </div>
        )}
      </div>
    </SettingsSection>
  );
}

/** Default-mode editor (`feishuChatDefaults`); always shows an explicit mode. */
function FeishuDefaultsEditor() {
  const serverDefaults = usePrimarySettings((s) => s.feishuChatDefaults);
  const update = useUpdatePrimarySettings();
  // Local draft is the source of truth while editing so a rapid sequence of
  // approver toggles accumulates instead of each racing the settings-write round
  // trip — settings writes are fire-and-forget with no optimistic echo, so a
  // handler that recomputed from the atom snapshot would clobber prior clicks.
  // `draftRef` is read (freshest) on commit; `draft` state drives the render.
  const [draft, setDraft] = useState<FeishuChatConfig>(() => serverDefaults);
  const draftRef = useRef(draft);
  const commit = useCallback(
    (updater: (config: FeishuChatConfig) => FeishuChatConfig) => {
      const next = updater(draftRef.current);
      draftRef.current = next;
      setDraft(next);
      update({ feishuChatDefaults: next });
    },
    [update],
  );
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
  onCommit,
}: {
  chat: FeishuChatDirectoryEntry;
  config: FeishuChatConfig | undefined;
  onCommit: (chatId: string, updater: (config: FeishuChatConfig) => FeishuChatConfig) => void;
}) {
  const mode = chatModeSelection(config);
  const memberCount = chat.memberCount ?? chat.members.length;

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
          onChange={(selection) =>
            onCommit(chat.chatId, (current) => setConfigApprovalMode(current, selection))
          }
        />
      </div>
      {mode === "designated" ? (
        <ApproversEditor
          approvers={config?.approvers ?? []}
          members={chat.members}
          idPrefix={`feishu-chat-${chat.chatId}`}
          onToggle={(openId) =>
            onCommit(chat.chatId, (current) => toggleConfigApprover(current, openId))
          }
        />
      ) : null}
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
 * the label when the name is absent). Any approver open_id not on the roster (or
 * when no roster exists — e.g. the defaults editor) is shown as a removable chip,
 * and a free-text input adds off-roster open_ids. Emits per-open_id toggles; the
 * caller owns the map write.
 */
function ApproversEditor({
  approvers,
  onToggle,
  idPrefix,
  members,
}: {
  approvers: ReadonlyArray<string>;
  onToggle: (openId: string) => void;
  idPrefix: string;
  members?: ReadonlyArray<FeishuChatMember>;
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
        指定群内可审批的成员(可多选)。留空表示群内无人可审批;绑定的授权人凭 owner-always
        始终可审批,无需勾选。
      </p>
      {roster.length > 0 ? (
        <div className="grid gap-1 sm:grid-cols-2">
          {roster.map((member) => (
            <label
              key={member.openId}
              title={member.openId}
              className="flex min-w-0 cursor-pointer items-center gap-2 rounded-sm px-1 py-1 hover:bg-accent/50"
            >
              <Checkbox
                checked={selected.has(member.openId)}
                onCheckedChange={() => onToggle(member.openId)}
                aria-label={`审批人 ${member.name ?? member.openId}`}
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
            </label>
          ))}
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
