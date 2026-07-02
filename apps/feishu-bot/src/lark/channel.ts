/**
 * `@larksuite/channel` wiring for {@link LarkGateway} (M1).
 *
 * Constructs the `LarkChannel` from {@link FeishuCredentials}, registers the SDK
 * `on({ message, reconnecting, reconnected, error })` handlers and adapts them
 * onto the bridge's {@link BridgeHandlers}, and implements the outbound methods
 * (streaming card via `stream(...)`, reactions, resource download) by wrapping
 * the Promise/callback SDK in Effect.
 *
 * This module is the single place that touches the raw SDK instance; everything
 * else codes against the {@link LarkGateway} contract in `index.ts`.
 */
import { createLarkChannel } from "@larksuite/channel";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { streamingCardInput } from "./card.ts";
import {
  LarkGateway,
  LarkGatewayError,
  type StreamingCard,
  type StreamingCardCompletion,
} from "./index.ts";
import type {
  BridgeHandlers,
  CardStreamController,
  InboundAttachment,
  InboundMessage,
  NormalizedMessage,
  SendOptions,
} from "./types.ts";

/**
 * SDK stream throttle: coalesce render ticks into ~one card update per 400ms.
 *
 * Time-based throttling is the only gate we want — `eventRenderer` already
 * byte-clamps the card to stay under Feishu's ~30KB-per-element ceiling, so we
 * deliberately disable the SDK's *char-delta* gate (see {@link STREAM_THROTTLE_CHARS}).
 */
const STREAM_THROTTLE_MS = 400;

/**
 * Char-delta throttle gate, disabled.
 *
 * The SDK ships a card update as soon as *either* {@link STREAM_THROTTLE_MS} has
 * elapsed *or* the rendered payload grew by `streamThrottleChars` chars since the
 * last flush. Its default (50) is tiny next to a full card's JSON, so every tick
 * would trip the char gate and flush immediately — bypassing the 400ms window and
 * risking Feishu rate limits. Setting this absurdly high makes the char gate
 * unreachable, leaving {@link STREAM_THROTTLE_MS} as the sole pacing mechanism.
 */
const STREAM_THROTTLE_CHARS = Number.MAX_SAFE_INTEGER;

/** User-Agent caller tag appended by the SDK as `source/<name>`. */
const SOURCE_TAG = "t3tools-feishu-bot";

/** WebSocket handshake bound so a stuck DNS/proxy path fails fast and retries. */
const HANDSHAKE_TIMEOUT_MS = 30_000;

/**
 * Single admission point for inbound chat types.
 *
 * M3a opens group chats alongside 1:1 private chats, so this admits `"p2p"` and
 * `"group"` (topic groups also report `chatType === "group"`; the topic split
 * lives in {@link NormalizedMessage.chatMode}, surfaced as `InboundMessage.chatMode`).
 * The `message` callback routes solely on this gate, plus an @-mention guard for
 * group messages (see the `message` handler).
 */
const acceptChatType = (chatType: string): boolean => chatType === "p2p" || chatType === "group";

/**
 * Wrap an SDK Promise call, tagging any rejection as a {@link LarkGatewayError}.
 * The SDK rejects with `LarkChannelError` (carrying a `code`), which we carry
 * verbatim as `cause` so callers can inspect it if needed.
 */
const sdkCall = <A>(describe: string, run: () => Promise<A>): Effect.Effect<A, LarkGatewayError> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new LarkGatewayError({ message: `Feishu ${describe} failed.`, cause }),
  });

/**
 * Minimal structural view of the slice of `channel.rawClient` we use to resolve
 * a user's display name (`contact.user.get`). We deliberately do NOT lean on the
 * node-sdk's auto-generated overload types here (300k+ lines, brittle to infer):
 * this narrow interface names only the request/response shape the call relies on
 * — `{ path: { user_id }, params: { user_id_type } }` → `{ data?: { user?: {
 * name? } } }` — keeping the call site type-checked and resilient to SDK churn.
 */
interface RawContactClient {
  readonly contact: {
    readonly user: {
      readonly get: (payload: {
        readonly path: { readonly user_id: string };
        readonly params: { readonly user_id_type: "open_id" };
      }) => Promise<{ readonly data?: { readonly user?: { readonly name?: string } } }>;
    };
  };
}

