/**
 * Chat ↔ thread binding (M1, M2a).
 *
 * Resolves the t3code thread that backs a Feishu chat, creating one (and
 * recording the binding via {@link BindingState}) on the chat's first message.
 * This is what makes the conversation a true shared session: a returning chat
 * re-uses its thread across restarts.
 *
 * M2a: reads/writes the binding through {@link BindingState} (the in-memory
 * authority, mirrored to the durable `ChatThreadMapStore`) rather than the store
 * directly, so the bridge has a single source of truth for "which thread backs
 * this chat". The `createThread` dispatch is injected via {@link EnsureThreadDeps}
 * so this module stays decoupled from the registry's service shape. The
 * `ThreadId` itself is derived deterministically from the chat's composite key
 * ({@link deriveThreadId}) so first-contact creation is idempotent across retries
 * (see {@link ensureThreadForChat}).
 *
 * M3a: a Feishu *topic* (话题, `omt_…`) inside a group is a distinct conversation
 * that must back its own thread. The binding key is therefore promoted from a
 * bare `chatId` to a composite `(chatId, larkThreadId)` key
 * ({@link compositeChatKey}) — but only when a `larkThreadId` is present. p2p and
 * plain (non-topic) group chats pass `larkThreadId === undefined`, which
 * degenerates the composite key back to the bare `chatId` *byte-for-byte*, so
 * their derived `ThreadId` and persisted binding key are unchanged and no
 * existing binding is ever broken (zero re-bind). {@link splitChatKey} is the
 * inverse, recovering `(chatId, larkThreadId?)` from a stored composite key.
 */
import * as NodeCrypto from "node:crypto";

