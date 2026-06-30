"use client";

import type { EnvironmentId } from "@t3tools/contracts";
import { CheckCircle2Icon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { QRCodeSvg } from "../ui/qr-code";
import { Spinner } from "../ui/spinner";

interface FeishuBindingDialogProps {
  open: boolean;
  environmentId: EnvironmentId;
  onOpenChange: (open: boolean) => void;
}

/** Constant, classified reasons emitted by the server's binding `error` event. */
const ERROR_REASON_LABELS: Record<string, string> = {
  expired: "二维码已过期,请重试。",
  denied: "授权被拒绝。",
  aborted: "绑定已取消。",
  failed: "绑定失败,请重试。",
};

const TENANT_LABELS: Record<string, string> = {
  feishu: "飞书",
  lark: "Lark",
};

/** Best-effort friendly label for the SDK's raw device-flow status string. */
function describeStatus(status: string): string {
  const value = status.toLowerCase();
  if (value.includes("confirm") || value.includes("authoriz") || value.includes("scanned")) {
    return "已扫码,请在飞书中确认授权…";
  }
  return "等待飞书扫码…";
}

/**
 * Seconds remaining until `deadlineMs`, re-ticking once per second and stopping
 * (and clearing its interval) once it reaches 0 or the deadline is cleared.
 */
function useSecondsRemaining(deadlineMs: number | null): number | null {
  const [remaining, setRemaining] = useState<number | null>(() =>
    deadlineMs === null ? null : Math.max(0, Math.ceil((deadlineMs - Date.now()) / 1000)),
  );
  useEffect(() => {
    if (deadlineMs === null) {
      setRemaining(null);
      return;
    }
    setRemaining(Math.max(0, Math.ceil((deadlineMs - Date.now()) / 1000)));
    const id = setInterval(() => {
      const next = Math.max(0, Math.ceil((deadlineMs - Date.now()) / 1000));
      setRemaining(next);
      if (next <= 0) {
        clearInterval(id);
      }
    }, 1_000);
    return () => clearInterval(id);
  }, [deadlineMs]);
  return remaining;
}

/**
 * Web QR-scan flow for binding a Feishu/Lark bot.
 *
 * Subscribes to the server's device-code stream *only while open* — closing the
 * dialog drops the only subscriber, disposing the (idle-ttl 0) atom so the
 * server aborts the in-flight registerApp polling at once. The stream is scanned
 * into a sticky projection upstream, so the QR survives later `status` events.
 *
 * Security: no `appSecret` ever reaches the web — the stream's `bound` event
 * carries public identity only (appId / ownerOpenId / tenant).
 */
export function FeishuBindingDialog({
  open,
  environmentId,
  onOpenChange,
}: FeishuBindingDialogProps) {
  const {
    data: projection,
    error: transportError,
    refresh,
  } = useEnvironmentQuery(
    open ? serverEnvironment.feishuStartBinding({ environmentId, input: {} }) : null,
  );

  const qr = projection?.qr ?? null;
  const status = projection?.status ?? null;
  const bound = projection?.bound ?? null;
  const bindingError = projection?.error ?? null;

  // Anchor the countdown to a wall-clock deadline derived from when *this* client
  // received the QR (the server's `expireIn` is a duration). Cleared on any
  // terminal outcome so the ticker stops.
  const [qrDeadlineMs, setQrDeadlineMs] = useState<number | null>(null);
  const qrUrl = qr?.url ?? null;
  const qrExpireIn = qr?.expireIn ?? null;
  useEffect(() => {
    if (bound !== null || bindingError !== null || qrUrl === null || qrExpireIn === null) {
      setQrDeadlineMs(null);
      return;
    }
    setQrDeadlineMs(Date.now() + qrExpireIn * 1000);
  }, [bound, bindingError, qrUrl, qrExpireIn]);

  const remainingSeconds = useSecondsRemaining(qrDeadlineMs);
  const expired = qrDeadlineMs !== null && remainingSeconds !== null && remainingSeconds <= 0;

  const errorLabel = bindingError
    ? (ERROR_REASON_LABELS[bindingError.reason] ?? "绑定失败,请重试。")
    : transportError
      ? "无法启动绑定,请重试。"
      : expired
        ? ERROR_REASON_LABELS.expired
        : null;

  const handleRetry = useCallback(() => {
    setQrDeadlineMs(null);
    refresh();
  }, [refresh]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>绑定飞书 Bot</DialogTitle>
          <DialogDescription>
            用飞书扫描二维码并在手机上确认授权,即可为本服务绑定一个飞书
            Bot。绑定成功后,授权人会自动加入审批白名单。
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col items-center gap-4 py-2">
          {bound ? (
            <div className="flex flex-col items-center gap-3 py-2 text-center">
              <CheckCircle2Icon className="size-10 text-emerald-500" />
              <div className="space-y-1">
                <p className="text-sm font-medium text-foreground">已绑定飞书 Bot</p>
                <p className="font-mono text-xs text-muted-foreground">
                  {TENANT_LABELS[bound.tenant] ?? bound.tenant} · {bound.appId}
                </p>
                <p className="text-xs text-muted-foreground/80">
                  授权人 <span className="font-mono">{bound.ownerOpenId}</span>{" "}
                  已自动加入审批白名单。
                </p>
              </div>
            </div>
          ) : errorLabel ? (
            <div className="flex flex-col items-center gap-3 py-4 text-center">
              <p className="text-sm text-destructive">{errorLabel}</p>
            </div>
          ) : qr ? (
            <>
              <div className="rounded-xl border border-border/70 bg-white p-3">
                <QRCodeSvg
                  value={qr.url}
                  size={200}
                  level="M"
                  marginSize={2}
                  title="飞书 Bot 绑定二维码"
                />
              </div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Spinner className="size-3.5" />
                <span>{status ? describeStatus(status.status) : "等待飞书扫码…"}</span>
              </div>
              {remainingSeconds !== null ? (
                <p className="text-[11px] text-muted-foreground/70">
                  二维码 {remainingSeconds} 秒后过期
                </p>
              ) : null}
            </>
          ) : (
            <div className="flex flex-col items-center gap-3 py-8 text-muted-foreground">
              <Spinner className="size-5" />
              <p className="text-xs">正在生成二维码…</p>
            </div>
          )}
        </DialogPanel>
        <DialogFooter>
          {bound ? (
            <Button type="button" size="sm" variant="outline" onClick={() => onOpenChange(false)}>
              完成
            </Button>
          ) : errorLabel ? (
            <>
              <Button type="button" size="sm" variant="outline" onClick={() => onOpenChange(false)}>
                关闭
              </Button>
              <Button type="button" size="sm" onClick={handleRetry}>
                重试
              </Button>
            </>
          ) : (
            <Button type="button" size="sm" variant="outline" onClick={() => onOpenChange(false)}>
              取消
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