/**
 * Narrow structural view of `channel.rawClient.im.chatMembers.get` — the group
 * member list (`GET im/v1/chats/:chat_id/members`). Same rationale as
 * {@link RawContactClient}: name only the request/response slice we use rather
 * than lean on the node-sdk's generated overloads. The runtime path
 * (`im.chatMembers.get`) is the flat alias the node-sdk exposes alongside the
 * `im.v1.*` chain (verified against `@larksuiteoapi/node-sdk`), matching the
 * flat `contact.user.get` used by {@link RawContactClient}.
 */
interface RawChatMembersClient {
  readonly im: {
    readonly chatMembers: {
      readonly get: (payload: {
        readonly path: { readonly chat_id: string };
        readonly params: {
          readonly member_id_type: "open_id";
          readonly page_size: number;
          readonly page_token?: string;
        };
      }) => Promise<{
        readonly data?: {
          readonly items?: ReadonlyArray<{ readonly member_id?: string }>;
          readonly page_token?: string;
          readonly has_more?: boolean;
        };
      }>;
    };
  };
}

/** Feishu caps chat-member pages at 100 rows. */
const MEMBER_PAGE_SIZE = 100;

/**
 * Hard cap on member pages fetched per chat (100 rows × 50 pages = 5000
 * members). Mirrors the SDK's own `maxPages` guard on `listChats`: a runaway
 * `has_more` (or a page_token that never clears) can't spin the report loop
 * forever.
 */
const MAX_MEMBER_PAGES = 50;

/** Feishu caps chat-list pages at 100 rows. */
const CHATS_PAGE_SIZE = 100;

/**
 * Page cap for `listChats` (100 rows × 100 pages = 10 000 chats). The SDK
 * defaults `maxPages` to 10 (≈1000 chats) and silently truncates past it; we
 * raise the ceiling and log if a bot ever brushes it so a truncated roster is
 * never mistaken for the full one.
 */
const CHATS_MAX_PAGES = 100;

/**
 * Coerce the SDK's chat `memberCount` into a safe integer.
 *
 * Feishu's `im.v1.chat.get` returns `user_count` as a JSON **string** (e.g.
 * `"5"`), and `@larksuite/channel` passes it straight through while its `.d.ts`
 * mislabels the field `number` — the same lie as `chatType`, one field over.
 * Left untouched it would be a string at runtime and blow up the `Schema.Int`
 * encoding of the whole `reportChats` payload (one bad field → the entire
 * full-replace roster is lost). Coerce to an integer, dropping non-integral or
 * missing values.
 */
export const coerceChatMemberCount = (value: unknown): number | undefined => {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
};

/**
 * Project a raw {@link NormalizedMessage} into the bridge-facing
 * {@link InboundMessage}. Only image resources survive (M1 surfaces images;
 * other resource kinds are dropped — the bridge replies with a "text/image
 * only" notice elsewhere). Optional fields are spread conditionally to satisfy
 * `exactOptionalPropertyTypes`.
 */
