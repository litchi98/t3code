"use client";

import { PlusIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

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
export function FeishuSettingsPanel() {
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
    <SettingsPageContainer>
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
    </SettingsPageContainer>
  );
}
