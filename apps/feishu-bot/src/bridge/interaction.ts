/**
 * Interaction-section construction extracted from bot.ts.
 *
 * Keeps callback signing and the assembly-owned interaction overlays explicit.
 */
import {
  derivePendingApprovals,
  derivePendingUserInputs,
  isStalePendingRequestFailureDetail,
} from "@t3tools/client-runtime/state/thread-activity";
import type { OrchestrationThread, OrchestrationThreadActivity } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import type { CallbackAuth } from "./callbackAuth.ts";
import { splitChatKey } from "./chatThreadMap.ts";
import {
  type InteractionContext,
  renderInteractionSection,
  type ResolvedNoticeEntry,
} from "./interactionCard.ts";

/**
 * The set of request ids whose pending approval/user-input was force-resolved by
 * a *stale/unknown* provider respond failure (M11). Scans the activity log for
 * `provider.{approval,user-input}.respond.failed` activities whose detail matches
 * {@link isStalePendingRequestFailureDetail}, surfacing their `requestId` so the
 * interaction renderer greys those controls out ("请求已失效") instead of leaving
 * a dead button. Pure; mirrors the same failed-kind detection the shared derive
 * helpers and the web/mobile clients use.
 */
export const staleRequestIdsOf = (
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlySet<string> => {
  const stale = new Set<string>();
  for (const activity of activities) {
    if (
      activity.kind !== "provider.approval.respond.failed" &&
      activity.kind !== "provider.user-input.respond.failed"
    ) {
      continue;
    }
    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : null;
    const requestId = typeof payload?.requestId === "string" ? payload.requestId : null;
    const detail = payload && typeof payload.detail === "string" ? payload.detail : undefined;
    if (requestId && isStalePendingRequestFailureDetail(detail)) {
      stale.add(requestId);
    }
  }
  return stale;
};

/** TTL for a callback button token: 24h (the card outlives a single turn). */
export const CALLBACK_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/** Dependencies for constructing interaction sections. */
export interface InteractionBuilderDeps {
  /** Per-binding CallbackAuth instance. */
  readonly auth: CallbackAuth;
  /** Assembly-owned shared operator Ref. */
  readonly chatOperators: Ref.Ref<ReadonlyMap<string, string>>;
  /** Assembly-owned shared resolved-notices Ref. */
  readonly chatResolvedNotices: Ref.Ref<
    ReadonlyMap<string, ReadonlyMap<string, ResolvedNoticeEntry>>
  >;
}

/** Construct the interaction-section builder for one bound Feishu session. */
export const makeInteractionBuilder = (deps: InteractionBuilderDeps) => {
  const { auth, chatOperators, chatResolvedNotices } = deps;

  /**
   * Build the interaction section (approval buttons / user-input form / stale
   * notices) for one folded thread state, signed for `chatId`'s current
   * operator. Pure derivation from `thread.activities`:
   *  - `derivePendingApprovals` / `derivePendingUserInputs` open the live
   *    pending requests (shared client-runtime logic, the same web/mobile use);
   *  - `staleRequestIdsOf` greys out any request a stale/unknown respond failure
   *    already force-resolved (M11);
   *  - each button is HMAC-signed via `auth.sign` bound to
   *    `(chatId, threadId, runtimeMode, operator, action)` (the policy
   *    fingerprint), with `runtimeMode = thread.runtimeMode` (E②: the render
   *    side uses the thread's own runtimeMode).
   * Returns the `RenderOptions.interaction` value (or `undefined` when there is
   * nothing pending — so the renderer adds no empty section).
   */
  const buildInteraction = (
    // M3a: the composite `chatId[:larkThreadId]` conversation key. State lookups
    // (resolved overlay / operator) read it verbatim; the *token* it signs must
    // carry the REAL Feishu `chatId` (the verify side reads `evt.chatId`) plus
    // the topic id (`InteractionContext.larkThreadId`) so the cardAction handler
    // can recover the topic — both are recovered via `splitChatKey` below.
    chatKey: string,
    thread: OrchestrationThread,
    // #0/#1(b): optional operator override. The live `driveTurn` path omits it
    // and resolves the operator from the in-process `chatOperators` Ref. M18
    // restart recovery passes the operator captured on the persisted card handle
    // (`handle.operatorOpenId`) because the Ref is empty right after a restart —
    // re-signing with an empty open id would never match at verify time and would
    // dead-end the recovered button. A non-empty override wins; otherwise we fall
    // back to the Ref (preserving the existing live behaviour exactly).
    operatorOverride?: string,
  ): Effect.Effect<{ readonly elements: ReadonlyArray<object> } | undefined> =>
    Effect.gen(function* () {
      const pendingApprovals = derivePendingApprovals(thread.activities);
      const pendingUserInputs = derivePendingUserInputs(thread.activities);
      // P2: read the resolved overlay BEFORE the early-return so a turn with no
      // live pending requests but one resolved this session still renders the
      // greyed-out echo ("✅ 已由 @… 允许") — during the turn AND after it completes
      // (when pending is empty). The streaming render has no operator knowledge, so
      // the overlay is the only carrier of the echo. Empty overlay → live state.
      const resolvedNotice =
        (yield* Ref.get(chatResolvedNotices)).get(chatKey) ??
        new Map<string, ResolvedNoticeEntry>();
      if (
        pendingApprovals.length === 0 &&
        pendingUserInputs.length === 0 &&
        resolvedNotice.size === 0
      ) {
        return undefined;
      }
      const operators = yield* Ref.get(chatOperators);
      const rawInitiator =
        operatorOverride !== undefined && operatorOverride.length > 0
          ? operatorOverride
          : (operators.get(chatKey) ?? "");
      // M-2/PR2b: the token's signed `payload.o` is the true turn initiator
      // (initiator-only). WHO may approve is decided by the cardAction gate's
      // three-state mode, NOT here; `payload.o` is only consulted in `initiator`
      // mode, where it must equal the real initiator. The per-turn operator pin
      // (idle-guarded `chatOperators` + `driveTurn`'s `operatorOverride`) keeps
      // `rawInitiator` un-flippable by a mid-turn bystander.
      const operatorOpenId = rawInitiator;
      const staleSet = staleRequestIdsOf(thread.activities);
      // M3a: recover the real Feishu chatId (for the token's `c`/`scope`, matched
      // at verify against `evt.chatId`) and the topic id (signed into the token's
      // `lt` + echoed in the button value) from the composite key. For p2p / plain
      // group the key has no `:`, so `chatId === chatKey` and `larkThreadId` is
      // `undefined` — the token is byte-identical to the pre-M3a shape.
      const { chatId: realChatId, larkThreadId } = splitChatKey(chatKey);
      const ctx: InteractionContext = {
        chatId: realChatId,
        threadId: thread.id,
        operatorOpenId,
        runtimeMode: thread.runtimeMode,
        auth,
        ttlMs: CALLBACK_TOKEN_TTL_MS,
        ...(larkThreadId !== undefined ? { larkThreadId } : {}),
      };
      const elements = renderInteractionSection(
        pendingApprovals,
        pendingUserInputs,
        staleSet,
        resolvedNotice,
        ctx,
      );
      return { elements };
    });

  return { buildInteraction } as const;
};