const normalizeInbound = (message: NormalizedMessage): InboundMessage => {
  const attachments: ReadonlyArray<InboundAttachment> = message.resources
    .filter((resource) => resource.type === "image")
    .map((resource) => ({
      kind: "image" as const,
      fileKey: resource.fileKey,
      ...(resource.fileName !== undefined ? { fileName: resource.fileName } : {}),
    }));

  // Strip a leading @BotName mention from the message text.
  //
  // SDK behaviour differs by message type:
  //   • `text` messages   — the SDK's resolveMentions pass already strips bot
  //     mentions by replacing the `@_user_xxx` placeholder with an empty string,
  //     so the regex below is a no-op.
  //   • `post` (rich-text) messages — renderElement calls the per-element mention
  //     renderer, which looks the mention up by user_id type; because the bot's
  //     open_id does not match a user_id the lookup fails and the literal text
  //     `@ClientBot` (or the actual bot name) leaks into the rendered string. The
  //     SDK's resolveMentions pass then has no placeholder key to strip, so the
  //     literal survives into `message.content` and reaches the prompt unchanged.
  //
  // We detect the bot-mention case via `message.mentionedBot` (SDK-set), find the
  // bot's `MentionInfo` by `isBot`, and strip the leading "@Name " prefix.
  let text = message.content;
  if (message.mentionedBot) {
    const botName = message.mentions.find((m) => m.isBot)?.name;
    if (botName) {
      const escaped = botName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // Fix D: negative lookahead `(?!\w)` prevents stripping when the bot
      // name is a strict prefix of another display name (e.g. bot="Bot",
      // sender="@BotMaster …" → "M" is \w → not stripped). Space, slash,
      // CJK, and end-of-string all satisfy (?!\w) so normal mentions still
      // work: "@Bot 消息"  "@Bot/resume"  "@Bot创建"  "@Bot" (alone).
      text = text.replace(new RegExp(`^@${escaped}(?!\\w)\\s*`), "").trim();
    }
  }

  return {
    chatId: message.chatId,
    chatType: message.chatType,
    messageId: message.messageId,
    senderId: message.senderId,
    text,
    attachments,
    createTime: message.createTime,
    // M3a routing projections. `mentionedBot` is always present on the SDK
    // shape; `threadId`/`chatMode`/`rootId` are spread conditionally to satisfy
    // `exactOptionalPropertyTypes` (omitted, not set to `undefined`).
    mentionedBot: message.mentionedBot,
    ...(message.senderName !== undefined ? { senderName: message.senderName } : {}),
    ...(message.threadId !== undefined ? { larkThreadId: message.threadId } : {}),
    ...(message.chatMode !== undefined ? { chatMode: message.chatMode } : {}),
    ...(message.rootId !== undefined ? { rootId: message.rootId } : {}),
  };
};

/**
 * Just the open-platform credentials `createLarkChannel` needs to bring up the
 * WebSocket: app id, app secret, and the tenant-derived domain. PR2 narrows the
 * gateway layer's input to this triple (down from the whole bot Feishu config)
 * so the credentials can be resolved at runtime — from the server's bot binding
 * or the `.env` dev override — and passed in per binding without dragging the
 * bot-own knobs (`ownerOpenIds`/`groupChatDensity`) through this layer.
 */
export interface FeishuCredentials {
  readonly appId: string;
  readonly appSecret: string;
  readonly domain: string;
}

/**
 * Build the {@link LarkGateway} layer for the given Feishu app credentials.
 *
 * The channel is constructed eagerly (cheap, synchronous — no network), and a
 * scope finalizer best-effort disconnects it so the WebSocket is torn down when
 * the layer is released. `connect` registers the handlers and opens the socket;
 * the outbound methods wrap the SDK's Promise surface.
 */
