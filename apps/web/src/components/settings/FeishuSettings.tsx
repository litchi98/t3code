"use client";

import type {
  FeishuChatConfig,
  FeishuChatDirectoryEntry,
  FeishuChatMember,
} from "@t3tools/contracts";
import { FEISHU_COMMAND_REGISTRY, FEISHU_CONFIGURABLE_COMMANDS } from "@t3tools/contracts";
import {
  ChevronRightIcon,
  CopyIcon,
  EllipsisIcon,
  LinkIcon,
  PlusIcon,
  UserIcon,
  UsersIcon,
  XIcon,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { useProjects } from "~/state/entities";
import { usePrimaryEnvironment } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { RightPanelSheet } from "../RightPanelSheet";
import { Avatar } from "../ui/avatar";
import { Badge } from "../ui/badge";
import { SheetTitle } from "../ui/sheet";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { FeishuBindingDialog } from "./FeishuBindingDialog";
import {
  APPROVAL_MODE_LABELS,
  APPROVAL_MODES,
  chatModeSelection,
  type ChatModeSelection,
  commandsSummary,
  type ConfigSource,
  deepEqual,
  DEFAULT_GROUP_DENSITY,
  defaultsModeSelection,
  defaultsSummary,
  DENSITY_LABELS,
  DENSITY_MODES,
  describeInheritedCommands,
  describeInheritedWorkspaces,
  type EffectiveConfig,
  effectiveConfig,
  type FeishuChatConfigMap,
  INHERIT_MODE,
  isChatOverridden,
  type RenderDensity,
  restingChatSummary,
  setConfigApprovalMode,
  setConfigCommands,
  setConfigDensity,
  setConfigWorkspaces,
  setDefaultsApprovalMode,
  SOURCE_LABELS,
  toggleConfigApprover,
  toggleConfigCommand,
  toggleConfigWorkspace,
  toggleDefaultsApprover,
  workspacesSummary,
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
  // The bot's display identity (name/avatar) and owner name ride the chat-directory
  // snapshot, not `feishuBinding` (which carries only bare ids). Same query the
  // per-chat section uses — the query atom family de-dupes by key, so subscribing
  // here too shares one in-flight request. `botIdentity`/`chats` are absent until
  // the bot has reported; every field below falls back to the bare id.
  const { data: directory } = useEnvironmentQuery(
    environmentId === null ? null : serverEnvironment.feishuListChats({ environmentId, input: {} }),
  );
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

  // Bot display identity, gated on the app match: the snapshot refreshes only
  // once per bot connect, so after a re-bind (app A → B) the stored identity may
  // still be A's until B reports. Show name/avatar ONLY when the reported appId
  // matches the CURRENT binding — otherwise fall back to the bare appId so a
  // stale identity is never shown against the new binding.
  const botIdentity = directory?.botIdentity;
  const botIdentityMatches =
    botIdentity !== undefined && binding !== undefined && botIdentity.appId === binding.appId;
  const botName =
    botIdentity !== undefined && botIdentityMatches && botIdentity.name.trim().length > 0
      ? botIdentity.name
      : null;
  const botAvatarUrl =
    botIdentity !== undefined && botIdentityMatches ? botIdentity.avatarUrl : undefined;

  // Owner display name: reverse-lookup the CURRENT binding owner's open_id in the
  // live roster's member lists (免疫 re-bind 过期 — always the current owner). The
  // binding owner (the scan authoriser) need not be a member of any group, so a
  // miss falls back to the bare open_id (never a fabricated name). Owner avatar is
  // descoped (needs a contact scope + re-bind), so the owner shows an initial chip.
  const ownerOpenId = binding?.ownerOpenId;
  const ownerName =
    ownerOpenId !== undefined
      ? (directory?.chats.flatMap((chat) => chat.members).find((m) => m.openId === ownerOpenId)
          ?.name ?? null)
      : null;

  return (
    <SettingsSection title="飞书 Bot 绑定" icon={<LinkIcon className="size-3" />}>
      <div className="px-4 py-3 sm:px-5">
        {binding ? (
          <div className="space-y-2.5">
            {/* Bot identity banner: avatar + name (falls back to the bare appId),
                with the appId as a secondary, copyable line. A "Lark" tag rides
                the name only when the tenant is the international edition — the
                common 飞书 case is already implied by the section title, so no
                redundant "部署: 飞书" row. */}
            <div className="flex items-center gap-3">
              <Avatar
                src={botAvatarUrl}
                name={botName ?? undefined}
                fallbackId={binding.appId}
                size="md"
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-sm font-medium text-foreground">
                    {botName ?? binding.appId}
                  </span>
                  {binding.tenant === "lark" ? (
                    <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                      Lark
                    </span>
                  ) : null}
                  {/* Binding owner (the scan authoriser, always allowed to approve)
                      as a compact chip: person icon + name, falling back to the
                      bare open_id. Replaces the standalone "Bot Owner" row. */}
                  <span
                    className="inline-flex min-w-0 shrink items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
                    title={`Bot Owner: ${binding.ownerOpenId}`}
                  >
                    <UserIcon className="size-2.5 shrink-0" />
                    <span className={cn("truncate", ownerName ? "" : "font-mono")}>
                      {ownerName ?? binding.ownerOpenId}
                    </span>
                  </span>
                </div>
                <div className="flex items-center gap-1">
                  <span className="truncate font-mono text-[11px] text-muted-foreground">
                    {binding.appId}
                  </span>
                  <CopyIdButton value={binding.appId} />
                </div>
              </div>
              <Menu>
                <MenuTrigger
                  disabled={!environmentId}
                  render={<Button aria-label="更多操作" size="icon-xs" variant="ghost" />}
                >
                  <EllipsisIcon />
                </MenuTrigger>
                <MenuPopup align="end">
                  <MenuItem
                    variant="destructive"
                    disabled={clearing || !environmentId}
                    onClick={handleUnbind}
                  >
                    {clearing ? "解绑中…" : "解绑"}
                  </MenuItem>
                </MenuPopup>
              </Menu>
            </div>
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
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

/** Which config the drawer is editing: one group override, or the shared defaults. */
type DrawerTarget =
  | { readonly kind: "chat"; readonly chatId: string }
  | { readonly kind: "defaults" };

/**
 * Master-detail per-chat config: a group section whose card lists a "默认配置"
 * baseline entry plus one quiet resting-summary row per group. Clicking a row (or
 * the baseline) slides out a right-hand drawer with that config's dimension
 * editors. The section owns BOTH optimistic overlays (`feishuChatConfigs` and
 * `feishuChatDefaults`) so the baseline summary, per-chat resting summaries, and
 * the drawer editors all read one consistent in-flight value — and so the drawer
 * renders the LIVE config (never a snapshot frozen at click time, which would show
 * stale/empty after a hard refresh; see the hydration note on `useOptimisticSetting`).
 */
function FeishuChatConfigSection() {
  const environmentId = usePrimaryEnvironment()?.environmentId ?? null;
  const { data, error, isPending } = useEnvironmentQuery(
    environmentId === null ? null : serverEnvironment.feishuListChats({ environmentId, input: {} }),
  );

  const serverConfigs = usePrimarySettings((s) => s.feishuChatConfigs) as FeishuChatConfigMap;
  const serverDefaults = usePrimarySettings((s) => s.feishuChatDefaults);
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
  const writeDefaults = useCallback(
    (next: FeishuChatConfig) => update({ feishuChatDefaults: next }),
    [update],
  );
  const [defaults, commitDefaults] = useOptimisticSetting(serverDefaults, writeDefaults);

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

  // The drawer stores only its TARGET (a chatId or the defaults sentinel), never a
  // config snapshot — the content re-reads `configs`/`defaults` live on every
  // render. `lastTarget` retains the target through the close transition so the
  // drawer body doesn't blank out mid-animation.
  const [drawerTarget, setDrawerTarget] = useState<DrawerTarget | null>(null);
  const lastTargetRef = useRef<DrawerTarget | null>(null);
  if (drawerTarget) lastTargetRef.current = drawerTarget;
  const activeTarget = drawerTarget ?? lastTargetRef.current;
  const closeDrawer = useCallback(() => setDrawerTarget(null), []);

  const activeChat =
    activeTarget?.kind === "chat"
      ? chats.find((chat) => chat.chatId === activeTarget.chatId)
      : undefined;

  return (
    <SettingsSection
      title={`群聊${chats.length > 0 ? ` · ${chats.length}` : ""}`}
      icon={<UsersIcon className="size-3" />}
    >
      {/* Clip the list to the card's inner radius: the baseline entry carries a
          persistent background and rows tint on hover, so their square corners would
          otherwise poke past the section's rounded (overflow-visible) border. */}
      <div className="overflow-hidden rounded-[calc(var(--radius-2xl)-1px)]">
        <BaselineEntry defaults={defaults} onEdit={() => setDrawerTarget({ kind: "defaults" })} />

        {environmentId === null ? (
          <p className="border-t border-border/60 px-4 py-3 text-xs text-muted-foreground sm:px-5">
            未连接环境。
          </p>
        ) : isPending ? (
          <p className="border-t border-border/60 px-4 py-3 text-xs text-muted-foreground sm:px-5">
            加载群列表…
          </p>
        ) : error ? (
          <p className="border-t border-border/60 px-4 py-3 text-xs text-destructive sm:px-5">
            群列表加载失败:{error}
          </p>
        ) : chats.length === 0 ? (
          <p className="border-t border-border/60 px-4 py-3 text-xs text-muted-foreground sm:px-5">
            暂无群聊。Bot 加入群聊后会自动同步到这里。
          </p>
        ) : (
          chats.map((chat) => (
            <ChatRestingRow
              key={chat.chatId}
              chat={chat}
              effective={effectiveConfig(chat.chatId, configs, defaults)}
              overridden={isChatOverridden(configs[chat.chatId])}
              onOpen={() => setDrawerTarget({ kind: "chat", chatId: chat.chatId })}
            />
          ))
        )}
      </div>

      <RightPanelSheet open={drawerTarget !== null} onClose={closeDrawer}>
        {activeTarget?.kind === "defaults" ? (
          <DefaultsDrawer
            defaults={defaults}
            projects={projects}
            onCommit={commitDefaults}
            onClose={closeDrawer}
          />
        ) : activeTarget?.kind === "chat" ? (
          <ChatConfigDrawer
            chatId={activeTarget.chatId}
            chat={activeChat}
            config={configs[activeTarget.chatId]}
            effective={effectiveConfig(activeTarget.chatId, configs, defaults)}
            defaults={defaults}
            projects={projects}
            onCommit={(updater) => commitChat(activeTarget.chatId, updater)}
            onClose={closeDrawer}
          />
        ) : null}
      </RightPanelSheet>
    </SettingsSection>
  );
}

/**
 * The default-config baseline entry pinned to the top of the group section — a
 * distinct object (not a group row) that every un-overridden chat inherits.
 * Clicking it opens the same drawer, in defaults mode.
 */
function BaselineEntry({ defaults, onEdit }: { defaults: FeishuChatConfig; onEdit: () => void }) {
  const summary = defaultsSummary(defaults);
  return (
    <button
      type="button"
      onClick={onEdit}
      className="flex w-full items-center gap-3 bg-muted/40 px-4 py-3 text-left transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:px-5"
    >
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center gap-2">
          <Badge variant="secondary" size="sm">
            基线
          </Badge>
          <span className="font-medium text-[13px] text-foreground/90">默认配置</span>
          <span className="text-[11px] text-muted-foreground/70">所有群的默认基线</span>
        </div>
        <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground/80">
          {summary.map((item, index) => (
            <span key={item.key} className="inline-flex items-center gap-1">
              {index > 0 ? (
                <span className="text-muted-foreground/30" aria-hidden>
                  ·
                </span>
              ) : null}
              <span className="text-muted-foreground/60">{item.key}</span>
              <span className="text-foreground/80">{item.value}</span>
            </span>
          ))}
        </p>
      </div>
      <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
        编辑默认
        <ChevronRightIcon className="size-3.5" />
      </span>
    </button>
  );
}

/**
 * One group's quiet resting-summary row (static blueprint). A clean chat reads a
 * muted "继承默认 · <mode>"; an overridden chat is marked with a small accent dot
 * and shows the dimensions it overrides. Clicking opens the detail drawer. The full
 * coverage fingerprint (per-dimension ○◐● + covered-dimension chips) is deferred.
 */
function ChatRestingRow({
  chat,
  effective,
  overridden,
  onOpen,
}: {
  chat: FeishuChatDirectoryEntry;
  effective: EffectiveConfig;
  overridden: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-3 border-t border-border/60 px-4 py-3 text-left transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:px-5"
    >
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-center gap-2">
          {overridden ? (
            <span className="size-1.5 shrink-0 rounded-full bg-primary/70" aria-label="已覆盖" />
          ) : null}
          <span className="truncate font-medium text-[13px] text-foreground">
            {chat.name || chat.chatId}
          </span>
          {chat.chatMode === "topic" ? (
            <Badge variant="secondary" size="sm">
              话题
            </Badge>
          ) : null}
        </div>
        <p
          className={cn(
            "truncate text-xs",
            overridden ? "text-muted-foreground/90" : "text-muted-foreground/70",
          )}
        >
          {restingChatSummary(effective, overridden)}
        </p>
      </div>
      <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground/70" />
    </button>
  );
}

/** Drawer chrome: sticky header (title + meta) with a close button, over a scrollable body. */
function DrawerShell({
  title,
  meta,
  onClose,
  children,
}: {
  title: string;
  meta: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-start justify-between gap-3 border-b border-border/60 px-5 py-4">
        <div className="min-w-0 space-y-1.5">
          {/* SheetTitle renders the base-ui Dialog.Title, wiring the popup's
              aria-labelledby so the drawer has an accessible name. */}
          <SheetTitle className="truncate text-base leading-snug">{title}</SheetTitle>
          {meta}
        </div>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="关闭"
          onClick={onClose}
          className="shrink-0"
        >
          <XIcon className="size-4" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">{children}</div>
    </div>
  );
}

/**
 * Copy `text` to the clipboard, returning whether it actually succeeded. Prefers
 * the async Clipboard API but falls back to a hidden-textarea `execCommand` for
 * non-secure contexts (the app is routinely served over plain-HTTP LAN IPs, where
 * `navigator.clipboard` is undefined) and when the async write rejects.
 */
async function copyToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through to the execCommand path
    }
  }
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

/** A "复制 ID" button that copies the raw chatId and confirms ONLY on a real copy. */
function CopyIdButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  // Clear the confirmation on a timer, and tear it down on unmount / re-copy so no
  // setState fires after the drawer closes.
  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(id);
  }, [copied]);
  return (
    <Button
      size="xs"
      variant="ghost"
      className="-ml-0.5 h-5 gap-1 px-1.5 text-[11px] text-muted-foreground"
      onClick={() => {
        void copyToClipboard(value).then((ok) => {
          if (ok) setCopied(true);
        });
      }}
    >
      <CopyIcon className="size-3" />
      {copied ? "已复制" : "复制 ID"}
    </Button>
  );
}

