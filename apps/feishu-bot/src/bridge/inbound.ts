/**
 * Inbound-message handling extracted from bot.ts.
 *
 * Owns the per-message pipeline (p2p owner gate → operator pin → content
 * filter → command routing → workspace gate → first-contact ensureThread →
 * queue offer → turn drive) with the original closure body intact. The
 * first-contact serialization precondition (§5.7) is the caller's `ensureLock`,
 * threaded in as a dependency and held here around each `ensureThread` call.
 */
import { type FeishuChatConfig, type ProjectId, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import type * as Semaphore from "effect/Semaphore";

import type { LarkGatewayError } from "../lark/index.ts";
import type { InboundMessage } from "../lark/types.ts";
import { authorizeCommand, COMMAND_FLOOR, isOwnerExempt } from "./authz.ts";
import type { BindingState } from "./bindingState.ts";
import { effectiveChatConfig } from "./chatConfig.ts";
import { anchorOf, compositeChatKey } from "./chatThreadMap.ts";
import { prepareInboundImages } from "./imageAttachments.ts";
import type { CommandHandler } from "./commands/registry.ts";
import { tryHandleCommand } from "./commands/registry.ts";
import type { OfflineRetry } from "./createIntent.ts";
import type { OfflineStrategy } from "./turnRunner.ts";
import type { MergedDispatch, TurnQueue } from "./turnQueue.ts";
import type { SelectedWorkspace } from "./workspaceGate.ts";

/** Dependencies for one bound session's inbound-message handler. */
export interface InboundHandlerDeps {
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
  /** Mutable chat-to-thread binding state (in-memory authority). */
  readonly bindings: BindingState["Service"];
  /** Assembly-owned first-contact serialization permit (§5.7). */
  readonly ensureLock: Semaphore.Semaphore;
  /** Per-chat turn queue: idle-window coalescing + running-slot accounting. */
  readonly turnQueue: TurnQueue["Service"];
  /** The slash-command dispatch table. */
  readonly commandTable: ReadonlyMap<string, CommandHandler>;
  /** First-contact thread resolution (get-or-create / adopt / offline buffer). */
  readonly ensureThread: (message: InboundMessage) => Effect.Effect<ThreadId | null>;
  /** Drive a single turn for a chat end to end. */
  readonly runTurn: (
    chatId: string,
    dispatch: MergedDispatch,
    onOffline: OfflineStrategy,
  ) => Effect.Effect<void, OfflineRetry>;
  /** Offline strategy for the live path (buffers rather than retries). */
  readonly offlineBuffer: OfflineStrategy;
  /** Send a static notice card to a conversation. */
  readonly sendNotice: (
    chatKey: string,
    text: string,
    replyToMessageId?: string,
  ) => Effect.Effect<void>;
  /**
   * Download an image resource (batch A): pairs the owning `messageId` with a
   * resource `fileKey`. Wired from the connected Feishu gateway; the inbound
   * handler downloads + encodes a message's images at intake so the downstream
   * merge/build path only carries already-prepared payloads.
   */
  readonly downloadImage: (
    messageId: string,
    fileKey: string,
  ) => Effect.Effect<Buffer, LarkGatewayError>;
  /** Resolve the chat's `/workspace` selection against the live snapshot. */
  readonly selectedWorkspaceFor: (chatKey: string) => Effect.Effect<SelectedWorkspace>;
  /** User-facing text for a not-"ok" workspace selection. */
  readonly workspaceGateText: (selected: SelectedWorkspace) => string;
  /** User-facing text for a workspace narrowed out of the chat's authorized set. */
  readonly workspaceRevokedText: string;
  /** Dispatch-time workspace authorization gate (owner exempt). */
  readonly senderMayUseProjectAtDispatch: (
    message: InboundMessage,
    projectId: ProjectId,
  ) => Effect.Effect<boolean>;
}

/** Handle returned by {@link makeInboundHandler}. */
export interface InboundHandlerHandle {
  readonly handleInbound: (message: InboundMessage) => Effect.Effect<void>;
}

/** Construct the inbound-message handler for one bound Feishu session. */
export const makeInboundHandler = (deps: InboundHandlerDeps): InboundHandlerHandle => {
  const {
    ownerRef,
    chatConfigsRef,
    chatDefaultsRef,
    bindings,
    ensureLock,
    turnQueue,
    commandTable,
    ensureThread,
    runTurn,
    offlineBuffer,
    sendNotice,
    downloadImage,
    selectedWorkspaceFor,
    workspaceGateText,
    workspaceRevokedText,
    senderMayUseProjectAtDispatch,
  } = deps;

  /**
   * Handle one inbound message: filter unsupported content, ensure the chat's
   * thread (binding/buffering on first contact, under `ensureLock`), then offer
   * it to the per-chat queue. An idle offer returns a merged dispatch (after the
   * ~600ms coalescing window) we run as a turn; a held offer (turn already
   * running) returns `null` — the running turn's completion picks it up.
   *
   * Forked one-per-message so concurrent `offer` calls drive the queue's
   * generation-debounce coalescing (rapid messages collapse into one prompt);
   * the only racy step, first-contact create, is serialized by `ensureLock`.
   */
  const handleInbound = (message: InboundMessage): Effect.Effect<void> =>
    Effect.gen(function* () {
      // M3a: the composite conversation key — a topic (`omt_…`) is its own
      // conversation, so binding / queue / operator / mirror state all key on
      // `chatId[:larkThreadId]` (byte-identical to the bare chatId for p2p /
      // plain group). All internal state below uses `chatKey`; the gateway sends
      // recover the real Feishu chatId via `splitChatKey`.
      const larkThreadId = anchorOf(message);
      const chatKey = compositeChatKey(message.chatId, larkThreadId);

      // M-3: a p2p private chat is owner-only. p2p is 1:1, so a non-owner DMing
      // the bot must not be able to drive a session (create a global project, run
      // a full-access turn). Judge on the authoritative `chatType === "p2p"`
      // (`chatMode` may be undefined); groups (`chatType === "group"`) are NOT
      // gated here — they still admit non-owners under the command allowlist /
      // workspace-authorization gates. Placed before the operator pin so a
      // non-owner touches no conversation state. `owner === null` (unbound) does
      // NOT gate — with no configured owner we keep the chat open (e.g. a binding
      // flow); only once an owner is set do we refuse non-owners.
      if (message.chatType === "p2p") {
        const p2pOwner = yield* Ref.get(ownerRef);
        if (p2pOwner !== null && !isOwnerExempt(p2pOwner, message.senderId)) {
          yield* sendNotice(
            chatKey,
            "私聊仅限 bot 管理员使用。如需协作,请在群聊中 @机器人。",
            message.messageId,
          );
          return;
        }
      }

      // (Pin-drift fix) The old idle-guard that recorded
      // `chatOperators[chatKey] = message.senderId` here has been REMOVED. The
      // approval card's signed `payload.o` is no longer resolved from a per-chat
      // "last sender" ref — which a mid-observe bystander could drift while an
      // observe turn keeps the chat `isChatBusy=false`, then self-authorize in
      // `initiator` mode — but from the per-thread `feishuInitiators` map, written
      // ONLY by turn-establishing Feishu actions (`driveTurn` / `/resume` / M18).
      // A raw inbound no longer touches any operator-signing state.

      // Content filter (M16 + batch A): a message with NO text AND no image
      // attachments (an empty body, or a non-image file — `normalizeInbound`
      // drops non-image resources) must NOT become an empty-prompt turn — reply
      // with an explicit notice and skip. An image-only message (empty text but
      // ≥1 image attachment) is now admitted: the image carries the intent, and
      // the pictures are downloaded/encoded below before the turn is offered.
      if (message.text.trim().length === 0 && message.attachments.length === 0) {
        // Fix 5: this reply answers a real triggering message, so anchor it into
        // the topic (composite `chatKey` + the message id) instead of the group
        // root; p2p / plain group degrade to the root (byte-identical).
        yield* sendNotice(
          chatKey,
          "I received an empty message — please send some text.",
          message.messageId,
        );
        return;
      }

      // M2a command routing: a `/…` message is a control command, NOT a prompt.
      // Route it BEFORE `ensureThread` so commands work on an unbound chat
      // (`/help`, `/resume` listing candidates) without auto-creating a thread.
      // A known command is fully handled; a `/`-prefixed miss gets a help hint;
      // a non-command falls through to the normal turn path.
      // M-3: per-chat command allowlist. Resolve owner + effective config (bare
      // chatId, like the approval gate) ONLY for `/…` messages; the predicate is
      // pure and the registry calls it only on a table hit. The binding owner and
      // the /help+/whoami floor bypass the allowlist (in `authorizeCommand`).
      let isCommandAllowed: (command: string) => boolean = () => true;
      if (message.text.trimStart().startsWith("/")) {
        const cmdOwner = yield* Ref.get(ownerRef);
        const cmdConfig = effectiveChatConfig(
          message.chatId,
          yield* Ref.get(chatConfigsRef),
          yield* Ref.get(chatDefaultsRef),
        );
        isCommandAllowed = (command) =>
          authorizeCommand({
            owner: cmdOwner,
            sender: message.senderId,
            command,
            allowlist: cmdConfig.commands,
            floor: COMMAND_FLOOR,
          });
      }
      const outcome = yield* tryHandleCommand(message, commandTable, isCommandAllowed);
      if (outcome.handled) {
        if (outcome.unknownCommand !== undefined) {
          // Fix 5: anchor the "unknown command" reply into the triggering topic.
          yield* sendNotice(chatKey, "未知命令,/help 查看可用命令。", message.messageId);
        } else if (outcome.deniedCommand !== undefined) {
          // M-3: the command exists but this chat's allowlist denies it —
          // explicit refusal (never silent), symmetric with unknownCommand.
          // `/workspace` gets a tailored hint (承主 §4.1: don't clash with the
          // "no workspace selected" guidance) so its denial reads as intended.
          yield* sendNotice(
            chatKey,
            outcome.deniedCommand === "/workspace"
              ? "本群未开放 /workspace(无法在此群选择工作区或发起任务)。如需在此群跑任务,请联系 bot 管理员调整配置。发送 /help 查看本群可用命令。"
              : `命令 ${outcome.deniedCommand} 在本群未开放。发送 /help 查看本群可用命令。`,
            message.messageId,
          );
        }
        return;
      }

      // M-1 workspace gate: "no thread without a selected workspace". Only a
      // NOT-yet-bound conversation needs a (valid) selection — an already
      // bound chat has its thread and keeps the session regardless (pre-M-1
      // bindings and `/resume` takeovers pass through untouched). Commands
      // were routed above, so they are never gated. `ensureThread` re-checks
      // authoritatively at create time; this early gate exists so a
      // workspace-less chat is answered BEFORE the turn queue is touched.
      if ((yield* bindings.get(chatKey)) === null) {
        const selected = yield* selectedWorkspaceFor(chatKey);
        if (selected.kind !== "ok") {
          yield* sendNotice(chatKey, workspaceGateText(selected), message.messageId);
          return;
        }
        // M-3: refuse a selection narrowed out of the authorized set before the
        // turn queue is touched (owner exempt); `ensureThread` re-checks too.
        if (!(yield* senderMayUseProjectAtDispatch(message, selected.project.id))) {
          yield* sendNotice(chatKey, workspaceRevokedText, message.messageId);
          return;
        }
      }

      // Batch A: download + encode this message's images HERE (inbound is the
      // gateway-holding async edge) — and BEFORE `ensureThread`'s create/bind
      // side effect. Doing it first means a doomed image-only message (every
      // image dropped AND no text) bails WITHOUT leaving a spurious empty thread
      // or, offline, a contradictory "⏳ queued" + "N 张未发送" pair — matching the
      // pre-batch-A filter, which rejected image-only messages before any thread
      // was touched (review finding). The download still runs at inbound, so an
      // offline-buffered turn rides pre-encoded (Feishu resources never expire
      // mid-flush) and the pure merge/build path downstream only carries
      // already-prepared `uploaded` payloads. Bad images (unsupported type /
      // oversized / download failure) are dropped and counted so we NEVER send a
      // payload the server would reject the whole turn for; the user gets one
      // merged notice rather than per-image spam.
      const prepared = yield* prepareInboundImages({ downloadImage }, message);
      if (prepared.skipped > 0) {
        yield* sendNotice(
          chatKey,
          `${prepared.skipped} 张图片未发送(格式不支持 / 过大 / 下载失败)。`,
          message.messageId,
        );
      }
      // If every image was dropped AND there is no text, there is nothing to act
      // on — the skip notice already explained; bail before `ensureThread` so no
      // thread is created/buffered for a turn that will never run.
      const hasUploaded = prepared.message.attachments.some((att) => att.uploaded !== undefined);
      if (message.text.trim().length === 0 && !hasUploaded) {
        return;
      }

      // Ensure the chat↔thread binding FIRST (serialised) so the queue resolves
      // the real threadId when it merges — the stable commandId triple includes
      // the threadId, so offering before binding would derive the wrong id.
      // We run `ensureThread` for its build-thread side effect (first
      // contact: create + bind, or buffer offline); the turn's actual target is
      // NOT taken from here but from the merged dispatch's own resolution (B1),
      // so a concurrent `/resume` re-bind between here and the offer cannot make
      // the dispatch target and its commandId disagree. M-1: a `null` result
      // means the create was refused (workspace missing/stale at create time,
      // or the deterministic threadId collided with another workspace's
      // thread) — `ensureThread` already sent the notice, so just stop here
      // (never offer a turn that has no thread to land on).
      const ensured = yield* ensureThread(message).pipe(ensureLock.withPermits(1));
      if (ensured === null) {
        return;
      }

      // `offer` blocks for the idle coalescing window; concurrent offers for
      // the same chat collapse via the generation-debounce into one dispatch.
      // The returned merge carries `resolvedThreadId` — resolved at the same
      // instant its commandId was — which `runTurn` dispatches against. Offer the
      // PREPARED message so its encoded images ride through the queue.
      const merged = yield* turnQueue.offer(chatKey, prepared.message);
      if (merged === null) {
        return; // Coalesced into a peer offer, or held during a running turn.
      }
      // Live path: `offlineBuffer` buffers (succeeds) rather than signalling a
      // retry, so `OfflineRetry` is unreachable here — treat it as a defect.
      yield* runTurn(chatKey, merged, offlineBuffer).pipe(Effect.orDie);
    });

  return { handleInbound } as const;
};
