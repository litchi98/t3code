/**
 * Feishu chat-directory report loop (M-0).
 *
 * The bot enumerates the group chats it belongs to (`listChats`), resolves each
 * chat's mode / owner / members, and reports the full roster to the server via
 * the `feishu.reportChats` RPC, where it lands in the `FeishuChatDirectory` store
 * and feeds the web settings UI (group list + designated-approver picker).
 *
 * Fail-safe, but with one deliberate asymmetry driven by full-replace semantics:
 *   - `listChats` failure (couldn't even enumerate the bot's groups) → the whole
 *     report is SKIPPED, so a transient failure never wipes the server's
 *     last-known-good roster with an empty one.
 *   - a single chat's `getChatInfo` / `listChatMembers` failure → the chat is
 *     still recorded (degraded: sentinel mode / empty membership) rather than
 *     dropped, so a transient per-chat failure doesn't delete that group from
 *     the directory.
 * Both are logged. Nothing here ever disturbs the bot's main loop. Feishu's IM
 * reads are rate-limited (50 req/s), so chats are resolved strictly serially.
 *
 * The pieces are split so the roster assembly ({@link collectFeishuChatDirectory})
 * is unit-testable against a stub source, and so a later "refresh on demand" /
 * event-driven path can reuse them.
 *
 * @module chat-directory
 */
import * as EnvironmentRpc from "@t3tools/client-runtime/rpc";
import {
  type EnvironmentId,
  type FeishuChatDirectoryEntry,
  type FeishuChatMember,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import type { LarkGateway, LarkGatewayError } from "./lark/index.ts";

/**
 * The slice of {@link LarkGateway} the report loop needs. Narrowed to the three
 * chat-directory reads so a test can stub it without the whole gateway surface.
 */
export type ChatDirectorySource = Pick<
  LarkGateway["Service"],
  "listChats" | "getChatInfo" | "listChatMembers" | "getBotIdentity"
>;

/** The slice of {@link EnvironmentRegistry} the report needs (for stubbing). */
type ReportRegistry = Pick<EnvironmentRegistry["Service"], "run">;

/** Sentinel chat mode recorded when `getChatInfo` is unavailable for a chat. */
const UNKNOWN_CHAT_MODE = "unknown";

/**
 * Cap on total member entries in a single report. Purely defensive: a
 * pathological roster could otherwise build a payload that overruns the ws frame
 * limit and drops the bot's whole connection. Real rosters are far smaller.
 */
const MAX_TOTAL_MEMBER_ENTRIES = 50_000;

/**
 * Hard bound on bot-identity resolution at the report boundary. `getBotIdentity`
 * is best-effort display metadata; it must never DELAY the one-shot roster report
 * (a hung `bot/v3/info` probe has no HTTP timeout of its own) nor, via a defect,
 * SKIP it. Combined with the `catchCause` at the call site, a timeout OR any
 * defect degrades identity to `undefined` and the roster reports regardless.
 */
const BOT_IDENTITY_REPORT_TIMEOUT = "5 seconds";

/**
 * Resolve one chat into a directory entry. Never fails: if `getChatInfo` fails
 * the chat is still recorded with a sentinel `"unknown"` mode and no owner/count
 * (rather than vanishing from the full-replace roster); if `listChatMembers`
 * fails the chat is recorded with empty membership. Both cases log a warning; a
 * later successful report fills the gaps.
 */
const buildEntry = (
  source: ChatDirectorySource,
  chat: { readonly chatId: string; readonly name: string },
): Effect.Effect<FeishuChatDirectoryEntry> =>
  Effect.gen(function* () {
    const info = yield* source.getChatInfo(chat.chatId).pipe(
      Effect.map((resolved) => ({
        chatMode: resolved.chatMode,
        ownerOpenId: resolved.ownerOpenId,
        memberCount: resolved.memberCount,
      })),
      Effect.catch((error) =>
        Effect.logWarning(
          `[feishu-bot] feishu chat directory: chat ${chat.chatId} info unavailable; recording a minimal entry.`,
        ).pipe(
          Effect.annotateLogs({ cause: error }),
          Effect.as({
            chatMode: UNKNOWN_CHAT_MODE,
            ownerOpenId: undefined as string | undefined,
            memberCount: undefined as number | undefined,
          }),
        ),
      ),
    );
    const members = yield* source
      .listChatMembers(chat.chatId)
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning(
            `[feishu-bot] feishu chat directory: chat ${chat.chatId} members unavailable; recording empty membership.`,
          ).pipe(
            Effect.annotateLogs({ cause: error }),
            Effect.as([] as ReadonlyArray<FeishuChatMember>),
          ),
        ),
      );
    return {
      chatId: chat.chatId,
      name: chat.name,
      chatMode: info.chatMode,
      members,
      ...(info.ownerOpenId !== undefined ? { ownerOpenId: info.ownerOpenId } : {}),
      ...(info.memberCount !== undefined ? { memberCount: info.memberCount } : {}),
    };
  });

