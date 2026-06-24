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

import type { BridgeHandlers } from "./types.ts";

// Re-export the cross-layer types so callers can `import { ... } from "../lark"`.
export type {
  BridgeHandlers,
  InboundAttachment,
  InboundMessage,
  LarkChannelError,
  NormalizedMessage,
  ResourceDescriptor,
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
     */
    readonly startStreamingCard: (
      chatId: string,
      initial: object,
      completion: StreamingCardCompletion,
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
  }
>()("@t3tools/feishu-bot/lark/LarkGateway") {}