/**
 * Drawer body for a single group override. Renders the effective-preview card
 * (resolved "what the bot enforces" via the shared `effectiveConfig`) above the
 * five dimension editors (approval / approvers / commands / workspaces / density) —
 * flat (the collapse-one-at-a-time grid is deferred). All config values are read
 * LIVE from the section's optimistic overlay via props, so a hard refresh mid-edit
 * never freezes a stale snapshot into the drawer.
 */
function ChatConfigDrawer({
  chatId,
  chat,
  config,
  effective,
  defaults,
  projects,
  onCommit,
  onClose,
}: {
  chatId: string;
  chat: FeishuChatDirectoryEntry | undefined;
  config: FeishuChatConfig | undefined;
  effective: EffectiveConfig;
  defaults: FeishuChatConfig;
  projects: ReadonlyArray<WorkspaceOption>;
  onCommit: (updater: (config: FeishuChatConfig) => FeishuChatConfig) => void;
  onClose: () => void;
}) {
  const name = chat?.name || chatId;
  const memberCount = chat ? (chat.memberCount ?? chat.members.length) : undefined;
  const mode = chatModeSelection(config);

  return (
    <DrawerShell
      title={name}
      onClose={onClose}
      meta={
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          {chat?.chatMode === "topic" ? (
            <Badge variant="secondary" size="sm">
              话题群
            </Badge>
          ) : null}
          {memberCount !== undefined ? (
            <>
              <span>{memberCount} 人</span>
              <span className="text-muted-foreground/40" aria-hidden>
                ·
              </span>
            </>
          ) : null}
          <span className="truncate font-mono">{chatId}</span>
          <CopyIdButton value={chatId} />
        </div>
      }
    >
      <EffectivePreviewCard effective={effective} members={chat?.members ?? []} />

      <div className="space-y-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="font-medium text-foreground/90 text-xs">审批模式</p>
            <p className="text-[11px] text-muted-foreground/80">谁可以点击审批卡片放行。</p>
          </div>
          <ModeSelect
            value={mode}
            includeInherit
            ariaLabel={`${name} 审批模式`}
            onChange={(selection) =>
              onCommit((current) => setConfigApprovalMode(current, selection))
            }
          />
        </div>
        {mode === "designated" ? (
          <ApproversEditor
            approvers={config?.approvers ?? []}
            members={chat?.members ?? []}
            idPrefix={`feishu-chat-${chatId}`}
            onToggle={(openId) => onCommit((current) => toggleConfigApprover(current, openId))}
          />
        ) : null}
        <CommandsEditor
          commands={config?.commands}
          offHint={describeInheritedCommands(defaults.commands)}
          onChange={onCommit}
        />
        <WorkspacesEditor
          workspaces={config?.workspaces}
          projects={projects}
          offHint={describeInheritedWorkspaces(defaults.workspaces)}
          onChange={onCommit}
        />
        <DensityDimension
          title="消息密度"
          description="卡片信息量;低密度更适合高频刷屏的群。"
          value={config?.density}
          includeInherit
          ariaLabel={`${name} 消息密度`}
          onChange={(density) => onCommit((current) => setConfigDensity(current, density))}
        />
      </div>
    </DrawerShell>
  );
}

