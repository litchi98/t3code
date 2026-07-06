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

// ── Chat directory (bot-reported group roster + members) ─────────────
// The bot enumerates the group chats it belongs to via the Feishu IM API and
// reports the roster to the server, which persists it in the server-side
// `FeishuChatDirectory` store and serves it to the web settings UI (group list +
// the "designated approver" member picker). Nothing secret crosses here — Feishu
// open_ids are public within the tenant. The report is full-replace (first
// version): the bot always sends its complete current roster.

/**
 * One human member of a group chat (`im/v1/chats/:id/members`,
 * `member_id_type=open_id`): open_id plus the member's display name from the same
 * response (`items[].name`). The name lets the web approver picker show who an
 * open_id is; it may be absent depending on the tenant's member-info visibility,
 * so consumers fall back to the open_id.
 */
export const FeishuChatMember = Schema.Struct({
  openId: TrimmedNonEmptyString,
  name: Schema.optionalKey(TrimmedNonEmptyString),
});
export type FeishuChatMember = typeof FeishuChatMember.Type;

/** One group chat the bot belongs to, as reported by the bot. */
export const FeishuChatDirectoryEntry = Schema.Struct({
  chatId: TrimmedNonEmptyString,
  /** Display name (`im.v1.chat.list` / `im.v1.chat.get`). May be empty. */
  name: TrimmedString,
  /**
   * Raw Feishu `chat_mode` — known values are `"group"` / `"topic"` / `"p2p"`.
   * Kept as an open string (not a literal union) so an unrecognised future mode
   * never fails decoding of the whole roster.
   */
  chatMode: TrimmedString,
  /**
   * Human members (open_id + display name). Feishu never lists the bot's own
   * membership here (expected).
   */
  members: Schema.Array(FeishuChatMember),
  /** Chat owner's open_id, when the chat has one. */
  ownerOpenId: Schema.optionalKey(TrimmedNonEmptyString),
  /** Feishu-reported member count (may exceed `members.length`). */
  memberCount: Schema.optionalKey(Schema.Int),
});
export type FeishuChatDirectoryEntry = typeof FeishuChatDirectoryEntry.Type;

/**
 * A full roster snapshot. `reportedAt` (ISO 8601, server-stamped on save) is
 * absent until the bot has reported at least once. Returned by `feishu.listChats`.
 */
export const FeishuChatDirectorySnapshot = Schema.Struct({
  chats: Schema.Array(FeishuChatDirectoryEntry),
  reportedAt: Schema.optionalKey(Schema.String),
});
export type FeishuChatDirectorySnapshot = typeof FeishuChatDirectorySnapshot.Type;

/** Payload of `feishu.reportChats` (bot → server): the full current roster. */
export const FeishuReportChatsInput = Schema.Struct({
  chats: Schema.Array(FeishuChatDirectoryEntry),
});
export type FeishuReportChatsInput = typeof FeishuReportChatsInput.Type;

// ── Slash-command registry (M-3 PR-C) ────────────────────────────────────────
// Single source of truth for the bridge's slash-command surface, shared by the
// feishu-bot command gate (`bridge/authz.COMMAND_FLOOR`, filtered `/help`) and
// the web per-chat command-allowlist editor. Previously the command set lived
// only inside `apps/feishu-bot` (`buildCommandTable` keys + `HELP_SECTIONS` +
// `COMMAND_FLOOR`), which the web cannot import (separate package/process); the
// web would have had to mirror it and silently drift. Hoisting it here makes the
// bot and the web reference the SAME list.
//
// Tokens are the normalised command tokens (lowercase, leading `/`) the registry
// matches on. `floor` commands (`/help`, `/whoami`) are ALWAYS allowed — a
// self-lock floor the per-chat allowlist can never remove (a mis-configured
// allowlist must never lock a chat out of discovering how to fix itself) — so the
// web shows them locked-on, and only the non-floor commands are user-toggleable.

/** One slash command in the registry: its token, a short label, and whether it is floor. */
export interface FeishuCommandDescriptor {
  /** Normalised command token, lowercase with a leading `/` (e.g. `/workspace`). */
  readonly token: string;
  /** Short Chinese label for the web command-allowlist editor. */
  readonly label: string;
  /**
   * A self-lock floor command that BYPASSES the per-chat allowlist and is always
   * allowed (`/help`, `/whoami`). The web renders these locked-on; they are never
   * written into a chat's `commands` list.
   */
  readonly floor: boolean;
}

/**
 * Every slash command the feishu bridge exposes, in web display order (floor
 * commands last). Parity tests assert this token SET equals the bot's
 * `buildCommandTable` keys AND its `HELP_SECTIONS` commands (set equality, so the
 * per-list ordering is free to differ).
 */
export const FEISHU_COMMAND_REGISTRY: ReadonlyArray<FeishuCommandDescriptor> = [
  { token: "/workspace", label: "工作区:列出 / 切换 / 新增", floor: false },
  { token: "/resume", label: "接管当前工作区的会话", floor: false },
  { token: "/status", label: "查看当前绑定与会话状态", floor: false },
  { token: "/release", label: "退出当前会话", floor: false },
  { token: "/help", label: "查看本群可用命令", floor: true },
  { token: "/whoami", label: "查看自己的飞书 openId", floor: true },
];

/**
 * The floor command tokens — always allowed, never part of a per-chat allowlist.
 * The bot's `bridge/authz.COMMAND_FLOOR` re-exports this so there is one source.
 */
export const FEISHU_COMMAND_FLOOR: ReadonlyArray<string> = FEISHU_COMMAND_REGISTRY.filter(
  (command) => command.floor,
).map((command) => command.token);

/**
 * The non-floor command tokens — the ones a per-chat `commands` allowlist governs
 * and the web editor lets an admin check/uncheck.
 */
export const FEISHU_CONFIGURABLE_COMMANDS: ReadonlyArray<string> = FEISHU_COMMAND_REGISTRY.filter(
  (command) => !command.floor,
).map((command) => command.token);
