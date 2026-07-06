/**
 * cardAction (button click / form submit) handling extracted from bot.ts.
 *
 * Owns the operator-name resolution, the bystander card re-arm (§11E SDK
 * seenCache defeat), and the end-to-end click handler with the original closure
 * bodies intact. The handler's verify → authz → nonce-consume → route → audit →
 * echo ordering (§5.1) and the form/approval echo split (§5.11) are preserved
 * verbatim.
 */
import {
  respondToThreadApproval,
  respondToThreadUserInput,
} from "@t3tools/client-runtime/operations";
import type { EnvironmentSupervisor } from "@t3tools/client-runtime/connection";
import {
  derivePendingApprovals,
  derivePendingUserInputs,
} from "@t3tools/client-runtime/state/thread-activity";
import {
  ApprovalRequestId,
  CommandId,
  type FeishuChatConfig,
  type OrchestrationThread,
  type OrchestrationThreadStreamItem,
  type RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import type * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import type { LarkGateway } from "../lark/index.ts";
import type { CardActionEvent } from "../lark/types.ts";
import type { AuditStore, CallbackNonceStore } from "../runtime/persistence.ts";
import type { CardHandle, CardHandleStore } from "../runtime/persistence.ts";
import { authorizeApprovalClick } from "./authz.ts";
import type { BindingState } from "./bindingState.ts";
import type { CallbackAuth } from "./callbackAuth.ts";
import { computePolicyFingerprint } from "./callbackAuth.ts";
import { effectiveChatConfig } from "./chatConfig.ts";
import { compositeChatKey, splitChatKey } from "./chatThreadMap.ts";
import { type RenderDensity, renderThreadCard } from "./eventRenderer.ts";
import { CALLBACK_TOKEN_TTL_MS, staleRequestIdsOf } from "./interaction.ts";
import { resolveObserveOperator } from "./observeOperator.ts";
import {
  actionToApprovalDecision,
  formValueToAnswers,
  type InteractionContext,
  parseCardActionValue,
  renderInteractionSection,
  type ResolvedNoticeEntry,
} from "./interactionCard.ts";
import type { ShellSnapshotCache } from "./shellCache.ts";

/**
 * Feishu's client locks a submitted form for ~1s (FORM_SETTLE_MS). Updating the
 * card before that lock clears rolls the update back, so a user-input *form*
 * submit echo waits this long before re-rendering. An approval (plain button)
 * echo is immediate.
 */
const FORM_SETTLE_DELAY = Duration.seconds(1);

/**
 * M3b: upper bound on the per-bystander "unauthorised click" dedup set. Realistic
 * bystander volume is tiny, but the set is keyed by `(chatKey, messageId, openId)`
 * and lives for the whole bridge scope, so a long-running, high-traffic group
 * could grow it without limit. On overflow we keep the most recent ~80% (Set
 * iteration order ≈ insertion order) and drop the oldest entries.
 */
const MAX_BYSTANDER_KEYS = 10_000;

/** Dependencies for one bound session's cardAction handler. */
export interface CardActionHandlerDeps {
  /** Per-binding CallbackAuth instance (token verify). */
  readonly auth: CallbackAuth;
  /** Durable single-use nonce guard. */
  readonly nonceStore: CallbackNonceStore["Service"];
  /** Append-only audit log (who clicked what). */
  readonly audit: AuditStore["Service"];
  /** Mutable chat-to-thread binding state (in-memory authority). */
  readonly bindings: BindingState["Service"];
  /** Durable latest-card handles; the echo reads the recovered operator fallback. */
  readonly cardHandles: CardHandleStore["Service"];
  /**
   * Assembly-owned trusted per-thread Feishu-initiator map (`threadId` →
   * operator open_id). The approval echo re-signs still-pending SIBLING controls
   * from THIS map (not the clicker) so a clicker authorised only by `all` /
   * `designated` mode cannot plant `payload.o = clicker` into a sibling token
   * and self-authorize after a later tighten to `initiator` mode (pin-drift class).
   */
  readonly feishuInitiators: Ref.Ref<ReadonlyMap<ThreadId, string>>;
  /** Resident shell snapshot cache (verify-side runtimeMode read). */
  readonly shellCache: ShellSnapshotCache;
  /** Connected Feishu gateway for card updates + contact lookups. */
  readonly gateway: LarkGateway["Service"];
  /**
   * Live binding owner open id (`null` when unbound). §5.6: read at call time,
   * never cache a snapshot.
   */
  readonly ownerRef: Ref.Ref<string | null>;
  /**
   * Live per-chat approval config keyed by bare chatId. §5.6: read at call
   * time, never cache a snapshot.
   */
  readonly chatConfigsRef: Ref.Ref<{ readonly [chatId: string]: FeishuChatConfig }>;
  /**
   * Live per-chat config defaults. §5.6: read at call time, never cache a
   * snapshot.
   */
  readonly chatDefaultsRef: Ref.Ref<FeishuChatConfig>;
  /** Assembly-owned resolved-notices overlay; this is the write point. */
  readonly chatResolvedNotices: Ref.Ref<
    ReadonlyMap<string, ReadonlyMap<string, ResolvedNoticeEntry>>
  >;
  /** Build signed approval and user-input controls for a thread. */
  readonly buildInteraction: (
    chatKey: string,
    thread: OrchestrationThread,
    operatorOverride?: string,
  ) => Effect.Effect<{ readonly elements: ReadonlyArray<object> } | undefined>;
  /** Resolve the effective card density for a live thread. */
  readonly resolveDensity: (
    chatKey: string,
    runtimeMode: RuntimeMode,
  ) => Effect.Effect<RenderDensity>;
  /** Subscribe to a thread's replaying detail stream. */
  readonly subscribeThread: (threadId: ThreadId) => Stream.Stream<OrchestrationThreadStreamItem>;
  /** Echo a plain notice onto a clicked card. */
  readonly updateCardNotice: (messageId: string, text: string) => Effect.Effect<void>;
  /** Send a static notice card to a conversation. */
  readonly sendNotice: (
    chatKey: string,
    text: string,
    replyToMessageId?: string,
  ) => Effect.Effect<void>;
  /** Run an environment-scoped operation, discharging Crypto/Supervisor. */
  readonly runOnEnv: <A, E>(
    operation: Effect.Effect<A, E, Crypto.Crypto | EnvironmentSupervisor>,
  ) => Effect.Effect<A>;
  /** Generate a branded id (Crypto already discharged). */
  readonly genId: <A>(brand: { readonly make: (value: string) => A }) => Effect.Effect<A>;
  /** Fork an effect onto the bridge's scoped FiberSet runtime (form settle echo). */
  readonly runFork: <A, E>(effect: Effect.Effect<A, E>) => Fiber.Fiber<A, E>;
}

/** Handle returned by {@link makeCardActionHandler}. */
export interface CardActionHandlerHandle {
  readonly handleCardAction: (evt: CardActionEvent) => Effect.Effect<void>;
}

/** Construct the cardAction handler for one bound Feishu session. */
export const makeCardActionHandler = (
  deps: CardActionHandlerDeps,
): Effect.Effect<CardActionHandlerHandle> =>
  Effect.gen(function* () {
    const {
      auth,
      nonceStore,
      audit,
      bindings,
      cardHandles,
      feishuInitiators,
      shellCache,
      gateway,
      ownerRef,
      chatConfigsRef,
      chatDefaultsRef,
      chatResolvedNotices,
      buildInteraction,
      resolveDensity,
      subscribeThread,
      updateCardNotice,
      sendNotice,
      runOnEnv,
      genId,
      runFork,
    } = deps;

    // Fix B: per-bystander dedup so the "unauthorised click" notice fires at most
    // once per (chatKey, card messageId, clicker openId) triple. Realistic bystander
    // volume is tiny, but the set lives for the whole bridge scope, so the write
    // site (M3b) clamps it to `MAX_BYSTANDER_KEYS`, dropping the oldest keys on
    // overflow — bounded memory without breaking the at-most-once dedup.
    const bystanderNoticed = yield* Ref.make<ReadonlySet<string>>(new Set<string>());

    // P3: openId → resolved Feishu display name. The cardAction echo prefers the
    // name the event already carried (`evt.operator.name`), then this in-process
    // cache, then a one-off `gateway.getUser` contact lookup (cached on success).
    // A lookup failure (missing `contact:user.base:readonly` scope → 403, etc.)
    // is swallowed and falls back to the raw openId — never blocking the echo.
    const operatorNames = yield* Ref.make<ReadonlyMap<string, string>>(new Map());

    // ── M2b-1: cardAction (button click / form submit) → shared respond RPC ──
    //
    // P3: resolve the operator's display name for the echo. Priority: the name
    // the cardAction event already carried → the in-process cache → a one-off
    // `gateway.getUser` contact lookup (cached on success). Every lookup failure
    // (missing scope → 403, network) degrades gracefully to the raw openId — the
    // echo must never block or throw on name resolution.
    const resolveOperatorName = (operator: {
      readonly openId: string;
      readonly name?: string;
    }): Effect.Effect<string> =>
      Effect.gen(function* () {
        const openId = operator.openId;
        const eventName = operator.name?.trim();
        if (eventName) {
          return eventName;
        }
        const cached = (yield* Ref.get(operatorNames)).get(openId);
        if (cached !== undefined) {
          return cached;
        }
        const looked = yield* gateway.getUser(openId).pipe(
          Effect.map((user): string | null => user.name?.trim() ?? null),
          // Missing `contact:user.base:readonly` scope (403), network, etc. → fall
          // back to the openId; never block or fail the echo.
          Effect.orElseSucceed((): string | null => null),
        );
        const resolved = looked && looked.length > 0 ? looked : openId;
        yield* Ref.update(operatorNames, (map) => new Map(map).set(openId, resolved));
        return resolved;
      });

    // Bystander handling (M3a; generalised + shared in M4-1; §11E re-arm in this PR).
    // An unauthorised click on the CURRENT card must NOT act on the request — the real
    // approver's decision is the only one that routes — but it MUST still change the
    // card, because of how a click that produces no card change gets deduped:
    //
    //   The lark SDK (`@larksuite/channel`) drops a card-action whose dedup key
    //   `card:<messageId>:<clicker>:<tag>|<name>|<option>|<value[:128]>` it has already
    //   seen within its 12h TTL (`Safety.pushAction` → `seenCache`; `DEFAULT_DEDUP.ttl`,
    //   no dedup config passed in `lark/channel.ts`). Because `onCardAction` is a
    //   fire-and-forget `runFork`, the SDK's `await h(evt)` resolves at once and the
    //   handled click's key is added to the cache immediately. Our signed token's only
    //   per-sign-varying bytes live PAST that 128-char window, so if we leave the card
    //   BYTE-FOR-BYTE unchanged, the SAME person's LATER click (e.g. after `approvalMode`
    //   flipped to `all` and they became authorised) carries an identical dedup key and
    //   is dropped in-process BEFORE `onCardAction` — the approval dead-ends at the turn's
    //   local timeout. (Diagnosed 2026-07-06: the second click produced zero
    //   `onCardAction` deliveries. Feishu may ALSO suppress re-delivery server-side, but
    //   the SDK seenCache is the code-proven mechanism the fix must defeat.)
    //
    // Fix (two parts): (a) `interactionCard.ts` puts a per-sign-unique `k` INSIDE the
    // 128-char window so a re-render yields a fresh dedup key; (b) here we re-render the
    // SAME card (same thread body + same live interaction, freshly-signed buttons) onto
    // the same `messageId`, so a fresh-`k` button lands on the card and the NEXT click —
    // authorised or not — is delivered. We re-arm on EVERY bystander click (never deduped)
    // so no click is ever the "unchanged" one the SDK latches onto; only the neutral
    // @-notice is deduped (to at most once per (chatKey, messageId, clicker)) so repeated
    // taps don't spam the topic. Buttons are re-signed for the verified token's initiator
    // (`res.payload.o`, passed as `initiatorOpenId`), NOT the bystander clicker and NOT
    // any ambient/mutable ref — see the call below for why. Called from the
    // authz gate: the token already passed `verify`, which proves the click targets the
    // live card for this chat/thread/policy. Generic wording covers approval and
    // user-input interactions.
    const preserveCardForBystander = (
      chatKey: string,
      threadId: ThreadId,
      messageId: string,
      clickerOpenId: string,
      // The initiator carried by the just-verified live token (`res.payload.o`). The
      // re-arm re-signs the card's buttons for THIS id so the re-armed card keeps the
      // exact same approval authority as the card the bystander clicked.
      initiatorOpenId: string,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* Console.log(
          `[feishu-bot] cardAction ignored for chat ${chatKey} — unauthorised click; re-arming the card for the real approver.`,
        );

        // Re-arm (core §11E fix). Best-effort and fully isolated: a snapshot / render /
        // update failure must never swallow the neutral notice below or crash the
        // handler, so we `catchCause` it to a warning. Mirrors the M18 restart-recovery
        // re-render (one-shot `subscribeThread` snapshot → `buildInteraction` →
        // `renderThreadCard` → `updateCard` on the same messageId).
        yield* Effect.gen(function* () {
          // Re-sign the re-armed buttons for the EXACT initiator carried by the just-
          // verified live token (`initiatorOpenId` = `res.payload.o`), passed as
          // `buildInteraction`'s `operatorOverride`. This is the token the bystander's
          // own click just carried, so re-arming reproduces the SAME approval authority
          // — it can never widen it: `res.payload.o` is fixed by `verify`, never read
          // from any mutable ref. When `initiatorOpenId` is empty (a card signed with no
          // Feishu initiator — a web/terminal-mirrored turn, or a non-initiator-mode /
          // M18-recovered card), re-arming would just re-emit an empty-operator card,
          // which in `initiator` mode is intentionally non-clickable for non-owners
          // (approve it from the web); so we SKIP the re-arm rather than churn the card.
          // The common case (non-empty initiator) re-arms normally and stays signed for
          // the real approver, so a bystander stays locked out.
          if (initiatorOpenId.length === 0) {
            return;
          }
          const firstFrame = yield* Stream.runHead(
            subscribeThread(threadId).pipe(Stream.take(1)),
          ).pipe(
            Effect.scoped,
            Effect.timeout(Duration.seconds(10)),
            Effect.option,
            Effect.map(Option.flatten),
          );
          const snapshotThread = Option.match(firstFrame, {
            onNone: () => null as OrchestrationThread | null,
            onSome: (item) => (item.kind === "snapshot" ? item.snapshot.thread : null),
          });
          if (snapshotThread === null) {
            return;
          }
          const interaction = yield* buildInteraction(chatKey, snapshotThread, initiatorOpenId);
          // No live interaction (the request was resolved elsewhere while this click was
          // in flight) → nothing to re-arm; leave the card to the normal render path.
          if (interaction === undefined) {
            return;
          }
          const density = yield* resolveDensity(chatKey, snapshotThread.runtimeMode);
          const card = renderThreadCard(snapshotThread, {
            streaming: false,
            density,
            interaction,
          }).card;
          yield* gateway.updateCard(messageId, card);
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning(
              `[feishu-bot] bystander card re-arm failed for chat ${chatKey} (message ${messageId}).`,
              cause,
            ),
          ),
        );

        const dedupKey = `${chatKey}:${messageId}:${clickerOpenId}`;
        const alreadyNotified = yield* Ref.modify(bystanderNoticed, (set) => {
          if (set.has(dedupKey)) return [true, set] as const;
          const next = new Set(set);
          next.add(dedupKey);
          // M3b: bound the set. On overflow keep the most recent ~80% (Set iteration
          // order ≈ insertion order) and drop the oldest keys.
          if (next.size > MAX_BYSTANDER_KEYS) {
            const keep = Math.floor(MAX_BYSTANDER_KEYS * 0.8);
            return [false, new Set(Array.from(next).slice(-keep))] as const;
          }
          return [false, next] as const;
        });
        if (!alreadyNotified) {
          // The WS card path has no native per-clicker toast, so post a short
          // topic-anchored notice; the re-arm above keeps the same live interaction on
          // the card, so the real approver's buttons remain actionable.
          yield* sendNotice(
            chatKey,
            `<at id=${clickerOpenId}></at> 你暂时没有此操作的权限,需由授权人处理。`,
            messageId,
          );
        }
      });

    /**
     * Handle one cardAction (button click / form submit) end to end (contract B9
     * §9). The bridge is a thin *shared* client: it verifies the signed token,
     * durably consumes its single-use nonce, then routes the operator's decision
     * through the SAME shared respond RPC (`respondToThreadApproval` /
     * `respondToThreadUserInput`) every other end uses — no bridge-private
     * approval state. Every step that can't proceed degrades the clicked card to
     * a plain notice instead of leaving a dead button.
     */
    const handleCardAction = (evt: CardActionEvent): Effect.Effect<void> =>
      Effect.gen(function* () {
        // 1. Parse the callback value. A foreign / legacy button → ignore.
        const parsed = parseCardActionValue(evt.action.value);
        if (parsed === null) {
          return;
        }

        // M3a: `CardActionEvent` carries no thread field, so the button echoes its
        // topic id in the value (`parsed.larkThreadId`) — a PRE-VERIFY bootstrap used
        // to locate the topic's binding (and thus its thread id) *before* the policy
        // fingerprint can be recomputed to verify the token. It is untrusted on its
        // own but tamper-evident: the signed fingerprint derives from the topic's
        // thread id, so a forged/stripped `lt` resolves a different (or no) binding →
        // a mismatched fingerprint → `verify` fails with `context-mismatch`. The
        // signed `res.payload.lt` (read after verify succeeds) is the authoritative
        // copy and, by that fingerprint binding, necessarily equals this bootstrap.
        const chatKey = compositeChatKey(evt.chatId, parsed.larkThreadId);

        // 2. Resolve the conversation's bound thread under the composite key. No
        //    binding → the topic/chat is not (or no longer) driving a session; tell
        //    the operator and stop.
        const binding = yield* bindings.get(chatKey);
        if (binding === null) {
          yield* updateCardNotice(evt.messageId, "会话未接管,无法响应此操作。");
          return;
        }
        const threadId = binding.threadId;

        // 3. Read the thread's *current* runtimeMode from the shell cache (E②:
        //    the verify side uses the shell's runtimeMode, which may lag the
        //    render side's by <1s). Absent shell → treat the button as stale.
        const shell = yield* shellCache.threadById(threadId);
        if (shell === null) {
          yield* updateCardNotice(evt.messageId, "⚠️ 此操作已失效。");
          return;
        }

        // 4. Recompute the policy fingerprint for the verify context.
        const fp = computePolicyFingerprint(evt.chatId, threadId, shell.runtimeMode);

        // 5. Verify the token's INTEGRITY against the expected context. M4-1: no
        //    `operatorOpenId` here either — authz (who may click) is decoupled from
        //    verify and enforced by the authz gate (step 6b) below. Verify now only
        //    proves the token is untampered and belongs to THIS chat/thread/policy
        //    (no `action`, adjustment 2; no `operatorOpenId`, M4-1).
        const res = auth.verify(parsed.token, {
          runId: threadId,
          scope: evt.chatId,
          chatId: evt.chatId,
          policyFingerprint: fp,
        });

        // 6. Verification failure = an INTEGRITY failure: a tampered token or a
        //    genuinely stale card (e.g. threadId/fp changed after a `/resume` or a
        //    runtimeMode change). M4-1: because authz is no longer folded into verify,
        //    the live card passes verify for ANY clicker — so `context-mismatch` no
        //    longer fires on a mere bystander click (that is now caught by the authz
        //    gate below), only on a truly stale/foreign card. Degrade it
        //    unconditionally; there is no live card left to preserve.
        if (!res.ok) {
          yield* Console.log(
            `[feishu-bot] cardAction rejected for chat ${evt.chatId} (${res.reason}).`,
          );
          yield* updateCardNotice(evt.messageId, "⚠️ 按钮已失效,请回到最新卡片重新操作。");
          return;
        }

        // 6b. Authz (M-2): verify proved integrity (this IS the live card for this
        //     chat/thread/policy); now decide WHO may act. Owner-always (the bound
        //     owner) overlays the per-chat three-state mode: `initiator` matches the
        //     signed `payload.o` (the true turn initiator), `designated` the
        //     configured approvers, `all` any chat member (any clicker of an in-chat
        //     card is a member — no roster fetch). A non-authorised clicker is a
        //     bystander: no-op the card (preserve it for the real approver) + neutral
        //     @notice. MUST run BEFORE the nonce consume (step 8) so a bystander click
        //     never burns the single-use nonce out from under the real approver.
        const clicker = evt.operator.openId;
        const owner = yield* Ref.get(ownerRef);
        const chatConfig = effectiveChatConfig(
          evt.chatId,
          yield* Ref.get(chatConfigsRef),
          yield* Ref.get(chatDefaultsRef),
        );
        const authorized = authorizeApprovalClick({
          owner,
          mode: chatConfig.approvalMode,
          approvers: chatConfig.approvers,
          clicker,
          initiator: res.payload.o,
        });
        if (!authorized) {
          yield* preserveCardForBystander(chatKey, threadId, evt.messageId, clicker, res.payload.o);
          return;
        }

        // 7. The request must still be open & pending (it may have been answered
        //    elsewhere, or force-resolved stale). Take a one-shot snapshot of the
        //    thread (the subscribe stream replays a full snapshot first) and
        //    re-derive the pending set, then locate the matching request. The
        //    `Stream.take(1)` closes the subscription immediately (scoped read).
        const firstFrame = yield* Stream.runHead(
          subscribeThread(threadId).pipe(Stream.take(1)),
        ).pipe(Effect.scoped);
        const snapshotThread = Option.match(firstFrame, {
          onNone: () => null as OrchestrationThread | null,
          onSome: (item) => (item.kind === "snapshot" ? item.snapshot.thread : null),
        });
        const activities = snapshotThread?.activities ?? [];
        const pendingApprovals = derivePendingApprovals(activities);
        const pendingUserInputs = derivePendingUserInputs(activities);
        const matchedApproval = pendingApprovals.find(
          (approval) => approval.requestId === parsed.requestId,
        );
        const matchedUserInput = pendingUserInputs.find(
          (userInput) => userInput.requestId === parsed.requestId,
        );
        if (matchedApproval === undefined && matchedUserInput === undefined) {
          yield* updateCardNotice(evt.messageId, "⚠️ 此操作已失效(请求已被处理或过期)。");
          return;
        }
        // #6/#8: past this guard a request matched, which is only possible when the
        // snapshot delivered a non-empty `activities` — i.e. `snapshotThread` is
        // non-null. The old `echoResolved` carried a `snapshotThread === null`
        // fallback branch (a plain `updateCardNotice` with an *un-truncated*
        // commandSummary), but that branch was unreachable for exactly this reason
        // (dead code, and #6/#12's missing-truncation only lived there). We narrow
        // the type here so the echo always re-renders the full card, and surface the
        // impossible-null case as a defect rather than silently dead-pathing.
        if (snapshotThread === null) {
          return yield* Effect.die(
            new Error("cardAction: matched a pending request but snapshot thread was null."),
          );
        }

        // 8. Durably consume the single-use nonce BEFORE routing (adjustment 1:
        //    no crash-replay window). A `false` means another delivery already
        //    consumed it → replay; degrade and stop.
        const consumed = yield* nonceStore
          .consume(res.payload.n, res.payload.exp)
          .pipe(Effect.orElseSucceed(() => false));
        if (!consumed) {
          yield* updateCardNotice(evt.messageId, "⚠️ 此操作已失效(重复点击)。");
          return;
        }

        // 9. One commandId for both the respond RPC and the audit row (adjustment
        //    6) so the durable ledger keys exactly the dispatched command.
        const commandId = yield* genId(CommandId);
        const requestId = ApprovalRequestId.make(parsed.requestId);

        // 10. Route through the shared respond RPC. `runOnEnv` discharges
        //     Crypto/EnvironmentSupervisor and orDies any unexpected failure.
        const isApproval = matchedApproval !== undefined;
        if (isApproval) {
          const decision = actionToApprovalDecision(res.payload.a);
          if (decision === null) {
            yield* updateCardNotice(evt.messageId, "⚠️ 无法识别的操作。");
            return;
          }
          yield* runOnEnv(respondToThreadApproval({ threadId, requestId, decision, commandId }));
        } else {
          const questions = matchedUserInput?.questions ?? [];
          // The unified user-input form submits natively, so the answers ride in
          // `evt.action.formValue`. `parsed.formValue` is a legacy fallback (the
          // removed single-select button group) kept for value-shape stability.
          const answers = formValueToAnswers(evt.action.formValue ?? parsed.formValue, questions);
          yield* runOnEnv(respondToThreadUserInput({ threadId, requestId, answers, commandId }));
        }

        // 11. Append the immutable audit row under the SAME commandId.
        const ts = yield* Clock.currentTimeMillis;
        // M3b: record the topic the command was routed within. `evt.chatId` is the
        // bare Feishu id; the composite `chatKey` carries the topic, so recover it
        // via `splitChatKey` (normalises empty → undefined). exactOptionalPropertyTypes:
        // omit the key for p2p / plain group rather than assigning `undefined`.
        const auditLarkThreadId = splitChatKey(chatKey).larkThreadId;
        yield* audit
          .append(commandId, {
            operatorOpenId: evt.operator.openId,
            chatId: evt.chatId,
            threadId,
            command: res.payload.a,
            ts,
            ...(auditLarkThreadId !== undefined ? { larkThreadId: auditLarkThreadId } : {}),
          })
          .pipe(Effect.ignore);

        // 12. Echo the outcome onto the clicked card by RE-RENDERING the same
        //     thread snapshot with this request's interaction controls greyed out,
        //     preserving the thread body — never replacing the whole card with a
        //     bare notice (which would drop the conversation). M2b-2: we build a
        //     structured {@link ResolvedNoticeEntry} (operator name + command
        //     summary + decision) and hand it to `interactionCard`, which composes
        //     the localized "✅ 已由 @X 授权 · <命令摘要>" / "🚫 … 拒绝 …" / "✅ … 提交"
        //     line itself (truncating the summary). We persist the entry into the
        //     chat's resolved overlay (P2) so every subsequent `driveTurn` render
        //     tick keeps this request greyed out for the whole turn and after it
        //     ends, then echo it onto this card now.
        const who = yield* resolveOperatorName(evt.operator);
        // Echo-display decision: derive it from the SAME action the respond RPC
        // routed (line ~2380) so the greyed-out echo matches what was actually
        // dispatched. A binary "accept vs else→decline" ternary would misclassify
        // an `acceptForSession` click as a 拒绝 echo, so map the action explicitly.
        // Only accept/acceptForSession/decline buttons exist (no `cancel` button),
        // and an unrecognized action can't reach here — routing already rejected a
        // null decision above — so decline is just a defensive default. User-input
        // submits stay "submit".
        const echoDecision = (action: string): ResolvedNoticeEntry["decision"] => {
          switch (action) {
            case "approval:accept":
              return "accept";
            case "approval:acceptForSession":
              return "acceptForSession";
            default:
              return "decline";
          }
        };
        const decision: ResolvedNoticeEntry["decision"] = isApproval
          ? echoDecision(res.payload.a)
          : "submit";
        // commandSummary: for an approval, the request's detail (the command/file
        // summary) — trimmed, `null` when empty; the renderer truncates it. A
        // user-input submit has no single-line detail, so it is `null`.
        const commandSummary = matchedApproval?.detail?.trim() || null;
        const entry: ResolvedNoticeEntry = {
          operatorName: who,
          commandSummary,
          decision,
        };

        // P2: record the overlay BEFORE echoing so any render tick racing this
        // handler already sees the request as resolved. M3a: keyed by the composite
        // `chatKey` so every subsequent `driveTurn`/observe render of THIS topic
        // (which read the overlay under the same composite key) keeps it greyed out.
        yield* Ref.update(chatResolvedNotices, (map) => {
          const forChat = new Map(map.get(chatKey) ?? new Map<string, ResolvedNoticeEntry>());
          forChat.set(parsed.requestId, entry);
          return new Map(map).set(chatKey, forChat);
        });

        // SECURITY (observe pin-drift class — same root the render/observe paths
        // close above): this echo re-renders every SIBLING request still pending
        // on THIS card as a LIVE button, re-signing each token's `payload.o`. Sign
        // those siblings with the TRUSTED session operator (`feishuInitiators` →
        // durable handle → ""), NEVER with the clicker `evt.operator.openId`.
        // Otherwise a clicker authorised only because the chat was in `all` /
        // `designated` mode plants `payload.o = clicker` into a sibling token; the
        // policy fingerprint does NOT bind `approvalMode` and tokens live
        // `CALLBACK_TOKEN_TTL_MS`, so a later tighten to `initiator` mode would let
        // that same clicker self-authorize the still-live sibling (`clicker ===
        // payload.o`). The audit entry (above) and the resolved-notice below still
        // record the real clicker `evt.operator` — only the SIGNING identity of the
        // re-rendered live siblings is forced back to the trusted operator.
        const echoInitiators = yield* Ref.get(feishuInitiators);
        const echoHandleOpt = yield* cardHandles
          .get(evt.chatId)
          .pipe(Effect.orElseSucceed(() => Option.none<CardHandle>()));
        const trustedEchoOperator =
          resolveObserveOperator(
            echoInitiators.get(threadId),
            Option.isSome(echoHandleOpt) && echoHandleOpt.value.operatorOpenId.length > 0
              ? echoHandleOpt.value.operatorOpenId
              : undefined,
          ) ?? "";

        const echoResolved = (): Effect.Effect<void> =>
          Effect.gen(function* () {
            const operatorOpenId = trustedEchoOperator;
            const ctx: InteractionContext = {
              // The token's `c`/`scope` is the real Feishu chatId (matched at verify
              // against `evt.chatId`); the topic id rides in `larkThreadId` so any
              // *other* still-pending request re-signed on this echo card stays
              // topic-bound. Omitted for p2p / non-topic (token unchanged pre-M3a).
              chatId: evt.chatId,
              threadId,
              operatorOpenId,
              runtimeMode: shell.runtimeMode,
              auth,
              ttlMs: CALLBACK_TOKEN_TTL_MS,
              ...(parsed.larkThreadId !== undefined ? { larkThreadId: parsed.larkThreadId } : {}),
            };
            const resolvedNotice = new Map<string, ResolvedNoticeEntry>([
              [parsed.requestId, entry],
            ]);
            const elements = renderInteractionSection(
              pendingApprovals,
              pendingUserInputs,
              staleRequestIdsOf(activities),
              resolvedNotice,
              ctx,
            );
            const density = yield* resolveDensity(chatKey, snapshotThread.runtimeMode);
            const card = renderThreadCard(snapshotThread, {
              streaming: false,
              density,
              interaction: { elements },
            }).card;
            yield* gateway.updateCard(evt.messageId, card).pipe(
              Effect.tapError((error) =>
                Console.error(
                  `[feishu-bot] card echo failed for ${evt.messageId}: ${error.message}`,
                ),
              ),
              Effect.ignore,
            );
          });

        // Approval (plain button) echoes immediately. A user-input *form* submit
        // is gated by Feishu's ~1s client-side form lock (FORM_SETTLE_MS); a
        // button-group tap is not a native form submit so it echoes immediately
        // too. Native form submit is detected by `evt.action.formValue != null`
        // (the SDK only fills it on a form submit; a button-group tap carries its
        // answer in `parsed.formValue`/`value`). The settled echo is fired off
        // the handler so the cardAction callback returns promptly.
        const isNativeFormSubmit = !isApproval && evt.action.formValue != null;
        if (isNativeFormSubmit) {
          runFork(Effect.sleep(FORM_SETTLE_DELAY).pipe(Effect.andThen(echoResolved())));
        } else {
          yield* echoResolved();
        }
      });

    return { handleCardAction } as const;
  });
