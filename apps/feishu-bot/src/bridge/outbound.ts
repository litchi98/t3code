/**
 * Outbound compensation queue (M8).
 *
 * When the server is offline/unconnected at dispatch time, the bridge must not
 * drop the user's message: it records the dispatch *intent* in an in-memory
 * queue and adds a ⏳ reaction to the originating Feishu message as a "received,
 * will process" receipt. Once the environment reconnects, the queue is flushed
 * in order — each intent dispatched serially — and the ⏳ reaction is cleared on
 * success. `client-runtime` does no buffering; this is the bridge's job.
 *
 * Idempotency: each intent carries a stable `commandId`. On flush we skip any
 * commandId already recorded in {@link SentCommandStore} (a crash between
 * dispatch and reaction-clear must not double-send), and record it on success.
 *
 * Durability: a flush only *removes* an intent once its dispatch is confirmed
 * (recorded in `SentCommandStore` and the ⏳ cleared). An intent whose dispatch
 * fails/defects is re-queued at the end of the flush — and its ⏳ receipt left in
 * place — so a transient error (e.g. the environment dropping again mid-flush)
 * never silently loses the user's message; the next flush retries it.
 */
import type { CommandId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";

import { LarkGateway } from "../lark/index.ts";
import { SentCommandStore } from "../runtime/persistence.ts";

/** Emoji key used for the "queued/processing" receipt reaction (⏳). */
export const PROCESSING_EMOJI = "Typing";

/**
 * A pending dispatch awaiting a live environment. `run` performs the actual
 * dispatch (e.g. `ThreadTurnStart`) when flushed; it is kept as a thunk so the
 * queue is agnostic to the operation. `commandId` keys idempotency, and
 * `feishuMessageId` identifies the message carrying the ⏳ receipt.
 *
 * `run`'s error channel is `unknown`: a flush that finds the environment *still*
 * offline must be able to signal "not done — retry me" by **failing** (the queue
 * then keeps the intent + its ⏳ and retries on a later flush) rather than
 * succeeding (which would record it as sent and clear the ⏳). Most intents are
 * total; a failing one is the explicit "still offline" retry signal.
 */
export interface OutboundIntent {
  readonly commandId: CommandId;
  /** Feishu message id that should carry / clear the ⏳ reaction. */
  readonly feishuMessageId: string;
  /**
   * The dispatch to run on flush (already environment-bound). Succeeds when the
   * dispatch went through; **fails** when the environment is still offline, which
   * the queue treats as "retry on the next flush" (keeps the intent + ⏳).
   */
  readonly run: Effect.Effect<void, unknown>;
}

/**
 * Outbound compensation coordinator. Holds intents while disconnected and
 * flushes them serially once connected.
 */
export class OutboundQueue extends Context.Service<
  OutboundQueue,
  {
    /**
     * Enqueue an intent and add the ⏳ receipt to its originating message.
     * Resolves once the intent is durably queued (not when it is dispatched).
     */
    readonly enqueue: (intent: OutboundIntent) => Effect.Effect<void>;
    /**
     * Flush all queued intents serially: dispatch each, then clear its ⏳ receipt.
     * Called on `connected`. Idempotent — already-dispatched commandIds are
     * skipped via {@link SentCommandStore}.
     */
    readonly flush: Effect.Effect<void>;
  }
>()("@t3tools/feishu-bot/bridge/outbound/OutboundQueue") {}

/**
 * Build the {@link OutboundQueue} layer.
 *
 * Backed by an unbounded in-memory {@link Queue} of intents. `enqueue` adds the
 * ⏳ reaction (best-effort — a failed reaction must not lose the intent) then
 * buffers; `flush` drains everything currently buffered and dispatches serially.
 * Reaction/dispatch failures are logged and swallowed so a single bad intent
 * cannot wedge the flush loop.
 */
export const outboundQueueLayer: Layer.Layer<OutboundQueue, never, LarkGateway | SentCommandStore> =
  Layer.effect(
    OutboundQueue,
    Effect.gen(function* () {
      const gateway = yield* LarkGateway;
      const sent = yield* SentCommandStore;
      const queue = yield* Queue.unbounded<OutboundIntent>();

      const enqueue = (intent: OutboundIntent) =>
        Effect.gen(function* () {
          // Best-effort receipt: never let a reaction failure drop the intent.
          yield* gateway.addReaction(intent.feishuMessageId, PROCESSING_EMOJI).pipe(Effect.ignore);
          yield* Queue.offer(queue, intent);
        });

      /**
       * Attempt one intent. Returns `true` when the intent reached a terminal,
       * "do not retry" state (dispatched-and-recorded, or already-sent), and
       * `false` when it must be retried on a later flush (dispatch failed/
       * defected). The caller re-queues every `false` so nothing is dropped and
       * the ⏳ receipt is kept until the dispatch is confirmed.
       */
      const dispatchOne = (intent: OutboundIntent): Effect.Effect<boolean> =>
        Effect.gen(function* () {
          // Local dedup ahead of the server's commandReceipt store. A failed
          // `has` read is treated as "not sent" (conservative: re-dispatch is
          // idempotent under the stable commandId, so a false negative is safe).
          const already = yield* sent.has(intent.commandId).pipe(Effect.orElseSucceed(() => false));
          if (already) {
            yield* gateway
              .removeReactionByEmoji(intent.feishuMessageId, PROCESSING_EMOJI)
              .pipe(Effect.ignore);
            return true;
          }
          // Run the dispatch, capturing success/failure/defect as an Exit so a
          // single bad intent can never wedge the serial flush loop.
          const exit = yield* Effect.exit(intent.run);
          if (exit._tag === "Failure") {
            yield* Effect.logWarning("[feishu-bot] outbound dispatch failed", exit.cause);
            // Not recorded and ⏳ left in place: signal a retry so the caller
            // re-queues this intent for the next flush.
            return false;
          }
          yield* sent.add(intent.commandId).pipe(Effect.ignore);
          yield* gateway
            .removeReactionByEmoji(intent.feishuMessageId, PROCESSING_EMOJI)
            .pipe(Effect.ignore);
          return true;
        });

      const flush = Effect.gen(function* () {
        // `clear` drains exactly what is currently buffered, non-blocking, so a
        // flush triggered by reconnect terminates even when the queue is empty.
        // Draining up front (rather than re-reading the live queue) also bounds
        // the loop: intents that fail and are re-queued below are only retried on
        // the *next* flush, never spun on within this one.
        const pending = yield* Queue.clear(queue);
        // Collect intents that must be retried and re-offer them in one batch at
        // the end, preserving their relative order, so a transient dispatch
        // failure never permanently drops the user's message (the ⏳ stays too).
        const carryOver: Array<OutboundIntent> = [];
        yield* Effect.forEach(
          pending,
          (intent) =>
            dispatchOne(intent).pipe(
              Effect.tap((ok) => (ok ? Effect.void : Effect.sync(() => carryOver.push(intent)))),
            ),
          { discard: true },
        );
        if (carryOver.length > 0) {
          yield* Effect.forEach(carryOver, (intent) => Queue.offer(queue, intent), {
            discard: true,
          });
        }
      });

      return OutboundQueue.of({ enqueue, flush });
    }),
  );
