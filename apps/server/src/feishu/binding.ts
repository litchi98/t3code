/**
 * Feishu bot-binding device-code (RFC8628) flow.
 *
 * Bridges `@larksuiteoapi/node-sdk`'s `registerApp` (web QR-scan provisioning)
 * into an Effect `Stream` of {@link FeishuBindingStreamEvent}s. The SDK import is
 * confined to this module.
 *
 * Security invariants:
 * - `appSecret` (`client_secret`) is handed to `persist` and NEVER emitted on a
 *   stream event payload.
 * - The `error` event carries a constant, classified `reason` only — the raw
 *   exception text never crosses the wire (and so never lands in an Effect span).
 *
 * @module feishu/binding
 */
import type { FeishuBindingStreamEvent } from "@t3tools/contracts";
import { registerApp } from "@larksuiteoapi/node-sdk";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

export interface FeishuBindingCredentials {
  readonly appId: string;
  readonly appSecret: string;
  readonly tenant: "feishu" | "lark";
  readonly ownerOpenId: string;
}

/**
 * Map an arbitrary `registerApp` rejection to a constant, non-sensitive reason.
 * The error's text is inspected only to classify it — it is never returned.
 */
const classifyBindingError = (error: unknown): string => {
  // Prefer the SDK's structured code (RFC8628: expired_token / access_denied /
  // abort) — it is stable across locales and SDK message wording.
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { readonly code: unknown }).code).toLowerCase()
      : undefined;
  if (code !== undefined) {
    if (code.includes("expir")) return "expired";
    if (code.includes("denied") || code.includes("access_denied")) return "denied";
    if (code.includes("abort")) return "aborted";
  }
  if (error instanceof Error) {
    if (error.name === "AbortError") return "aborted";
    const message = error.message.toLowerCase();
    if (message.includes("abort")) return "aborted";
    if (message.includes("expir")) return "expired";
    if (message.includes("denie") || message.includes("reject") || message.includes("cancel")) {
      return "denied";
    }
  }
  return "failed";
};

/**
 * Drive a single Feishu bot binding. Emits `qr` / `status` events while the user
 * scans, then either a `bound` event (after `persist` succeeds) or an `error`
 * event with a constant reason. The stream's error channel surfaces only a
 * `persist` failure (e.g. `ServerSettingsError`).
 */
export const makeFeishuBindingStream = <E>(opts: {
  readonly persist: (creds: FeishuBindingCredentials) => Effect.Effect<void, E>;
}): Stream.Stream<FeishuBindingStreamEvent> =>
  Stream.callback<FeishuBindingStreamEvent>((queue) =>
    Effect.gen(function* () {
      const controller = new AbortController();
      const scope = yield* Effect.scope;
      yield* Scope.addFinalizer(
        scope,
        Effect.sync(() => controller.abort()),
      );

      const registration = yield* Effect.tryPromise({
        try: () =>
          registerApp({
            signal: controller.signal,
            appPreset: { name: "t3code", desc: "t3code" },
            addons: {
              scopes: {
                tenant: ["im:message.send_as_bot", "im:message.group_msg"],
              },
              events: {
                items: {
                  tenant: ["im.message.receive_v1"],
                },
              },
              callbacks: {
                items: ["card.action.trigger"],
              },
            },
            onQRCodeReady: (info) => {
              Queue.offerUnsafe(queue, {
                version: 1,
                type: "qr",
                payload: { url: info.url, expireIn: info.expireIn },
              });
            },
            onStatusChange: (info) => {
              Queue.offerUnsafe(queue, {
                version: 1,
                type: "status",
                payload: {
                  status: info.status,
                  ...(info.interval === undefined ? {} : { interval: info.interval }),
                },
              });
            },
          }),
        catch: classifyBindingError,
      }).pipe(
        Effect.map((result) => ({ ok: true as const, result })),
        Effect.catch((reason: string) => Effect.succeed({ ok: false as const, reason })),
      );

      if (!registration.ok) {
        Queue.offerUnsafe(queue, {
          version: 1,
          type: "error",
          payload: { reason: registration.reason },
        });
        Queue.endUnsafe(queue);
        return;
      }

      const { result } = registration;
      const ownerOpenId = result.user_info?.open_id?.trim() ?? "";
      const tenant = result.user_info?.tenant_brand ?? "feishu";

      // The owner openId is the whole point (it becomes the bot's approver).
      // Without it we cannot persist a valid binding — treat as a failure.
      if (ownerOpenId.length === 0) {
        yield* Effect.logWarning("feishu binding: registerApp returned no open_id");
        Queue.offerUnsafe(queue, {
          version: 1,
          type: "error",
          payload: { reason: "failed" },
        });
        Queue.endUnsafe(queue);
        return;
      }

      // persist failure (e.g. ServerSettingsError) is converted to an `error`
      // event so the stream terminates cleanly; the cause is logged server-side
      // (it is our own tagged error — never contains the appSecret).
      const persisted = yield* opts
        .persist({
          appId: result.client_id,
          appSecret: result.client_secret,
          tenant,
          ownerOpenId,
        })
        .pipe(
          Effect.as(true as const),
          Effect.catch(() =>
            Effect.logWarning("feishu binding: persist failed").pipe(Effect.as(false as const)),
          ),
        );

      if (!persisted) {
        Queue.offerUnsafe(queue, {
          version: 1,
          type: "error",
          payload: { reason: "failed" },
        });
        Queue.endUnsafe(queue);
        return;
      }

      Queue.offerUnsafe(queue, {
        version: 1,
        type: "bound",
        payload: { appId: result.client_id, ownerOpenId, tenant },
      });
      Queue.endUnsafe(queue);
    }),
  );
