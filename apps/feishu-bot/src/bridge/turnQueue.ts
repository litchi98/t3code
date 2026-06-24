/**
 * Per-chat merge queue (H3 / M17).
 *
 * Implements the spec's queueing semantics (§6):
 *  - **Running**: while a chat's turn is running, newly-arrived messages are
 *    *held*, not forwarded — forwarding a second message verbatim would
 *    steer/overwrite the running agent. When the turn completes, all held
 *    messages are merged into a single follow-up prompt and dispatched.
 *  - **Idle**: a short (~600ms) window coalesces rapid-fire messages into one
 *    prompt before the first dispatch.
 *
 * State lives in a single `Ref<Map<chatId, ChatState>>`; `Ref.modify` makes each
 * transition atomic (Effect's cooperative scheduling means no interleaving
 * mid-`modify`). The idle window is a per-chat generation-counter debounce: each
 * `offer` bumps the generation, sleeps the window, then drains only if it is
 * still the latest offer — so N rapid messages produce exactly one dispatch.
 */
import type { CommandId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { deriveCommandId } from "./commandId.ts";
import type { InboundMessage, QueuedMessage } from "./types.ts";

/** Idle-coalescing window before the first dispatch in a quiet chat. */
export const IDLE_MERGE_WINDOW_MS = 600;

/**
 * Opaque per-turn ownership token (H3 accounting).
 *
 * Every executing turn mints a fresh token via {@link TurnQueue.beginTurn} at the
 * start of its per-chat critical section, and that exact token is required to
 * settle the turn via {@link TurnQueue.onTurnComplete}. The token is the *sole*
 * source of truth for "who owns the chat's running slot": a completion whose
 * token does not match the chat's current owner is a no-op. This is what keeps a
 * replayed/flushed turn (which is dispatched off the outbound queue, bypassing
 * `offer`) from ever clearing — or draining the held messages of — a concurrent
 * *live* turn it never owned (the M1 reconnect-flush accounting regression).
 *
 * A branded number (monotonic counter); never compared structurally across
 * chats, only for equality against the same chat's stored owner.
 */
export type TurnToken = number & { readonly __turnToken: unique symbol };

/**
 * A merged dispatch ready to send: the combined prompt text plus the stable
 * commandId to dispatch it under (derived from the triggering message; see
 * `commandId.ts`). The bridge turns this into a `ThreadTurnStart`.
 */
export interface MergedDispatch {
  /** Combined prompt assembled from the held/coalesced messages. */
  readonly prompt: string;
  /** Stable commandId for the merged dispatch. */
  readonly commandId: CommandId;
  /** The source messages folded into this dispatch (for receipts/diagnostics). */
  readonly sources: ReadonlyArray<QueuedMessage>;
}

/** Per-chat queue state. */
interface ChatState {
  /**
   * True once the chat's running slot is claimed and not yet settled. Set by the
   * idle-window drain in `offer` (a *live* turn claims the slot before any peer
   * can be dispatched) and by `beginTurn` (a flushed/replay turn, which never
   * passed through `offer`, claims it at its critical-section start). New
   * messages while `running` are *held*, never forwarded (would steer the agent).
   */
  readonly running: boolean;
  /**
   * Token of the turn that currently *owns* the running slot, or `null` when the
   * slot is claimed (`running`) but not yet owned (the brief window between
   * `offer` claiming it and the dispatched `runTurn` calling `beginTurn`). Only
   * the owner's `onTurnComplete` may settle the slot; any other completion (e.g. a
   * flushed turn that never owned this slot) is a no-op. The single guard behind
   * the 1:1 "exactly the turn that claimed running settles it" invariant.
   */
  readonly turnToken: TurnToken | null;
  /** Messages held during the running turn (drained on `onTurnComplete`). */
  readonly held: ReadonlyArray<InboundMessage>;
  /** Messages coalescing in the current idle window. */
  readonly pending: ReadonlyArray<InboundMessage>;
  /** Latest idle-window generation; only the matching `offer` fiber dispatches. */
  readonly generation: number;
  /** Monotonic source for fresh {@link TurnToken}s (per chat; never reused). */
  readonly nextToken: number;
}

const EMPTY_STATE: ChatState = {
  running: false,
  turnToken: null,
  held: [],
  pending: [],
  generation: 0,
  nextToken: 1,
};

/**
 * Result of the atomic `offer` decision: either the message was *held* (a turn
 * is running), or it joined the idle window as generation `generation` (only the
 * offer still owning that generation after the window dispatches). Named so both
 * `Ref.modify` branches unify into one discriminated union rather than `unknown`.
 */
type OfferDecision =
  | { readonly held: true }
  | { readonly held: false; readonly generation: number };

/**
 * Per-chat queue coordinator. One logical queue per `chatId`; the
 * implementation fans out internally over a shared state map. The `threadIdFor`
 * thunk lets the queue derive a stable commandId for the merged dispatch (the
 * commandId triple includes the bound threadId — resolved by the bridge).
 */
export class TurnQueue extends Context.Service<
  TurnQueue,
  {
    /**
     * Offer an inbound message to `chatId`'s queue. Resolves with a
     * {@link MergedDispatch} when this message should trigger a dispatch now
     * (idle path, after the coalescing window), or `null` when it was held
     * because a turn is running (it will surface later via {@link onTurnComplete}).
     */
    readonly offer: (
      chatId: string,
      message: InboundMessage,
    ) => Effect.Effect<MergedDispatch | null>;
    /**
     * Take ownership of `chatId`'s running slot for the turn that is about to
     * execute, minting a fresh {@link TurnToken}. Idempotently sets `running`
     * (a live turn already had it set by `offer`; a flushed/replay turn — which
     * bypassed `offer` — has it set here), so that while *this* turn runs new
     * messages are held rather than steering it. The returned token must be
     * handed back to {@link onTurnComplete} to settle the turn.
     *
     * Called by the bridge at the *start of the per-chat critical section*, so
     * exactly one turn per chat ever owns the slot at a time, and ownership is
     * established before the dispatch.
     */
    readonly beginTurn: (chatId: string) => Effect.Effect<TurnToken>;
    /**
     * Settle the turn identified by `token`. Resolves with the merged dispatch of
     * everything held during the turn (the chat stays running for that follow-up),
     * or `null` if nothing was held (the chat returns to idle) — **or** if `token`
     * does not own the chat's current running slot, in which case this is a no-op
     * (a flushed/replay turn must never settle a slot it never owned). Must be run
     * *inside* the per-chat critical section, before it is released, so the next
     * turn cannot begin before this one's running/held accounting is committed.
     */
    readonly onTurnComplete: (
      chatId: string,
      token: TurnToken,
    ) => Effect.Effect<MergedDispatch | null>;
  }
>()("@t3tools/feishu-bot/bridge/turnQueue") {}

/**
 * Merge a batch of messages into one prompt + a stable commandId.
 *
 * The combined prompt joins each message's text with a blank line; the stable
 * commandId is derived from the *first* message's id (the trigger), so a
 * re-delivered batch maps to the same id. The thread id is resolved by the
 * bridge via `threadIdFor(chatId)` so the commandId triple stays complete.
 */
const mergeMessages = (
  chatId: string,
  threadId: ThreadId,
  messages: ReadonlyArray<InboundMessage>,
): MergedDispatch => {
  const prompt = messages
    .map((m) => m.text.trim())
    .filter((t) => t.length > 0)
    .join("\n\n");
  // Trigger = first message; its id keys the stable commandId for the batch.
  const trigger = messages[0];
  const triggerMessageId = trigger?.messageId ?? `${chatId}-empty`;
  const commandId = deriveCommandId(chatId, threadId, triggerMessageId);
  const sources: ReadonlyArray<QueuedMessage> = messages.map((message) => ({
    message,
    commandId: deriveCommandId(chatId, threadId, message.messageId),
  }));
  return { prompt, commandId, sources };
};

/**
 * Build the {@link TurnQueue} layer.
 *
 * @param threadIdFor Resolve the bound threadId for a chat (the commandId triple
 *   needs it). Integrate binds this to a `ChatThreadMapStore.get`-backed lookup;
 *   the chat is always bound by the time the queue dispatches (the bridge
 *   ensures the thread before offering). The lookup's own requirements `RIn`
 *   (e.g. the store) become the layer's requirements and are captured once at
 *   build time, so the service methods stay total.
 */
export const turnQueueLayer = <RIn>(
  threadIdFor: (chatId: string) => Effect.Effect<ThreadId, never, RIn>,
): Layer.Layer<TurnQueue, never, RIn> =>
  Layer.effect(
    TurnQueue,
    Effect.gen(function* () {
      const states = yield* Ref.make<ReadonlyMap<string, ChatState>>(new Map());
      // Capture the lookup's environment once so each `threadIdFor` call inside
      // the service methods is a total effect (service methods carry no `R`).
      const context = yield* Effect.context<RIn>();
      const resolveThreadId = (chatId: string): Effect.Effect<ThreadId> =>
        threadIdFor(chatId).pipe(Effect.provide(context));

      const offer = (chatId: string, message: InboundMessage) =>
        Effect.gen(function* () {
          // Atomic decision: hold if running, else join the idle window and
          // become its newest generation.
          const decision = yield* Ref.modify(
            states,
            (map): readonly [OfferDecision, ReadonlyMap<string, ChatState>] => {
              const current = map.get(chatId) ?? EMPTY_STATE;
              if (current.running) {
                const next: ChatState = { ...current, held: [...current.held, message] };
                return [{ held: true }, new Map(map).set(chatId, next)];
              }
              const generation = current.generation + 1;
              const next: ChatState = {
                ...current,
                pending: [...current.pending, message],
                generation,
              };
              return [{ held: false, generation }, new Map(map).set(chatId, next)];
            },
          );

          if (decision.held) {
            return null;
          }

          // Idle coalescing window. Only the offer that is still the latest
          // generation after the window drains + dispatches; earlier offers in
          // the same window were folded into `pending` and resolve to `null`.
          yield* Effect.sleep(Duration.millis(IDLE_MERGE_WINDOW_MS));

          const dispatch = yield* Ref.modify(
            states,
            (
              map,
            ): readonly [ReadonlyArray<InboundMessage> | null, ReadonlyMap<string, ChatState>] => {
              const current = map.get(chatId) ?? EMPTY_STATE;
              if (current.generation !== decision.generation) {
                // A newer offer owns this window; that fiber yields the dispatch
                // and our message already rides in its `pending`. Yield nothing.
                return [null, map];
              }
              if (current.running) {
                // A turn claimed the running slot during our window (a flushed/
                // replay turn's `beginTurn`, or a chain follow-up). We must NOT
                // strand the coalesced `pending` in limbo — they would never be
                // dispatched (the completion path drains `held`, not `pending`).
                // Migrate them into `held` so the in-flight turn picks them up on
                // its `onTurnComplete`, then yield nothing (no concurrent live
                // dispatch — that would steer the running agent). This is the
                // dropped-message regression: `pending` orphaned when the slot is
                // lost mid-window.
                if (current.pending.length === 0) {
                  return [null, map];
                }
                const next: ChatState = {
                  ...current,
                  pending: [],
                  held: [...current.held, ...current.pending],
                };
                return [null, new Map(map).set(chatId, next)];
              }
              // Claim the running slot for the live turn we are about to
              // dispatch (so concurrent peers held by `offer` see `running` and do
              // not steer it). Ownership (`turnToken`) is minted later by
              // `beginTurn`, inside the dispatching turn's critical section.
              const batch = current.pending;
              const next: ChatState = { ...current, pending: [], running: true };
              return [batch, new Map(map).set(chatId, next)];
            },
          );

          if (dispatch === null || dispatch.length === 0) {
            return null;
          }
          const threadId = yield* resolveThreadId(chatId);
          return mergeMessages(chatId, threadId, dispatch);
        });

      // Mint a fresh ownership token for the turn about to run and (idempotently)
      // mark the slot running. A live turn already had `running` set by `offer`'s
      // idle drain; a flushed/replay turn — which never went through `offer` —
      // gets it set here, so messages arriving while it runs are held, not steered.
      //
      // Any messages still coalescing in `pending` at claim time are folded into
      // `held`: a flushed/replay turn (or a chain follow-up) bypasses `offer`'s
      // idle drain, so without this their `pending` would be orphaned — the
      // completion path drains `held`, never `pending` — and silently lost. The
      // idle-drain *winner* already cleared `pending` before its own `beginTurn`,
      // so this never double-counts a dispatched batch. Each message leaves
      // `pending` exactly once (drain-win, drain-lost migrate, or here).
      const beginTurn = (chatId: string): Effect.Effect<TurnToken> =>
        Ref.modify(states, (map): readonly [TurnToken, ReadonlyMap<string, ChatState>] => {
          const current = map.get(chatId) ?? EMPTY_STATE;
          const token = current.nextToken as TurnToken;
          const next: ChatState = {
            ...current,
            running: true,
            turnToken: token,
            nextToken: current.nextToken + 1,
            held:
              current.pending.length === 0 ? current.held : [...current.held, ...current.pending],
            pending: [],
          };
          return [token, new Map(map).set(chatId, next)];
        });

      const onTurnComplete = (chatId: string, token: TurnToken) =>
        Effect.gen(function* () {
          const drained = yield* Ref.modify(
            states,
            (
              map,
            ): readonly [ReadonlyArray<InboundMessage> | null, ReadonlyMap<string, ChatState>] => {
              const current = map.get(chatId) ?? EMPTY_STATE;
              // Ownership guard: only the turn that owns the slot may settle it.
              // A flushed/replay turn whose token does not match (or any stale
              // completion after a newer turn already took over) is a no-op — it
              // must never clear `running` or drain `held` it never owned.
              if (current.turnToken !== token) {
                return [null, map];
              }
              const held = current.held;
              if (held.length === 0) {
                // Nothing queued → release the slot, back to idle.
                const next: ChatState = { ...current, running: false, turnToken: null, held: [] };
                return [null, new Map(map).set(chatId, next)];
              }
              // Merge held into the next turn. Release ownership but keep `running`
              // claimed for the follow-up: the held `runTurn` re-acquires the chat
              // lock and `beginTurn`s afresh (minting its own token) — so no second
              // turn can slip in and steer between settle and the follow-up.
              const next: ChatState = { ...current, held: [], turnToken: null, running: true };
              return [held, new Map(map).set(chatId, next)];
            },
          );

          if (drained === null || drained.length === 0) {
            return null;
          }
          const threadId = yield* resolveThreadId(chatId);
          return mergeMessages(chatId, threadId, drained);
        });

      return TurnQueue.of({ offer, beginTurn, onTurnComplete });
    }),
  );