/**
 * Assemble the bot's full group roster. Fails ONLY if `listChats` fails — the
 * caller treats that as "couldn't enumerate" and skips the report entirely so a
 * transient failure never full-replaces (wipes) the server's last-known-good
 * roster. Per-chat failures never fail this effect (see {@link buildEntry}).
 * Chats are resolved serially to respect Feishu's rate limits.
 */
export const collectFeishuChatDirectory = (
  source: ChatDirectorySource,
): Effect.Effect<ReadonlyArray<FeishuChatDirectoryEntry>, LarkGatewayError> =>
  Effect.gen(function* () {
    const chats = yield* source.listChats;
    const entries: FeishuChatDirectoryEntry[] = [];
    for (const chat of chats) {
      entries.push(yield* buildEntry(source, chat));
    }
    return entries;
  });

/**
 * Truncate member lists so the reported payload can't overrun the ws frame cap.
 * Returns the (possibly trimmed) roster and whether anything was dropped.
 */
const capRoster = (
  chats: ReadonlyArray<FeishuChatDirectoryEntry>,
): { readonly chats: ReadonlyArray<FeishuChatDirectoryEntry>; readonly truncated: boolean } => {
  let budget = MAX_TOTAL_MEMBER_ENTRIES;
  let truncated = false;
  const capped = chats.map((chat) => {
    if (chat.members.length <= budget) {
      budget -= chat.members.length;
      return chat;
    }
    truncated = true;
    const kept = chat.members.slice(0, budget);
    budget = 0;
    return { ...chat, members: kept };
  });
  return { chats: capped, truncated };
};

/**
 * Collect the roster and report it to the server (full-replace). Fail-safe: if
 * the roster can't be enumerated (`listChats` failed) or the report RPC fails,
 * the report is skipped and logged — the bot NEVER sends an empty/partial roster
 * that would wipe the server's last-known-good directory. Fork onto the
 * bound-session scope so it is torn down on re-bind.
 */
export const reportFeishuChatDirectory = (deps: {
  readonly source: ChatDirectorySource;
  readonly registry: ReportRegistry;
  readonly environmentId: EnvironmentId;
}): Effect.Effect<void> =>
  collectFeishuChatDirectory(deps.source).pipe(
    Effect.flatMap((entries) =>
      Effect.gen(function* () {
        const { chats, truncated } = capRoster(entries);
        if (truncated) {
          yield* Effect.logWarning(
            `[feishu-bot] feishu chat directory: roster exceeded ${MAX_TOTAL_MEMBER_ENTRIES} member entries; truncated before report.`,
          );
        }
        // Bot display identity (name/avatar) for the web binding area (M-3
        // PR-C4). Red line: identity collection must NEVER block or skip the
        // roster report. `getBotIdentity`'s typed error channel is already
        // `never`, but this yields INSIDE the `catchCause`-guarded report block,
        // so a DEFECT (a malformed raw SDK shape) or a HUNG probe would otherwise
        // skip/stall even an empty `{chats:[]}` report. Bound both here: `timeout`
        // caps a hang and `catchCause` swallows the timeout failure AND any defect,
        // degrading to `undefined` so the roster ALWAYS reports. Only member
        // entries are capped; botIdentity is unaffected. Crucially this rides an
        // EMPTY-but-successful roster too (p2p-only / brand-new binding), which is
        // the only carrier that surfaces the bot's name/avatar with no groups.
        const botIdentity = yield* deps.source.getBotIdentity.pipe(
          Effect.timeout(BOT_IDENTITY_REPORT_TIMEOUT),
          Effect.catchCause(() => Effect.succeed(undefined)),
        );
        yield* deps.registry.run(
          deps.environmentId,
          EnvironmentRpc.request(WS_METHODS.feishuReportChats, {
            chats,
            ...(botIdentity !== undefined ? { botIdentity } : {}),
          }),
        );
      }),
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning(
        "[feishu-bot] feishu chat directory: report skipped (roster unavailable or RPC failed).",
        cause,
      ),
    ),
  );
