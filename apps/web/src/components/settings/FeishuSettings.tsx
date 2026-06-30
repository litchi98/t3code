"use client";

import { LinkIcon, PlusIcon, XIcon } from "lucide-react";
import { useCallback, useState } from "react";

import { usePrimaryEnvironment } from "~/state/environments";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { FeishuBindingDialog } from "./FeishuBindingDialog";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

/**
 * Feishu bot binding + approval allowlist settings.
 *
 * Bind the bot first (the QR-scan flow provisions the bot and auto-adds the
 * authorizing owner to the allowlist), then refine who else may approve.
 */
export function FeishuSettingsPanel() {
  return (
    <SettingsPageContainer>
      <FeishuBindingSection />
      <FeishuAllowlistSection />
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
              尚未绑定飞书 Bot。绑定后即可在飞书中与本服务交互并审批;授权人会自动加入审批白名单。
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
 * Feishu approval allowlist editor.
 *
 * Manages the *web-configured* slice of the Feishu approval allowlist
 * (`ServerSettings.feishuApprovalAllowlist`). The feishu-bot unions this list
 * with the open_ids from its env `FEISHU_OWNER_OPEN_IDS` floor at read time —
 * env entries are an immovable floor that always applies and is neither shown
 * nor removable here. Effective allowlist = env floor ∪ this list.
 *
 * The list is a flat string array, so this reuses the simpler shape of
 * `ProviderModelsSection`'s Input + Add + XIcon-remove pattern: local draft
 * state, trim + dedup on add, Enter-to-add, and per-row remove that writes the
 * whole replacement list back via `update`.
 */
function FeishuAllowlistSection() {
  const allowlist = usePrimarySettings((s) => s.feishuApprovalAllowlist);
  const update = useUpdatePrimarySettings();
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleAdd = () => {
    const openId = input.trim();
    if (!openId) {
      setError("请输入 open_id。");
      return;
    }
    if (allowlist.includes(openId)) {
      setError("该 open_id 已在白名单中。");
      return;
    }
    update({ feishuApprovalAllowlist: [...allowlist, openId] });
    setInput("");
    setError(null);
  };

  const handleRemove = (openId: string) => {
    update({ feishuApprovalAllowlist: allowlist.filter((id) => id !== openId) });
    setError(null);
  };

  return (
    <SettingsSection title="飞书审批白名单">
      <div className="space-y-2 px-4 py-3 text-xs text-muted-foreground/80 sm:px-5">
        <p>此列表为 web 配置的飞书审批白名单,列出的 open_id 可在需审批的群聊里操作审批卡片。</p>
        <p>
          飞书 bot 另有环境变量{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px] text-foreground">
            FEISHU_OWNER_OPEN_IDS
          </code>{" "}
          配置的 open_id 作为逃生口 / 默认地板:始终生效,既不在此显示、也无法在此删除。
          <strong className="font-medium text-foreground/90">
            实际生效白名单 = env 地板 ∪ 本列表
          </strong>
          。
        </p>
        <p>
          在飞书群里发{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px] text-foreground">
            /whoami
          </code>{" "}
          可获取自己的 open_id。
        </p>
      </div>

      <div className="border-t border-border/60 px-4 py-3 sm:px-5">
        {allowlist.length === 0 ? (
          <p className="text-xs text-muted-foreground">白名单为空。</p>
        ) : (
          <div className="space-y-1">
            {allowlist.map((openId) => (
              <div
                key={openId}
                className="grid min-h-7 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 py-1"
              >
                <span className="min-w-0 truncate font-mono text-xs text-foreground/90">
                  {openId}
                </span>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                        aria-label={`移除 ${openId}`}
                        onClick={() => handleRemove(openId)}
                      />
                    }
                  >
                    <XIcon className="size-3" />
                  </TooltipTrigger>
                  <TooltipPopup side="top">移除</TooltipPopup>
                </Tooltip>
              </div>
            ))}
          </div>
        )}

        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <Input
            id="feishu-approval-allowlist-input"
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
            aria-label="飞书审批白名单 open_id"
          />
          <Button className="shrink-0" variant="outline" onClick={handleAdd}>
            <PlusIcon className="size-3.5" />
            添加
          </Button>
        </div>

        {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
      </div>
    </SettingsSection>
  );
}
