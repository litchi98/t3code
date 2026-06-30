/**
 * Feishu/Lark bot-binding contracts (schema-only).
 *
 * Covers the "web scans QR to bind a Feishu bot" provisioning flow: the server
 * drives the Feishu device-code (RFC8628) registration and streams progress
 * events to the web client, then exposes the provisioned credentials to the
 * already-paired bot.
 *
 * Security invariant: `appSecret` NEVER appears in a stream event payload. It is
 * only ever returned by the `feishu.getBotCredentials` RPC (see rpc.ts) via
 * {@link FeishuBotCredentials}.
 *
 * @module feishu
 */
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";

/** Which deployment the bound bot lives in. */
export const FeishuTenant = Schema.Literals(["feishu", "lark"]);
export type FeishuTenant = typeof FeishuTenant.Type;

// ── Binding stream events ────────────────────────────────────────────
// Tagged union mirroring the device-code flow lifecycle. `appSecret` is
// intentionally absent from every payload here.

/** A QR/device code is ready for the user to scan. */
export const FeishuBindingStreamQrEvent = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("qr"),
  payload: Schema.Struct({
    url: TrimmedString,
    expireIn: Schema.Number,
  }),
});
export type FeishuBindingStreamQrEvent = typeof FeishuBindingStreamQrEvent.Type;

/** A polling/status update emitted while we wait for the scan to complete. */
export const FeishuBindingStreamStatusEvent = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("status"),
  payload: Schema.Struct({
    status: TrimmedString,
    interval: Schema.optionalKey(Schema.Number),
  }),
});
export type FeishuBindingStreamStatusEvent = typeof FeishuBindingStreamStatusEvent.Type;

/** Binding succeeded. Carries the public binding identity only (no secret). */
export const FeishuBindingStreamBoundEvent = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("bound"),
  payload: Schema.Struct({
    appId: TrimmedNonEmptyString,
    ownerOpenId: TrimmedNonEmptyString,
    tenant: FeishuTenant,
  }),
});
export type FeishuBindingStreamBoundEvent = typeof FeishuBindingStreamBoundEvent.Type;

/** Binding failed. `reason` is a constant, non-sensitive message. */
export const FeishuBindingStreamErrorEvent = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("error"),
  payload: Schema.Struct({
    reason: TrimmedString,
  }),
});
export type FeishuBindingStreamErrorEvent = typeof FeishuBindingStreamErrorEvent.Type;

export const FeishuBindingStreamEvent = Schema.Union([
  FeishuBindingStreamQrEvent,
  FeishuBindingStreamStatusEvent,
  FeishuBindingStreamBoundEvent,
  FeishuBindingStreamErrorEvent,
]);
export type FeishuBindingStreamEvent = typeof FeishuBindingStreamEvent.Type;

// ── Bot credentials (the single appSecret crossing point) ────────────

/** No bot is bound yet (or the secret was lost). */
export const FeishuBotCredentialsUnbound = Schema.Struct({
  bound: Schema.Literal(false),
});
export type FeishuBotCredentialsUnbound = typeof FeishuBotCredentialsUnbound.Type;

/** A bot is bound; the bot reads its `appSecret` here. */
export const FeishuBotCredentialsBound = Schema.Struct({
  bound: Schema.Literal(true),
  appId: TrimmedNonEmptyString,
  appSecret: Schema.String,
  tenant: FeishuTenant,
});
export type FeishuBotCredentialsBound = typeof FeishuBotCredentialsBound.Type;

export const FeishuBotCredentials = Schema.Union([
  FeishuBotCredentialsUnbound,
  FeishuBotCredentialsBound,
]);
export type FeishuBotCredentials = typeof FeishuBotCredentials.Type;
