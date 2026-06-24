/**
 * `@larksuite/channel` wiring for {@link LarkGateway} (M1).
 *
 * Constructs the `LarkChannel` from {@link FeishuAppConfig}, registers the SDK
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

import type { FeishuAppConfig } from "../config.ts";
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
 * Single admission point for inbound chat types (M3 group-chat seam).
 *
 * M2a only drives 1:1 private chats, so this admits `"p2p"` and nothing else.
 * The M3 group-chat work flips the gate here (e.g. also admit `"group"`) without
 * touching the handler wiring — the `message` callback routes solely on this.
 */
const acceptChatType = (chatType: string): boolean => chatType === "p2p";

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

  return {
    chatId: message.chatId,
    chatType: message.chatType,
    messageId: message.messageId,
    senderId: message.senderId,
    text: message.content,
    attachments,
    createTime: message.createTime,
    ...(message.senderName !== undefined ? { senderName: message.senderName } : {}),
  };
};

/**
 * Build the {@link LarkGateway} layer for the given Feishu app credentials.
 *
 * The channel is constructed eagerly (cheap, synchronous — no network), and a
 * scope finalizer best-effort disconnects it so the WebSocket is torn down when
 * the layer is released. `connect` registers the handlers and opens the socket;
 * the outbound methods wrap the SDK's Promise surface.
 */
export const larkGatewayLayer = (config: FeishuAppConfig): Layer.Layer<LarkGateway> =>
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
          // them directly. Only `p2p` messages reach the bridge in M1; group /
          // topic messages are ignored.
          yield* Effect.sync(() =>
            channel.on({
              message: (message) => {
                // Single admission point (M3 seam): M2a still admits only p2p.
                if (!acceptChatType(message.chatType)) {
                  return;
                }
                handlers.onInboundMessage(normalizeInbound(message));
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
          // go (the turn is over) and are swallowed.
          void channel.stream(chatId, input).catch((cause: unknown) => rejectController(cause));

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
      });
    }),
  );