export const larkGatewayLayer = (config: FeishuCredentials): Layer.Layer<LarkGateway> =>
  Layer.effect(
    LarkGateway,
    Effect.gen(function* () {
      const channel = yield* Effect.sync(() =>
        createLarkChannel({
          appId: config.appId,
          appSecret: config.appSecret,
          domain: config.domain,
          transport: "websocket",
          source: SOURCE_TAG,
          handshakeTimeoutMs: HANDSHAKE_TIMEOUT_MS,
          includeRawEvent: true,
          resolveChatMode: true,
          keepalive: { enabled: true },
          // M1 streams via the card-producer path (`stream(chatId, { card:
          // { initial, producer } })`), so we only set the two outbound knobs
          // that path honours. `streamMaxElementChars` is intentionally omitted:
          // the SDK reads it only on the markdown-stream path (to auto-roll into
          // a fresh card), not on the card path — there, byte budgeting is
          // `eventRenderer`'s job, which clamps each element by *byte* length
          // before render.
          outbound: {
            streamThrottleMs: STREAM_THROTTLE_MS,
            streamThrottleChars: STREAM_THROTTLE_CHARS,
          },
        }),
      );

      // Tear the WebSocket down when the layer's scope closes. Disconnecting an
      // already-closed channel is harmless; swallow any error so release stays
      // total.
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => channel.disconnect().catch(() => undefined)),
      );

      const connect = (handlers: BridgeHandlers) =>
        Effect.gen(function* () {
          // Register handlers before opening the socket so no event is missed.
          // The SDK callbacks fire on its own async loop; `BridgeHandlers` are
          // plain `void` functions adapted onto the bridge runtime, so we invoke
          // them directly. M3a admits p2p and group (@-mention-gated) messages.
          yield* Effect.sync(() =>
            channel.on({
              message: (message) => {
                // Single admission point: M3a admits p2p and group.
                if (!acceptChatType(message.chatType)) {
                  return;
                }
                // Group @-mention guard (redundant defence). Feishu only pushes
                // group messages that @-mention the bot, so `mentionedBot` should
                // already be true here; we still drop an un-mentioned group
                // message rather than spawn a turn for chatter the bot wasn't
                // addressed in. `undefined` (mention info absent) is tolerated as
                // "allow" so a normalisation gap never silences the bot. The p2p
                // path is unaffected — it never consults `mentionedBot`.
                if (message.chatType === "group" && message.mentionedBot === false) {
                  return;
                }
                handlers.onInboundMessage(normalizeInbound(message));
              },
              // Card interactions are NOT gated by `acceptChatType`: interaction
              // cards are sent by the bridge to any chat it drives (p2p, group, or
              // topic), so every `cardAction` is routed straight to the bridge,
              // which verifies the signed token and resolves the binding (M2b-1).
              cardAction: (evt) => {
                handlers.onCardAction(evt);
              },
              reconnecting: () => {
                handlers.onReconnecting();
              },
              reconnected: () => {
                handlers.onReconnected();
              },
              error: (error) => {
                handlers.onError(error);
              },
            }),
          );

          yield* sdkCall("connect", () => channel.connect());
        });

      const disconnect = sdkCall("disconnect", () => channel.disconnect());

      const startStreamingCard = (
        chatId: string,
        initial: object,
        completion: StreamingCardCompletion,
        sendOpts?: SendOptions,
      ): Effect.Effect<StreamingCard, LarkGatewayError> =>
        Effect.gen(function* () {
          // Native-Promise handoff: the SDK producer runs the card's whole
          // lifetime, but the caller needs the handle (with `messageId`) the
          // instant the card message exists — not when the turn finishes.
          let resolveController!: (controller: CardStreamController) => void;
          let rejectController!: (cause: unknown) => void;
          const controllerReady = new Promise<CardStreamController>((resolve, reject) => {
            resolveController = resolve;
            rejectController = reject;
          });

          // The bridge resolves `completion.done` when the turn is terminal;
          // run it to a Promise the producer parks on so the card stays live.
          // Use the surrounding services (via `Effect.context` + `runPromiseWith`)
          // rather than a bare `Effect.runPromise`, so the bridged effect keeps
          // this fiber's runtime context instead of the default runtime's.
          const services = yield* Effect.context<never>();
          const donePromise = Effect.runPromiseWith(services)(completion.done);

          const input = streamingCardInput(initial, resolveController, donePromise);

          // Fire-and-forget: `stream(...)` resolves only after the producer
          // returns (turn end). If it rejects before the controller is handed
          // back, surface that to the waiter; later rejections have nowhere to
          // go (the turn is over) and are swallowed. `sendOpts` (M3a) carries the
          // optional topic reply (`replyInThread` / `replyTo`); `undefined` keeps
          // the legacy p2p/group send behaviour byte-for-byte unchanged.
          void channel
            .stream(chatId, input, sendOpts)
            .catch((cause: unknown) => rejectController(cause));

          const controller = yield* Effect.tryPromise({
            try: () => controllerReady,
            catch: (cause) =>
              new LarkGatewayError({ message: "Feishu streaming card failed to start.", cause }),
          });

          const card: StreamingCard = {
            messageId: controller.messageId,
            update: (next) => sdkCall("card update", () => controller.update(next)),
          };
          return card;
        });

      const updateCard = (messageId: string, card: object) =>
        sdkCall("card update", () => channel.updateCard(messageId, card));

      // Resolve a user's display name via the raw node-sdk contact client the
      // channel exposes (`rawClient`). Cast through the narrow `RawContactClient`
      // view (see its note) so the call is type-checked without depending on the
      // SDK's generated overloads. A failure (missing scope → 403, network) is
      // tagged as a LarkGatewayError for the caller to catch and fall back from.
      const rawContact = channel.rawClient as unknown as RawContactClient;
      const getUser = (
        openId: string,
      ): Effect.Effect<{ readonly name?: string }, LarkGatewayError> =>
        sdkCall("contact user get", () =>
          rawContact.contact.user.get({
            path: { user_id: openId },
            params: { user_id_type: "open_id" },
          }),
        ).pipe(
          Effect.map((response) => {
            const name = response.data?.user?.name;
            return name === undefined ? {} : { name };
          }),
        );

      // Chat-directory reads (M-0). `listChats` and `getChatInfo` use the
      // channel's own wrappers; `listChatMembers` has no wrapper, so it goes
      // through the same `rawClient` escape hatch as `getUser`.
      const rawChatMembers = channel.rawClient as unknown as RawChatMembersClient;

      const listChats = sdkCall("list chats", () =>
        channel.listChats({ pageSize: CHATS_PAGE_SIZE, maxPages: CHATS_MAX_PAGES }),
      ).pipe(
        Effect.tap((chats) =>
          chats.length >= CHATS_PAGE_SIZE * CHATS_MAX_PAGES
            ? Effect.logWarning(
                `[feishu-bot] feishu chat directory: listChats hit the ${
                  CHATS_PAGE_SIZE * CHATS_MAX_PAGES
                }-chat ceiling; the roster may be truncated.`,
              )
            : Effect.void,
        ),
        Effect.map((chats) => chats.map((chat) => ({ chatId: chat.id, name: chat.name }))),
      );

      const getChatInfo = (chatId: string) =>
        sdkCall("get chat info", () => channel.getChatInfo(chatId)).pipe(
          Effect.map((info) => {
            // `getChatInfo` maps the raw `chat_mode` onto `chatType` (typed
            // "p2p"|"group" but carrying "topic" at runtime), so read it as an
            // opaque string. `memberCount` is a JSON string at runtime despite
            // its `number` type (see coerceChatMemberCount). Optional fields are
            // spread conditionally for `exactOptionalPropertyTypes`.
            const memberCount = coerceChatMemberCount(info.memberCount);
            return {
              chatMode: String(info.chatType),
              ...(info.name !== undefined ? { name: info.name } : {}),
              ...(info.ownerId !== undefined ? { ownerOpenId: info.ownerId } : {}),
              ...(memberCount !== undefined ? { memberCount } : {}),
            };
          }),
        );

      const listChatMembers = (
        chatId: string,
      ): Effect.Effect<ReadonlyArray<string>, LarkGatewayError> =>
        Effect.gen(function* () {
          const openIds: string[] = [];
          let pageToken: string | undefined;
          let truncated = false;
          let page = 0;
          while (true) {
            if (page >= MAX_MEMBER_PAGES) {
              // Loop still had `has_more` when it hit the page cap → the member
              // list is incomplete. Surface it so a partial roster isn't taken
              // as the full membership (M-2 approval gates read this list).
              truncated = true;
              break;
            }
            const response = yield* sdkCall("list chat members", () =>
              rawChatMembers.im.chatMembers.get({
                path: { chat_id: chatId },
                params: {
                  member_id_type: "open_id",
                  page_size: MEMBER_PAGE_SIZE,
                  ...(pageToken !== undefined ? { page_token: pageToken } : {}),
                },
              }),
            );
            page += 1;
            const data = response.data;
            for (const item of data?.items ?? []) {
              if (item.member_id !== undefined) {
                openIds.push(item.member_id);
              }
            }
            if (data?.has_more !== true) {
              break;
            }
            pageToken = data.page_token;
            if (pageToken === undefined || pageToken.length === 0) {
              break;
            }
          }
          if (truncated) {
            yield* Effect.logWarning(
              `[feishu-bot] feishu chat directory: chat ${chatId} member list hit the ${
                MEMBER_PAGE_SIZE * MAX_MEMBER_PAGES
              }-member cap; membership may be incomplete.`,
            );
          }
          return openIds;
        });

      const addReaction = (messageId: string, emojiType: string) =>
        sdkCall("add reaction", () => channel.addReaction(messageId, emojiType));

      const removeReactionByEmoji = (messageId: string, emojiType: string) =>
        sdkCall("remove reaction", () => channel.removeReactionByEmoji(messageId, emojiType));

      const downloadImage = (messageId: string, fileKey: string) =>
        sdkCall("image download", () => channel.downloadResource(messageId, fileKey, "image"));

      return LarkGateway.of({
        connect,
        disconnect,
        startStreamingCard,
        addReaction,
        removeReactionByEmoji,
        downloadImage,
        updateCard,
        getUser,
        listChats,
        getChatInfo,
        listChatMembers,
      });
    }),
  );
