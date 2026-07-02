/**
 * Public surface of the Feishu access layer (`lark/`).
 *
 * Defines the {@link LarkGateway} service: the bridge's single, Effect-shaped
 * window onto `@larksuite/channel`. The concrete implementation (constructing
 * the channel, registering `on(...)` handlers, wrapping the Promise/callback
 * SDK in Effect) lands in `channel.ts` / `card.ts` and is wired into the
 * `LarkGateway.layer` — Modules/Integrate fill the bodies; this file is the
 * contract every other layer codes against.
 */
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";

import type { BridgeHandlers, SendOptions } from "./types.ts";

// Re-export the cross-layer types so callers can `import { ... } from "../lark"`.
export type {
  BridgeHandlers,
  CardActionEvent,
  InboundAttachment,
  InboundMessage,
  LarkChannelError,
  MentionInfo,
  NormalizedMessage,
  ResourceDescriptor,
  SendOptions,
} from "./types.ts";

/** Any error escaping the gateway boundary. M1 wraps SDK failures verbatim. */
export class LarkGatewayError extends Data.TaggedError("LarkGatewayError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

/**
 * A live streaming card: the handle the bridge updates as the agent's assistant
 * text grows. Backed by the SDK's `stream(chatId, { card })` producer, whose
 * {@link CardStreamController} drives in-place updates with internal sequencing
 * and throttling.
 */
export interface StreamingCard {
  /**
   * Replace the card's content with `card` (the full CardKit JSON object). The
   * SDK throttles and sequences these internally; callers just push the latest
   * rendered card each tick.
   */
  readonly update: (card: object) => Effect.Effect<void, LarkGatewayError>;
  /** Feishu message id of the card message (for reactions / correlation). */
  readonly messageId: string;
}

/**
 * Signals completion of a streaming card to the gateway. The gateway opens the
 * SDK `stream` producer and awaits this completion before resolving; the bridge
 * calls {@link StreamingCardCompletion.done} once the turn reaches a terminal
 * state so the producer (and the underlying stream call) can finish.
 *
 * `startStreamingCard` resolves with the {@link StreamingCard} handle as soon
 * as the card message exists (so the bridge can update it), independently of
 * when `done` fires.
 */
export interface StreamingCardCompletion {
  /** Resolve once the turn is terminal so the SDK producer can exit. */
  readonly done: Effect.Effect<void>;
}

/**
 * The Effect-shaped gateway over `@larksuite/channel`. One instance per
 * connected app; owns the WebSocket lifecycle and all outbound Feishu calls.
 */
export class LarkGateway extends Context.Service<
  LarkGateway,
  {
    /**
     * Open the WebSocket and start delivering events to `handlers`. Resolves only
     * after the first handshake succeeds (mirrors `channel.connect()`).
     */
    readonly connect: (handlers: BridgeHandlers) => Effect.Effect<void, LarkGatewayError>;
    /** Tear down the WebSocket. */
    readonly disconnect: Effect.Effect<void, LarkGatewayError>;
    /**
     * Begin a streaming card in `chatId`. Returns a {@link StreamingCard} handle
     * (resolved once the card message exists) for in-place updates; the gateway
     * keeps the underlying SDK `stream` producer alive until `completion.done`
     * fires. `initial` is the first card JSON to render.
     *
     * `sendOpts` (M3a) is forwarded to the SDK `stream(...)` call as its
     * {@link SendOptions}: a topic-group turn passes `{ replyInThread: true }`
     * (optionally with `replyTo` set to the triggering message id) so the card
     * posts inside the originating Feishu topic rather than the chat root.
     * Omitting it preserves the legacy p2p/group send behaviour unchanged.
     */
    readonly startStreamingCard: (
      chatId: string,
      initial: object,
      completion: StreamingCardCompletion,
      sendOpts?: SendOptions,
    ) => Effect.Effect<StreamingCard, LarkGatewayError>;
    /**
     * Add an emoji reaction to a message, returning the Feishu `reaction_id` (for
     * later removal). Used for the ⏳ "queued/processing" receipt.
     */
    readonly addReaction: (
      messageId: string,
      emojiType: string,
    ) => Effect.Effect<string, LarkGatewayError>;
    /**
     * Remove the bot's reaction matching `emojiType` from `messageId` without a
     * stored `reaction_id`. Resolves `true` when a matching reaction was removed.
     */
    readonly removeReactionByEmoji: (
      messageId: string,
      emojiType: string,
    ) => Effect.Effect<boolean, LarkGatewayError>;
    /**
     * Download an image resource carried by a received message. Pairs the owning
     * `messageId` with the resource `fileKey` (per Feishu's resource API).
     */
    readonly downloadImage: (
      messageId: string,
      fileKey: string,
    ) => Effect.Effect<Buffer, LarkGatewayError>;
    /**
     * Replace the full card content of an already-sent card message by its
     * Feishu `messageId` (the SDK's `channel.updateCard` — a whole-card update
     * targeting a message_id, distinct from the sequenced `updateCardById`
     * managed-card path). Used by the cardAction handler to echo an
     * interaction's outcome (✅ allowed / button expired / request stale) onto
     * the very card that was clicked (M2b-1).
     */
    readonly updateCard: (messageId: string, card: object) => Effect.Effect<void, LarkGatewayError>;
    /**
     * Resolve a Feishu user's display `name` from their `openId` via the SDK's
     * raw contact client (`rawClient.contact.user.get`, `user_id_type=open_id`).
     * Used by the cardAction echo to attribute an action to the operator's real
     * name when the cardAction event itself did not carry one (M2b-1, P3).
     *
     * Returns `{ name?: string }` — `name` is `undefined` when the API responds
     * without one. A *failure* (missing `contact:user.base:readonly` scope → 403,
     * network, etc.) surfaces as a {@link LarkGatewayError}; the caller is
     * expected to catch it and fall back to the raw openId, never blocking the
     * echo.
     */
    readonly getUser: (
      openId: string,
    ) => Effect.Effect<{ readonly name?: string }, LarkGatewayError>;
    /**
     * List the group chats this bot is a member of (`im.v1.chat.list`, paged
     * automatically by the SDK). Returns `{ chatId, name }` per chat. Excludes
     * p2p private chats and does not carry the topic flag — the per-chat mode is
     * resolved via {@link getChatInfo}. Requires the
     * `im:chat:readonly` tenant scope (M-0). Used by the chat-directory report
     * loop to enumerate the bot's groups.
     */
    readonly listChats: Effect.Effect<
      ReadonlyArray<{ readonly chatId: string; readonly name: string }>,
      LarkGatewayError
    >;
    /**
     * Fetch a chat's metadata via a single `im.v1.chat.get` (through the SDK's
     * `getChatInfo`). Returns the chat mode, the owner's open_id, and the member
     * count.
     *
     * NB: the SDK types the mode field as `chatType: "p2p" | "group"` but
     * populates it from the raw `chat_mode`, so a topic group surfaces as
     * `"topic"` at runtime; {@link chatMode} is therefore read as an opaque
     * string (known values: `"group"` / `"topic"` / `"p2p"`). One call yields
     * everything the directory records — no separate `getChatMode` needed.
     */
    readonly getChatInfo: (chatId: string) => Effect.Effect<
      {
        readonly name?: string;
        readonly chatMode: string;
        readonly ownerOpenId?: string;
        readonly memberCount?: number;
      },
      LarkGatewayError
    >;
    /**
     * List a chat's human member open_ids (`GET im/v1/chats/:chat_id/members`,
     * `member_id_type=open_id`), following `has_more`/`page_token` pagination.
     *
     * NB: Feishu never returns the bot's own membership here (expected — it does
     * not affect human-approval gating). Not wrapped by `@larksuite/channel`, so
     * this goes through the `rawClient` escape hatch (see {@link getUser}). Used
     * by the report loop to record group membership for the approval gates.
     */
    readonly listChatMembers: (
      chatId: string,
    ) => Effect.Effect<ReadonlyArray<string>, LarkGatewayError>;
  }
>()("@t3tools/feishu-bot/lark/LarkGateway") {}
