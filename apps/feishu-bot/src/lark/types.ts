/**
 * Cross-layer types for the Feishu access layer (`lark/`).
 *
 * This module owns the contract between the raw `@larksuite/channel` SDK and
 * the bridge: it re-exports the SDK types the rest of the app needs, defines
 * the normalised {@link InboundMessage} the bridge consumes, and the
 * {@link BridgeHandlers} the lark layer calls back into.
 *
 * Keep this layer thin: the bridge must never import `@larksuite/channel`
 * directly — it only sees the shapes declared here.
 */
import type {
  CardActionEvent,
  CardStreamController,
  LarkChannelError,
  NormalizedMessage,
  ResourceDescriptor,
  StreamInput,
} from "@larksuite/channel";

// Re-export the SDK types other layers legitimately need to name, so that the
// bridge depends on `lark/types` rather than reaching into `@larksuite/channel`.
export type {
  CardActionEvent,
  CardStreamController,
  LarkChannelError,
  NormalizedMessage,
  ResourceDescriptor,
  StreamInput,
};

/**
 * A message resource the bot is willing to act on. M1 only surfaces images;
 * other resource kinds are dropped at normalisation time (the bridge replies
 * with an explicit "text/image only" notice — see the M16 plan). The shape is a
 * narrowed projection of the SDK's {@link ResourceDescriptor}, carrying just
 * what `LarkGateway.downloadImage` needs plus display metadata.
 */
export interface InboundAttachment {
  /** Resource kind. M1 normalisation only ever emits `"image"`. */
  readonly kind: "image";
  /** Feishu resource key, paired with the owning `messageId` to download. */
  readonly fileKey: string;
  /** Original file name, when Feishu provided one. */
  readonly fileName?: string;
}

/**
 * Bridge-facing, normalised inbound private-chat message.
 *
 * Produced by the lark layer from a {@link NormalizedMessage} (only
 * `chatType === "p2p"` messages reach the bridge in M1). This is intentionally
 * smaller than `NormalizedMessage`: the bridge needs only identity, text, and
 * image attachments — everything else (mentions, raw event, threadId, …) stays
 * inside the lark layer.
 */
export interface InboundMessage {
  /** Feishu chat id; the stable key for the chat↔thread binding. */
  readonly chatId: string;
  /**
   * Feishu chat type (`"p2p"` private chat, `"group"`, `"topic"`, …). Passed
   * through from the SDK so the M3 group-chat seam can route on it; M2a still
   * only admits `p2p` (the gate is {@link lark/channel.acceptChatType}).
   */
  readonly chatType: string;
  /** Feishu message id; pairs with `fileKey` to download resources, and feeds
   *  the stable commandId derivation. */
  readonly messageId: string;
  /** Sender's Feishu open id. */
  readonly senderId: string;
  /** Sender display name, when resolvable. */
  readonly senderName?: string;
  /** Normalised plain-text / markdown body (empty string for media-only). */
  readonly text: string;
  /** Image attachments the bot may download; empty when none. */
  readonly attachments: ReadonlyArray<InboundAttachment>;
  /** Feishu event creation time, epoch milliseconds. Informational only —
   *  never used to set the t3code command `createdAt` (see M19). */
  readonly createTime: number;
}

/**
 * Callbacks the lark layer invokes on the bridge. The lark layer is the
 * Promise/callback-driven SDK edge; the bridge implements these as Effects run
 * on its own runtime. All handlers must be non-throwing from the SDK's point of
 * view — the lark layer adapts them onto the bridge runtime.
 */
export interface BridgeHandlers {
  /** A new normalised private-chat message arrived. */
  readonly onInboundMessage: (message: InboundMessage) => void;
  /**
   * A card interaction (button click / form submit) fired. Unlike
   * {@link onInboundMessage} this is *not* gated on chat type — interaction
   * cards live only in the private chats the bridge already drives, so the SDK
   * delivers every `cardAction` straight through (M2b-1). The evt carries the
   * card `messageId`, originating `chatId`, the `operator`, and the signed
   * `action` payload the bridge verifies.
   */
  readonly onCardAction: (evt: CardActionEvent) => void;
  /** The underlying WebSocket dropped and is being re-established. */
  readonly onReconnecting: () => void;
  /** The WebSocket reconnected (inbound replay is not available — M7). */
  readonly onReconnected: () => void;
  /** A channel-level error surfaced from the SDK. */
  readonly onError: (error: LarkChannelError) => void;
}
