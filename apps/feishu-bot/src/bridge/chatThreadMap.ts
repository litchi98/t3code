/**
 * Chat ↔ thread binding (M1).
 *
 * Resolves the t3code thread that backs a Feishu chat, creating one (and
 * persisting the binding via {@link ChatThreadMapStore}) on the chat's first
 * message. This is what makes the conversation a true shared session: a
 * returning chat re-uses its thread across restarts.
 *
 * The store interface lives in `runtime/persistence.ts`; the `createThread`
 * dispatch is injected via {@link EnsureThreadDeps} so this module stays
 * decoupled from the registry's service shape. The `ThreadId` itself is derived
 * deterministically from the `chatId` ({@link deriveThreadId}) so first-contact
 * creation is idempotent across retries (see {@link ensureThreadForChat}).
 */
import * as NodeCrypto from "node:crypto";

import { createThread } from "@t3tools/client-runtime/operations";
import {
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { ChatThreadMapStore, type FeishuBotPersistenceError } from "../runtime/persistence.ts";
import { deriveCommandId } from "./commandId.ts";
import type { EnsuredThread } from "./types.ts";
import type { InboundMessage } from "../lark/types.ts";

/**
 * Deterministically derive the {@link ThreadId} that backs a Feishu chat from
 * its `chatId`. Same chat → same thread id, *without* consulting the store, so a
 * retried first message rebuilds the identical thread id.
 *
 * This is what makes first-contact creation self-healing (the LOW finding):
 * `createThread`'s commandId is derived from `(chatId, threadId, messageId)`
 * (see {@link deriveCommandId}), so a stable `threadId` ⇒ a stable create
 * commandId. If `store.put` fails after a successful `createThread`, the chat's
 * next message re-derives the *same* `threadId` and the *same* create commandId;
 * the server's commandReceipt store dedups it instead of minting a second,
 * orphaned thread. (A random per-attempt id would defeat that dedup.)
 *
 * `ThreadId` is a non-empty trimmed branded string (no UUID format required), so
 * a stable `feishu-<sha256(chatId)>` digest is a valid id.
 */
export const deriveThreadId = (chatId: string): ThreadId => {
  const digest = NodeCrypto.createHash("sha256").update(chatId, "utf8").digest("hex");
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
 * Resolve the thread bound to `chatId`, creating + persisting one on first
 * contact. Returns the thread id and whether it was freshly created.
 *
 * On a cache miss we **derive** the `ThreadId` deterministically from `chatId`
 * (see {@link deriveThreadId}) — not a random id — then dispatch
 * {@link createThread} under a **stable** commandId derived from that same
 * `(chatId, threadId, messageId)` triple, and finally persist the
 * `chatId → threadId` binding before returning `{ created: true }`.
 *
 * Why deterministic: the binding is written *after* the create dispatch, so a
 * `store.put` failure (or a crash) between the two leaves no persisted binding.
 * With a random id, the chat's *next* message would mint a fresh id and create a
 * *second*, orphaned thread (unstable create commandId ⇒ no server dedup). With
 * a derived id, the retry rebuilds the *identical* `threadId` and create
 * commandId, so the server's commandReceipt store recognises the duplicate and
 * returns the original thread instead of creating another.
 *
 * The `put` failure is *not* swallowed: it stays in the `FeishuBotPersistenceError`
 * channel so the caller logs/alerts (and the user can resend — safely, thanks to
 * the deterministic id + idempotent create).
 */
export const ensureThreadForChat = (
  chatId: string,
  message: InboundMessage,
  deps: EnsureThreadDeps,
): Effect.Effect<EnsuredThread, FeishuBotPersistenceError, ChatThreadMapStore> =>
  Effect.gen(function* () {
    const store = yield* ChatThreadMapStore;

    const existing = yield* store.get(chatId);
    if (Option.isSome(existing)) {
      return { threadId: existing.value, created: false } satisfies EnsuredThread;
    }

    // Deterministic from `chatId` so a retried first contact rebuilds the same
    // thread id (and thus the same create commandId) — the server dedups instead
    // of orphaning a second thread. `deps.generateThreadId` is intentionally
    // unused here (kept only for call-site signature stability).
    const threadId = deriveThreadId(chatId);
    // Stable commandId keyed on the binding triple; `part: 1` keeps the
    // thread-create command's id distinct from the turn-start command derived
    // from the same Feishu message (which uses the default `part: 0`).
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
        title: feishuChatTitle(chatId, message),
        modelSelection: deps.modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      }),
    );

    // Surface a persist failure (do NOT collapse to `none`): the binding write
    // failed, so the next message must be able to re-derive + re-create safely.
    // Kept in the error channel for the caller to log/alert.
    yield* store.put(chatId, threadId);
    return { threadId, created: true } satisfies EnsuredThread;
  });

/** Human-friendly thread title from the first message's sender / chat id. */
const feishuChatTitle = (chatId: string, message: InboundMessage): string => {
  const who = message.senderName ?? message.senderId;
  return `Feishu · ${who} (${chatId.slice(0, 12)})`;
};
