/**
 * Shared types internal to the bridge layer (`bridge/`).
 *
 * The bridge owns the lifecycle of a private-chat message: bind → derive
 * commandId → dispatch / queue → observe the thread → render → stream the card.
 * These types are the contracts between its modules (session, eventRenderer,
 * turnQueue, outbound, commandId, chatThreadMap).
 */
import type { CommandId, ThreadId } from "@t3tools/contracts";

import type { CardJson } from "../lark/card.ts";
import type { InboundMessage } from "../lark/types.ts";

// Re-export the lark-layer inbound message so bridge modules depend on
// `bridge/types` for the full set of bridge contracts (queue payloads,
// merge sources) without reaching across into `lark/types`.
export type { InboundMessage };

/**
 * Output of {@link bridge/eventRenderer.renderThreadCard}: the card JSON to
 * push, plus the degradation metadata the renderer computed while keeping every
 * element under Feishu's per-element size limit (~30KB). Pure data — no IO.
 */
export interface RenderResult {
  /** The CardKit 2.0 card JSON to send/update. */
  readonly card: CardJson;
  /**
   * Whether any element was degraded (tool output folded, reasoning truncated,
   * long output trimmed) to stay under the per-element byte ceiling.
   */
  readonly degraded: boolean;
  /** Largest single-element byte estimate after rendering (for diagnostics). */
  readonly maxElementBytes: number;
}

/** Options controlling how a thread is rendered into a card. */
export interface RenderOptions {
  /** Whether the turn is still streaming (drives `streaming_mode`). */
  readonly streaming: boolean;
  /**
   * Per-element byte ceiling before degradation kicks in. Defaults to the
   * Feishu limit (~30000) when omitted; exposed for testing.
   */
  readonly maxElementBytes?: number;
}

/**
 * Terminal outcome of an observed turn, derived from the session latch
 * (`status === "running"` seen, then `activeTurnId → null` = success; status in
 * {error, interrupted, stopped} = failure). Consumed by `turnQueue` to know
 * when to flush queued messages, and by the renderer for the final card.
 */
export type TurnOutcome =
  | { readonly kind: "succeeded" }
  | { readonly kind: "failed"; readonly status: string; readonly lastError: string | null };

/**
 * A message held while a turn is running. The bridge merges all queued items
 * for a chat into a single follow-up prompt once the active turn completes
 * (never forwards a second message verbatim — that would steer/overwrite the
 * running agent). See §6 of the M1 spec.
 */
export interface QueuedMessage {
  readonly message: InboundMessage;
  /** Stable commandId derived for this message at enqueue time. */
  readonly commandId: CommandId;
}

/**
 * Resolution of {@link bridge/chatThreadMap.ensureThreadForChat}: the thread
 * bound to a chat, and whether it was just created (first message) versus
 * re-used from a prior binding.
 */
export interface EnsuredThread {
  readonly threadId: ThreadId;
  readonly created: boolean;
}
