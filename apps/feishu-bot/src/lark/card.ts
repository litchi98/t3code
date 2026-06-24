/**
 * CardKit 2.0 type boundary plus the streaming-card producer plumbing the
 * {@link LarkGateway} drives.
 *
 * Two concerns live here:
 *  - The card JSON type aliases ({@link CardJson} / {@link CardElement}). The SDK
 *    treats card JSON as an opaque `object`, so these are hand-built by
 *    `eventRenderer.ts` from the reducer state; the aliases just name that
 *    boundary.
 *  - The SDK `stream(chatId, { card: { initial, producer } })` producer wiring
 *    (this file owns the Promise/callback shape; `channel.ts` wraps it in
 *    Effect). The producer hands its {@link CardStreamController} back to the
 *    gateway the instant the card message exists, then parks until the turn is
 *    terminal so the SDK keeps the card open for in-place updates.
 */
import type { CardStreamController, StreamInput } from "./types.ts";

/** Opaque CardKit 2.0 card JSON. Kept as `object` to match the SDK boundary. */
export type CardJson = object;

/** A single CardKit 2.0 element (markdown block, collapsible, divider, …). */
export type CardElement = object;

/**
 * Build the `StreamInput` for an SDK streaming card.
 *
 * The returned `producer` is what `@larksuite/channel`'s
 * `stream(chatId, { card })` calls: the SDK invokes it once with a live
 * {@link CardStreamController}, and keeps the card open (accepting `ctrl.update`
 * pushes) until the producer's promise settles. We therefore:
 *
 *  1. call `onController(ctrl)` the moment the card message exists — this is how
 *     the gateway gets the handle (`ctrl.messageId`, `ctrl.update`) back to the
 *     caller of `startStreamingCard`, without waiting for the turn to finish;
 *  2. `await donePromise` — the turn-terminal signal the bridge resolves — so
 *     the producer stays parked (and the card stays live) for the whole turn.
 *
 * `donePromise` is expected to never reject (it is the bridge's
 * `completion.done` effect run to a Promise); a defensive `.catch` in the
 * gateway guards the `stream` call regardless. The card content itself is pushed
 * out-of-band via the controller handed to `onController`, never from here.
 */
export const streamingCardInput = (
  initial: CardJson,
  onController: (controller: CardStreamController) => void,
  donePromise: Promise<void>,
): StreamInput => ({
  card: {
    initial,
    producer: async (controller: CardStreamController) => {
      onController(controller);
      await donePromise;
    },
  },
});