import { createThread } from "@t3tools/client-runtime/operations";
import {
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  type RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { BindingState } from "./bindingState.ts";
import { deriveCommandId } from "./commandId.ts";
import type { RenderDensity } from "./eventRenderer.ts";
import type { EnsuredThread } from "./types.ts";
import type { InboundMessage } from "../lark/types.ts";

/**
 * Composite binding key for a Feishu conversation (M3a).
 *
 * A topic (`larkThreadId`, `omt_…`) inside a group is its own conversation, so
 * the binding key must distinguish topics within the same `chatId`. When a
 * `larkThreadId` is present the key is `` `${chatId}:${larkThreadId}` ``;
 * otherwise (p2p / plain group, `undefined` or empty) it degenerates to the bare
 * `chatId` *byte-for-byte*. Feishu `chatId`s (`oc_…`, `p2p_…`) and `larkThreadId`s
 * (`omt_…`) never contain `:`, so a single `:` cleanly separates the two halves
 * (see {@link splitChatKey}).
 */
export const compositeChatKey = (chatId: string, larkThreadId?: string): string =>
  larkThreadId !== undefined && larkThreadId !== "" ? `${chatId}:${larkThreadId}` : chatId;

/**
 * Inverse of {@link compositeChatKey}: recover `(chatId, larkThreadId?)` from a
 * stored composite key. Splits on the *first* `:` (the `chatId` half never
 * contains one). A key with no `:` is a degenerate/legacy bare `chatId`, so
 * `larkThreadId` is `undefined`. Round-trips with {@link compositeChatKey}.
 */
export const splitChatKey = (key: string): { chatId: string; larkThreadId?: string } => {
  const sep = key.indexOf(":");
  if (sep === -1) {
    return { chatId: key };
  }
  return { chatId: key.slice(0, sep), larkThreadId: key.slice(sep + 1) };
};

/**
 * Runtime mode per chat type (M3a): a 1:1 private chat keeps `full-access`
 * (unchanged pre-M3a behaviour); a group / topic chat — shared, multi-party —
 * is `approval-required` so destructive actions surface an approval card rather
 * than running unattended. Lives here (not in `bot.ts`) so both the bridge core
 * and the slash-command handlers (`/resume` full-access gate) derive the policy
 * from one place.
 */
export const runtimeModeForChatType = (chatType: string): RuntimeMode =>
  chatType === "p2p" ? "full-access" : "approval-required";

/**
 * M3a/M4-1: derive the open id stamped into the approval token's signed `payload.o`.
 * When an owner is configured AND the chat is approval-gated (group/topic) this
 * stamps `ownerOpenIds[0]`; p2p (full-access) and the unconfigured/empty case fall
 * back to the turn initiator (pre-M3a "initiator-only" behavior, no regression).
 *
 * M4-1 NOTE: who may *approve* is no longer decided here. Authz is decoupled from
 * the signed `payload.o` — the bot's cardAction gate authorises a clicker by
 * MEMBERSHIP in the configured allowlist (any of `ownerOpenIds`, N-of-1), not by
 * matching `payload.o`. This function still picks the single open id to *sign into*
 * the token (an integrity-carried value), but for an approval-gated chat it is the
 * allowlist — not `payload.o` — that gates approval. The empty-allowlist fallback
 * still gates on `payload.o` = initiator (initiator-only path unchanged).
 *
 * STRUCTURAL FIX (M4-1) of the M3a single-owner deadlock: because approval is now
 * N-of-1 over the whole allowlist, the turn no longer blocks just because
 * `ownerOpenIds[0]` is not in the group — any other listed member who IS in the
 * group can approve. A residual deadlock only remains if NONE of the listed members
 * are in the group (an operational misconfiguration, self-diagnosable via
 * `/whoami`). Leaving the allowlist empty falls back to initiator approval and can
 * never deadlock.
 */
export const resolveApprover = (
  runtimeMode: RuntimeMode,
  ownerOpenIds: ReadonlyArray<string>,
  initiatorOpenId: string,
): string =>
  runtimeMode === "approval-required" && ownerOpenIds.length > 0
    ? (ownerOpenIds[0] ?? initiatorOpenId)
    : initiatorOpenId;

/**
 * M3b: render density per runtime mode. A p2p 1:1 chat (`full-access`) is always
 * the full `card` layout; a group / topic chat (`approval-required`) honours the
 * configured `groupChatDensity` (default `card`; opt-in `markdown` / `text`).
 * Pure function of `(runtimeMode, groupChatDensity)` — lives here next to
 * `runtimeModeForChatType` / `resolveApprover` so the turn pipeline and renderer
 * derive density from one place. Default-no-auto-downgrade: only an explicit
 * config lowers a group below `card`, so p2p noise control is never affected.
 */
export const densityForRuntime = (
  runtimeMode: RuntimeMode,
  groupChatDensity: RenderDensity,
): RenderDensity => (runtimeMode === "full-access" ? "card" : groupChatDensity);

/**
 * M3a: the chat-key anchor for a Feishu inbound message.
 *
 * Returns the `larkThreadId` fragment that should be passed to
 * {@link compositeChatKey} to identify the t3code session backing this
 * message's conversation:
 *
 * - p2p → `undefined` (bare `chatId`, no thread, unchanged pre-M3a behaviour).
 * - topic group (`chatMode === "topic"`) → `larkThreadId` (the `omt_…` topic id).
 * - plain group: if the message is already inside a Feishu thread
 *   (`larkThreadId` non-empty) → `rootId ?? larkThreadId` so all follow-ups
 *   in the same thread route back to the same session; if it is a top-level
 *   message → `messageId` (the driveTurn reply_in_thread call will create a
 *   new thread rooted here).
 *
 * Single source of truth consumed by both the turn pipeline (`bot.ts`) and
 * the slash-command handlers (`commands/handlers.ts`) so both layers always
 * resolve the same composite key for the same message.
 *
 * NOTE: plain-group continuity hinges on in-thread `root_id` equalling the
 * first @bot message id — strongly implied by Feishu docs but pending e2e
 * confirmation.
 */
export const anchorOf = (message: InboundMessage): string | undefined => {
  if (message.chatType === "p2p") return undefined;
  if (message.chatMode === "topic") return message.larkThreadId;
  // plain group (chat_mode=group, or chatMode unresolved):
  return message.larkThreadId != null && message.larkThreadId !== ""
    ? (message.rootId ?? message.larkThreadId) // in a thread → anchor to its root
    : message.messageId; // top-level → become a new thread root
};

/**
 * Deterministically derive the {@link ThreadId} that backs a Feishu chat from
 * its composite key ({@link compositeChatKey}). Same conversation → same thread
 * id, *without* consulting the store, so a retried first message rebuilds the
 * identical thread id.
 *
 * This is what makes first-contact creation self-healing (the LOW finding):
 * `createThread`'s commandId is derived from `(chatId, threadId, messageId)`
 * (see {@link deriveCommandId}), so a stable `threadId` ⇒ a stable create
 * commandId. If `store.put` fails after a successful `createThread`, the chat's
 * next message re-derives the *same* `threadId` and the *same* create commandId;
 * the server's commandReceipt store dedups it instead of minting a second,
 * orphaned thread. (A random per-attempt id would defeat that dedup.)
 *
 * M3a degeneracy guarantee: when `larkThreadId` is `undefined`/empty the hash
 * input is the bare `chatId` (`compositeChatKey` returns it verbatim), so the
 * digest — and thus the `ThreadId` — is *byte-identical* to the pre-M3a
 * `sha256(chatId)`. This is what keeps every existing p2p / plain-group binding
 * intact (zero re-bind). Only a present `larkThreadId` changes the hash input
 * (to `` `${chatId}:${larkThreadId}` ``) and so yields a distinct per-topic id.
 *
 * `ThreadId` is a non-empty trimmed branded string (no UUID format required), so
 * a stable `feishu-<sha256(key)>` digest is a valid id.
 */
export const deriveThreadId = (chatId: string, larkThreadId?: string): ThreadId => {
  const digest = NodeCrypto.createHash("sha256")
    .update(compositeChatKey(chatId, larkThreadId), "utf8")
    .digest("hex");
  return ThreadId.make(`feishu-${digest}`);
};

/** Inputs needed to create a thread for a chat on first contact. */
export interface EnsureThreadDeps {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly modelSelection: ModelSelection;
  /**
   * Dispatch the `createThread` operation on the connected environment.
   * Integrate passes a thunk bound to `EnvironmentRegistry.run(environmentId, …)`
   * with the operation's `Crypto`/`EnvironmentSupervisor` requirements already
   * discharged, so this module stays decoupled from the registry's service shape.
   * Typed to `createThread`'s effect specifically (the only op this module runs).
   */
  readonly dispatch: (operation: ReturnType<typeof createThread>) => Effect.Effect<unknown>;
  /**
   * Mint a fresh random `ThreadId` (Integrate binds it to the platform crypto's
   * UUIDv4 generator).
   *
   * Retained for call-site signature stability; **no longer used on the create
   * path**, which now derives the thread id deterministically from `chatId`
   * (see {@link deriveThreadId}) so a retried first message rebuilds the same
   * id + the same create commandId and the server dedups it rather than minting
   * an orphaned second thread. A random per-attempt id would defeat that dedup.
   */
  readonly generateThreadId: Effect.Effect<ThreadId>;
}

/**
 * Resolve the thread bound to a Feishu conversation, creating + persisting one
 * on first contact. Returns the thread id and whether it was freshly created.
 *
 * M3a: the conversation is identified by the composite key
 * `(chatId, larkThreadId)` ({@link compositeChatKey}) — a topic (`omt_…`) inside
 * a group backs its own thread. p2p / plain-group callers pass
 * `larkThreadId === undefined`, which degenerates the key + derived id back to
 * the pre-M3a `chatId`-only behaviour byte-for-byte (zero re-bind). The binding
 * is read/written under that composite key; the `ThreadId` is derived from it.
 *
 * On a cache miss we **derive** the `ThreadId` deterministically from the
 * composite key (see {@link deriveThreadId}) — not a random id — then dispatch
 * {@link createThread} under a **stable** commandId derived from the
 * `(chatId, threadId, messageId)` triple, and finally persist the binding before
 * returning `{ created: true }`. (The `threadId` already encodes the topic, and
 * `messageId` is globally unique, so the create commandId is unique per topic.)
 *
 * Why deterministic: the binding is written *after* the create dispatch, so a
 * `bind` persist failure (or a crash) between the two leaves no persisted
 * binding. With a random id, the chat's *next* message would mint a fresh id and
 * create a *second*, orphaned thread (unstable create commandId ⇒ no server
 * dedup). With a derived id, the retry rebuilds the *identical* `threadId` and
 * create commandId, so the server's commandReceipt store recognises the
 * duplicate and returns the original thread instead of creating another.
 *
 * `runtimeMode` is injected by the caller (M3a parameterisation): the bot picks
 * it per chat type rather than this module hard-coding `"full-access"`.
 *
 * M2a: the binding is recorded through {@link BindingState} (the in-memory
 * authority, mirrored to the durable store). `bind` absorbs a persist failure
 * (logs, does not propagate), so this effect is total — the deterministic id +
 * idempotent create make a lost persist self-heal on the next message.
 */
export const ensureThreadForChat = (
  chatId: string,
  message: InboundMessage,
  deps: EnsureThreadDeps,
  runtimeMode: RuntimeMode,
  groupChatDensity: RenderDensity,
  larkThreadId?: string,
): Effect.Effect<EnsuredThread, never, BindingState> =>
  Effect.gen(function* () {
    // M2a: read/write the chat↔thread binding through the in-memory authority
    // (BindingState) rather than the durable store directly. `get` is total and
    // returns the full `ChatBinding`; `bind` mirrors the write to the store and
    // absorbs a persist failure (logged, not propagated), so this effect is
    // total. A self-create records the binding with origin `"self-created"`.
    const bindings = yield* BindingState;

    // M3a composite key. For p2p / plain-group (`larkThreadId === undefined`)
    // this is byte-identical to the bare `chatId`, so a pre-M3a on-disk binding
    // (key = chatId, no `:`) is hit unchanged — no migration, no re-bind.
    const chatKey = compositeChatKey(chatId, larkThreadId);

    const existing = yield* bindings.get(chatKey);
    if (existing !== null) {
      return { threadId: existing.threadId, created: false } satisfies EnsuredThread;
    }

    // Deterministic from the composite key so a retried first contact rebuilds
    // the same thread id (and thus the same create commandId) — the server dedups
    // instead of orphaning a second thread. `deps.generateThreadId` is
    // intentionally unused here (kept only for call-site signature stability).
    const threadId = deriveThreadId(chatId, larkThreadId);
    // Stable commandId keyed on the binding triple; `part: 1` keeps the
    // thread-create command's id distinct from the turn-start command derived
    // from the same Feishu message (which uses the default `part: 0`). The
    // composite-derived `threadId` already distinguishes topics, so passing the
    // bare `chatId` here keeps p2p commandIds byte-identical to pre-M3a.
    const commandId = deriveCommandId(chatId, threadId, message.messageId, 1);

    // `dispatch` is total (Integrate discharges the operation's requirements and
    // surfaces RPC/unavailable failures as defects). Persisted only after the
    // create dispatch returns; on a re-delivery the server dedups the (stable)
    // create commandId, so re-creating the same derived thread is a no-op.
    yield* deps.dispatch(
      createThread({
        commandId,
        threadId,
        projectId: deps.projectId,
        title: feishuChatTitle(chatId, message, larkThreadId),
        modelSelection: deps.modelSelection,
        runtimeMode,
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      }),
    );

    // Record the binding in the in-memory authority (mirrored to the store).
    // `bind` absorbs a persist failure (logged, not propagated): the deterministic
    // threadId + stable create commandId make a re-create idempotent, so a lost
    // persist self-heals on the next message rather than orphaning a thread.
    // M3b: stamp the binding with a topic reply anchor (the trigger message id —
    // it belongs to this topic thread and is a valid `reply_in_thread` replyTo,
    // unlike `anchorOf`'s `omt_` for a topic group) and the bind-time render
    // density, so trigger-less paths (shellWatcher chained approvals, observe
    // fresh card) post inside the topic and the placeholder first frame renders
    // at the right density (no placeholder→real density jump). p2p stamps a
    // harmless anchor (topicSendOpts no-ops when larkThreadId is undefined) and
    // density `card`.
    const density = densityForRuntime(runtimeMode, groupChatDensity);
    yield* bindings.bind(chatKey, {
      threadId,
      origin: "self-created",
      topicAnchorMessageId: message.messageId,
      density,
    });
    return { threadId, created: true } satisfies EnsuredThread;
  });

/**
 * Human-friendly thread title from the first message's sender / chat id. M3a:
 * when the conversation is a Feishu topic, append a short topic marker so the
 * title reflects which topic the thread backs (p2p / plain group omit it,
 * keeping the pre-M3a title byte-identical).
 */
const feishuChatTitle = (
  chatId: string,
  message: InboundMessage,
  larkThreadId?: string,
): string => {
  const who = message.senderName ?? message.senderId;
  const topic =
    larkThreadId !== undefined && larkThreadId !== ""
      ? ` · topic ${larkThreadId.slice(0, 12)}`
      : "";
  return `Feishu · ${who} (${chatId.slice(0, 12)})${topic}`;
};