/**
 * Drawer body for the shared defaults (`feishuChatDefaults`); always an explicit
 * approval mode, no "inherit" option. Commands/workspaces here are the baseline
 * every un-overridden chat inherits; absent = unrestricted (the built-in default).
 */
function DefaultsDrawer({
  defaults,
  projects,
  onCommit,
  onClose,
}: {
  defaults: FeishuChatConfig;
  projects: ReadonlyArray<WorkspaceOption>;
  onCommit: (updater: (config: FeishuChatConfig) => FeishuChatConfig) => void;
  onClose: () => void;
}) {
  const mode = defaultsModeSelection(defaults);
  return (
    <DrawerShell
      title="默认配置"
      onClose={onClose}
      meta={
        <span className="text-xs text-muted-foreground">所有未单独覆盖的群都继承这些设置。</span>
      }
    >
      <div className="space-y-3">
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
              onCommit((current) => setDefaultsApprovalMode(current, selection));
            }}
          />
        </div>
        {mode === "designated" ? (
          <ApproversEditor
            approvers={defaults.approvers ?? []}
            idPrefix="feishu-default-approvers"
            onToggle={(openId) => onCommit((current) => toggleDefaultsApprover(current, openId))}
          />
        ) : null}
        <CommandsEditor
          commands={defaults.commands}
          offHint="不限制,允许全部命令。"
          onChange={onCommit}
        />
        <WorkspacesEditor
          workspaces={defaults.workspaces}
          projects={projects}
          offHint="不限制,允许全部工作区。"
          onChange={onCommit}
        />
        <DensityDimension
          title="默认消息密度"
          description="未单独配置的群聊都用这个密度(私聊始终用卡片)。"
          value={defaults.density ?? DEFAULT_GROUP_DENSITY}
          includeInherit={false}
          ariaLabel="默认消息密度"
          onChange={(density) => onCommit((current) => setConfigDensity(current, density))}
        />
      </div>
    </DrawerShell>
  );
}

/**
 * The drawer's effective-preview card: a chat's fully-resolved config with each
 * dimension's source tier (`[本群]/[默认]/[内置]`). Values come from the shared
 * `effectiveConfig` (the SAME resolver the bot uses), so "what the editor shows ==
 * what the bot enforces". owner-always is deliberately not surfaced here (no
 * "+授权人" tail); the density row mirrors the bot's `resolveDensity` fallback.
 */
function EffectivePreviewCard({
  effective,
  members,
}: {
  effective: EffectiveConfig;
  members: ReadonlyArray<FeishuChatMember>;
}) {
  const isDesignated = effective.approvalMode.value === "designated";
  const approverText =
    effective.approvers.value.length === 0
      ? "仅授权人"
      : effective.approvers.value
          .map((openId) => members.find((member) => member.openId === openId)?.name ?? openId)
          .join("、");
  const rows: ReadonlyArray<{
    readonly key: string;
    readonly value: string;
    readonly source?: ConfigSource;
  }> = [
    {
      key: "审批",
      value: APPROVAL_MODE_LABELS[effective.approvalMode.value],
      source: effective.approvalMode.source,
    },
    ...(isDesignated ? [{ key: "可批准", value: approverText }] : []),
    {
      key: "命令",
      value: commandsSummary(effective.commands.value),
      source: effective.commands.source,
    },
    {
      key: "工作区",
      value: workspacesSummary(effective.workspaces.value),
      source: effective.workspaces.source,
    },
    {
      key: "密度",
      value: DENSITY_LABELS[effective.density.value],
      source: effective.density.source,
    },
  ];

  return (
    <div className="rounded-lg border border-border/60 bg-muted/20 p-3">
      <p className="mb-2 font-medium text-[11px] text-muted-foreground/60 uppercase tracking-[0.06em]">
        生效预览 · 继承 + 覆盖解析后
      </p>
      <dl className="space-y-1.5">
        {rows.map((row) => (
          <div key={row.key} className="flex items-start justify-between gap-3 text-xs">
            <dt className="shrink-0 text-muted-foreground/70">{row.key}</dt>
            <dd className="flex min-w-0 flex-wrap items-center justify-end gap-1.5 text-right text-foreground/90">
              <span className="min-w-0 break-words">{row.value}</span>
              {row.source ? <SourceBadge source={row.source} /> : null}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/** A `[本群]/[默认]/[内置]` source tag; the own-override tier is primary-tinted, inherited is muted. */
function SourceBadge({ source }: { source: ConfigSource }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded px-1 py-0.5 text-[10px]",
        source === "chat" ? "bg-primary/12 text-primary" : "bg-muted text-muted-foreground",
      )}
    >
      {SOURCE_LABELS[source]}
    </span>
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
 * Render-density dimension: a segmented control (design-spec form) over a label +
 * description. `includeInherit` prepends a "继承默认" option (per-chat) that maps to
 * `undefined`; the defaults editor omits it (density is always an explicit value
 * there). This dimension is group-only — the bot forces p2p private chats to 卡片
 * regardless — so only group/topic drawers render it.
 */
function DensityDimension({
  title,
  description,
  value,
  includeInherit,
  ariaLabel,
  onChange,
}: {
  title: string;
  description: string;
  value: RenderDensity | undefined;
  includeInherit: boolean;
  ariaLabel: string;
  onChange: (density: RenderDensity | undefined) => void;
}) {
  const options: ReadonlyArray<{
    readonly key: string;
    readonly value: RenderDensity | undefined;
    readonly label: string;
  }> = [
    ...(includeInherit ? [{ key: "inherit", value: undefined, label: "继承默认" }] : []),
    ...DENSITY_MODES.map((density) => ({
      key: density,
      value: density,
      label: DENSITY_LABELS[density],
    })),
  ];
  return (
    <div className="space-y-2">
      <div className="min-w-0">
        <p className="font-medium text-foreground/90 text-xs">{title}</p>
        <p className="text-[11px] text-muted-foreground/80">{description}</p>
      </div>
      {/* Segmented control: connected buttons, selected = bg-accent (design spec).
          A radiogroup so density is a single-select choice with keyboard semantics. */}
      <div role="radiogroup" aria-label={ariaLabel} className="inline-flex w-fit">
        {options.map((option, index) => {
          const selected = value === option.value;
          return (
            <button
              key={option.key}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onChange(option.value)}
              className={cn(
                "inline-flex h-8 items-center justify-center border border-input px-3 font-medium text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                index === 0 ? "rounded-l-lg" : "-ml-px",
                index === options.length - 1 ? "rounded-r-lg" : "",
                selected
                  ? "bg-accent font-semibold text-foreground"
                  : "bg-background text-muted-foreground hover:bg-accent/60 hover:text-foreground",
              )}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Designated-approver picker. When a group roster (`members`) is available, it
 * shows a checkbox per member labelled by display name (open_id on hover, or as
 * the label when the name is absent). Any approver open_id not on the roster (or
 * when no roster exists — e.g. the defaults editor) is shown as a removable chip,
 * and a free-text input adds off-roster open_ids. Emits per-open_id toggles; the
 * caller owns the map write.
 *
 * owner-always is deliberately NOT surfaced here (design decision #5, PR-C2): the
 * binding owner appears as an ordinary roster member — no locked/pre-checked guard
 * rail, no owner-exemption footnote. The one owner-always explanation lives only in
 * the p2p section (PR-C3). (Checking the owner writes a harmless redundant entry;
 * the bot approves them via the owner-always overlay regardless.)
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
        指定群内可审批的成员(可多选);仅勾选的成员能点击审批放行,其余人点击无效。
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
