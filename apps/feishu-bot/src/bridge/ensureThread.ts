/**
 * First-contact thread resolution extracted from bot.ts.
 *
 * Owns the per-chat pending-create dedup and the get-or-create flow (online,
 * adopt-if-exists, and offline-buffered create) with the original bodies intact.
 *
 * SERIALIZATION PRECONDITION (§5.7): `ensureThread` is NOT internally serialized.
 * The caller MUST hold the assembly-owned `ensureLock` around each invocation
 * (`handleInbound` runs it under `ensureLock.withPermits(1)`) so two concurrent
 * first messages for an unbound chat cannot race into two threads (and, while
 * offline, cannot enqueue two conflicting `createThread`s). The lock itself
 * stays in bot.ts.
 */
import { createThread } from "@t3tools/client-runtime/operations";
import type { EnvironmentSupervisor } from "@t3tools/client-runtime/connection";
import { type EnvironmentId, type ProjectId, ThreadId } from "@t3tools/contracts";
import * as Console from "effect/Console";
import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import type { FeishuBotConfig } from "../config.ts";
import type { InboundMessage } from "../lark/types.ts";
import type { OutboundQueue } from "../bridge/outbound.ts";
import type { SentCommandStore } from "../runtime/persistence.ts";
import { BindingState } from "./bindingState.ts";
import {
  anchorOf,
  compositeChatKey,
  densityForRuntime,
  deriveThreadId,
  ensureThreadForChat,
  refusesFullAccessTakeover,
  runtimeModeForChatType,
} from "./chatThreadMap.ts";
import { deriveCommandId } from "./commandId.ts";
import {
  createRejectedNoticeText,
  noProviderNoticeText,
  runOfflineCreateFlush,
  workspaceCollisionOutlet,
} from "./createIntent.ts";
import { type RenderDensity } from "./eventRenderer.ts";
import { resolveModelSelection } from "./modelSelection.ts";
import type { ShellSnapshotCache } from "./shellCache.ts";
import type { SelectedWorkspace } from "./workspaceGate.ts";
import type { WorkspaceState } from "./workspaceState.ts";

/** Dependencies for one bound session's first-contact thread resolution. */
export interface EnsureThreadDeps {
  /** Mutable chat-to-thread binding state (in-memory authority). */
  readonly bindings: BindingState["Service"];
  /** Resident shell snapshot cache used for adopt-if-exists collision checks. */
  readonly shellCache: ShellSnapshotCache;
  /** Local idempotency ledger of dispatched command ids. */
  readonly sent: SentCommandStore["Service"];
  /** Outbound intent queue for offline-buffered creates. */
  readonly outbound: OutboundQueue["Service"];
  /** Point read of whether the environment is currently connected. */
  readonly isEnvReady: Effect.Effect<boolean>;
  /** Run an environment-scoped operation, discharging Crypto/Supervisor. */
  readonly runOnEnv: <A, E>(
    operation: Effect.Effect<A, E, Crypto.Crypto | EnvironmentSupervisor>,
  ) => Effect.Effect<A>;
  /** Generate a branded id (Crypto already discharged). */
  readonly genId: <A>(brand: { readonly make: (value: string) => A }) => Effect.Effect<A>;
  /** Send a static notice card to a conversation. */
  readonly sendNotice: (
    chatKey: string,
    text: string,
    replyToMessageId?: string,
  ) => Effect.Effect<void>;
  /** The bound session's environment id. */
  readonly environmentId: EnvironmentId;
  /** Env-default group/topic render density (bind-time STORE input). */
  readonly groupChatDensity: RenderDensity;
  /** The whole bot config (function body reads `config.modelOverride`). */
  readonly config: FeishuBotConfig;
  /** Per-chat selected-workspace authority (for the flush-time selection read). */
  readonly workspace: WorkspaceState["Service"];
  /** Resolve the chat's `/workspace` selection against the live snapshot. */
  readonly selectedWorkspaceFor: (chatKey: string) => Effect.Effect<SelectedWorkspace>;
  /** Dispatch-time workspace authorization gate (owner exempt). */
  readonly senderMayUseProjectAtDispatch: (
    message: InboundMessage,
    projectId: ProjectId,
  ) => Effect.Effect<boolean>;
  /** User-facing text for a not-"ok" workspace selection. */
  readonly workspaceGateText: (selected: SelectedWorkspace) => string;
  /** User-facing text for a workspace narrowed out of the chat's authorized set. */
  readonly workspaceRevokedText: string;
}

/** Handle returned by {@link makeEnsureThread}. */
export interface EnsureThreadHandle {
  readonly ensureThread: (message: InboundMessage) => Effect.Effect<ThreadId | null>;
  /** Read-only probe: is a create already buffered for this chat this session? */
  readonly hasPendingCreate: (chatKey: string) => Effect.Effect<boolean>;
}

/** Construct the first-contact thread resolver for one bound Feishu session. */
export const makeEnsureThread = (deps: EnsureThreadDeps): Effect.Effect<EnsureThreadHandle> =>
  Effect.gen(function* () {
    const {
      bindings,
      shellCache,
      sent,
      outbound,
      isEnvReady,
      runOnEnv,
      genId,
      sendNotice,
      environmentId,
      groupChatDensity,
      config,
      workspace,
      selectedWorkspaceFor,
      senderMayUseProjectAtDispatch,
      workspaceGateText,
      workspaceRevokedText,
    } = deps;

    // Chats with an offline `createThread` already buffered this session, so a
    // *second* offline message for the same brand-new chat does not enqueue a
    // second create (which would hit the server's "thread already exists"
    // invariant — distinct create commandIds, same deterministic threadId). The
    // binding is persisted by the create intent *on success* (not optimistically),
    // so this in-memory set and the in-memory outbound queue are lost together on
    // a crash — a restart then re-creates the thread cleanly rather than pointing
    // a persisted binding at a thread that was never created.
    const pendingCreates = yield* Ref.make<ReadonlySet<string>>(new Set());

    // Review fix C①: `/workspace switch` gate 3 — a buffered first-contact
    // create captured its project at buffer time, so the selection must not
    // change out from under it while it waits for the reconnect flush.
    const hasPendingCreate = (chatKey: string): Effect.Effect<boolean> =>
      Ref.get(pendingCreates).pipe(Effect.map((set) => set.has(chatKey)));

    /**
     * Resolve the chat's bound thread, creating one on first contact. Serialised
     * under `ensureLock` so two concurrent first messages can't race into two
     * threads (and, while offline, can't enqueue two conflicting `createThread`s).
     *
     * Always returns the chat's threadId. The threadId is *deterministic* from the
     * chatId (`deriveThreadId`) — the same value the persistent binding holds and
     * the same value the turn queue resolves for the stable commandId — so the
     * merged dispatch's commandId is correct whether or not the binding has been
     * persisted yet.
     *
     * Outcomes:
     *  - already bound → the bound `threadId`.
     *  - unbound + no valid workspace selection (M-1) → notice + `null` (the
     *    handleInbound gate is the first line; this re-check is authoritative
     *    at create time — the project may have been deleted in between).
     *  - unbound + the deterministic threadId already EXISTS on the server
     *    (M-1 adopt-if-exists): same project → re-bind to it (no create);
     *    other project / archived → notice + `null` (the server rejects a
     *    create for an existing id — `requireThreadAbsent` — and
     *    `deriveThreadId` is intentionally project-agnostic, so the id cannot
     *    be re-minted under the new workspace).
     *  - unbound + ready → online `createThread` + persist → the new `threadId`.
     *    A mid-create environment drop falls back to the offline buffer.
     *  - unbound + offline → ⏳/notice + buffered create intent (binding persisted
     *    on flush success) → the (deterministic) `threadId`. The turn is buffered
     *    separately by `runTurn`'s offline branch. The buffered create resolves
     *    its model selection at FLUSH time (the resolve needs a live RPC).
     */
    const ensureThread = (message: InboundMessage): Effect.Effect<ThreadId | null> =>
      Effect.gen(function* () {
        // M3a: a Feishu topic backs its own thread, so every binding op keys on the
        // composite `chatId[:larkThreadId]` (byte-identical to the bare chatId for
        // p2p / plain group). `runtimeMode` is per chat type (p2p full-access;
        // group/topic approval-required) and injected into both create paths.
        const larkThreadId = anchorOf(message);
        const chatKey = compositeChatKey(message.chatId, larkThreadId);
        const runtimeMode = runtimeModeForChatType(message.chatType);

        // M2a: resolve the chat's *current* binding from the in-memory authority
        // (BindingState), not the store directly. A `/resume` takeover may have
        // re-pointed this chat at another end's thread (origin "resumed"); either
        // origin is honoured here by using the binding's threadId verbatim.
        const existing = yield* bindings.get(chatKey);
        if (existing !== null) {
          // NOTE (M-3 p2p-density): a legacy binding that predates `chatIsP2p` is
          // deliberately NOT re-stamped here. A read-modify-write on this hot path is
          // not atomic w.r.t. a concurrent `/resume` re-bind (which does not hold
          // `ensureLock`; see the offer comment below), so it could clobber a fresh
          // takeover binding with a stale snapshot — a real data loss to fix a merely
          // cosmetic gap. Unstamped bindings resolve density via the `full-access ⟹
          // p2p` heuristic (`rendersAtP2pDensity`), which is correct for the common
          // fresh-p2p case; the only residual is a pre-PR binding whose thread mode was
          // later flipped on the web — a narrow density mismatch that clears when the
          // binding is next re-created. New bindings are all stamped at bind time.
          return existing.threadId;
        }

        // M-1 dispatch-time workspace re-check (second line; the handleInbound
        // gate already screened, but the project can be deleted between the two).
        const selected = yield* selectedWorkspaceFor(chatKey);
        if (selected.kind !== "ok") {
          yield* sendNotice(chatKey, workspaceGateText(selected), message.messageId);
          return null;
        }
        // M-3: even a live "ok" selection may have been narrowed out of the chat's
        // authorized set since it was chosen (a config change). Refuse rather than
        // create a thread on a now-unauthorized workspace. Owner exempt.
        if (!(yield* senderMayUseProjectAtDispatch(message, selected.project.id))) {
          yield* sendNotice(chatKey, workspaceRevokedText, message.messageId);
          return null;
        }
        const project = selected.project;

        // First contact. Derive the deterministic threadId up front so both the
        // online and offline create paths agree on it (and on the stable create
        // commandId), making re-delivery idempotent against the server. The topic
        // is folded into the derivation so a topic gets a distinct thread id.
        const threadId = deriveThreadId(message.chatId, larkThreadId);

        // M-1 adopt-if-exists. The server REJECTS a create whose threadId
        // already exists (`requireThreadAbsent`, commandInvariants.ts) — and a
        // thread with this derived id can only have been self-created by an
        // earlier epoch of this very conversation (before a `/release`). So:
        //   - live + same project  → re-bind (adopt), no create dispatched;
        //     this also heals the plain `/release` → next-message flow, which
        //     would otherwise create-collide and wedge in the offline buffer.
        //   - live + other project → refuse: the deterministic id is taken
        //     (`deriveThreadId` stays project-agnostic by design — the M3a
        //     zero-re-bind red line), so this conversation cannot self-create
        //     under the newly selected workspace. `/resume` still works.
        //   - archived             → refuse (the create would be rejected, and
        //     an archived thread cannot run turns). NOTE: normally UNREACHABLE
        //     — the shell snapshot does not carry archived/deleted threads —
        //     kept as a defensive fast path; the authoritative backstop for
        //     "id occupied by a thread the snapshot cannot see" is the
        //     rejected-create disposition below (review fix B).
        // Reads the last-known shell snapshot — present whenever the M-1 gate
        // above passed (an "ok" selection implies a seeded snapshot).
        const collided = yield* shellCache.threadById(threadId);
        if (collided !== null) {
          if (collided.archivedAt !== null) {
            yield* sendNotice(
              chatKey,
              "此对话之前的会话已归档,无法在同一对话中自动重建(会话 ID 由对话唯一决定)。" +
                workspaceCollisionOutlet(message.chatType),
              message.messageId,
            );
            return null;
          }
          if (collided.projectId !== project.id) {
            yield* sendNotice(
              chatKey,
              "此对话之前已在另一个工作区创建过会话,无法在当前工作区新建(会话 ID 由对话唯一决定)。" +
                workspaceCollisionOutlet(message.chatType),
              message.messageId,
            );
            return null;
          }
          // Review fix D: the adopt re-bind is a takeover like `/resume`, so it
          // must honour the SAME M3a full-access gate (shared predicate) — a
          // group/topic chat must not silently re-bind a full-access thread.
          if (refusesFullAccessTakeover(runtimeMode, collided.runtimeMode)) {
            yield* sendNotice(
              chatKey,
              "⚠️ 此对话的历史会话为 full-access(全权限)模式,群聊/话题不可重新绑定全权限会话,以免无人值守执行破坏性操作。请在 web 端处理该会话,或在新话题中开始。",
              message.messageId,
            );
            return null;
          }
          yield* bindings.bind(chatKey, {
            threadId,
            origin: "self-created",
            topicAnchorMessageId: message.messageId,
            density: densityForRuntime(runtimeMode, groupChatDensity),
            // M-3 p2p-density: stamp private-ness from the chat's native mode (see
            // `ensureThreadForChat`), so `resolveDensity` keeps honouring `p2pDensity`.
            chatIsP2p: runtimeMode === "full-access",
          });
          yield* Console.log(
            `[feishu-bot] re-bound chat ${message.chatId} to its existing thread ${threadId}.`,
          );
          return threadId;
        }

        // Un-mark this chat's pending-create dedup (review fixes A/B/C: a
        // DROPPED intent must release the dedup so the chat's next message can
        // attempt a fresh create instead of being deduped against a corpse).
        const clearPendingCreate = Ref.update(pendingCreates, (set) => {
          if (!set.has(chatKey)) {
            return set;
          }
          const next = new Set(set);
          next.delete(chatKey);
          return next;
        });

        // Offline first contact (MEDIUM): visible ⏳ receipt + notice, then buffer
        // the `createThread` as an outbound intent that persists the binding *on
        // success* (not optimistically — see `pendingCreates`). The turn itself is
        // buffered separately by `runTurn`'s offline branch; intents flush in FIFO
        // order, so the create runs before any turn. A second offline message for
        // the same chat must NOT buffer a second create (it would hit the server's
        // "thread already exists" invariant), so we dedup on `pendingCreates`.
        const bufferOfflineCreate = Effect.gen(function* () {
          const firstCreate = yield* Ref.modify(
            pendingCreates,
            (set): readonly [boolean, ReadonlySet<string>] =>
              set.has(chatKey) ? [false, set] : [true, new Set(set).add(chatKey)],
          );
          // Fix 5: the ⏳ receipt answers the user's just-sent message, so anchor it
          // into the topic (composite `chatKey` + the message id); p2p / plain group
          // degrade to the root (byte-identical).
          yield* sendNotice(
            chatKey,
            "⏳ The server is not connected right now — your message is queued and will be sent once it reconnects.",
            message.messageId,
          );
          if (!firstCreate) {
            // A create for this brand-new chat is already buffered; its flush
            // persists the binding. This message only needs its turn buffered.
            yield* Console.log(
              `[feishu-bot] environment offline; create already buffered for chat ${message.chatId}, queuing turn only (⏳).`,
            );
            return threadId;
          }
          yield* Console.log(
            `[feishu-bot] environment offline on first contact; buffering create+turn for chat ${message.chatId} (⏳).`,
          );
          const createCommandId = deriveCommandId(message.chatId, threadId, message.messageId, 1);
          yield* outbound.enqueue({
            commandId: createCommandId,
            feishuMessageId: message.messageId,
            // Create THEN persist the binding — only a created thread gets a
            // binding, so a crash before the flush leaves no binding pointing at
            // a missing thread. The flush flow lives in `bridge/createIntent.ts`
            // (review fixes A/B/C②): the model selection is resolved at FLUSH
            // time (needs a live RPC; T3_MODEL override still wins inside), the
            // selection is re-validated against the CURRENT `/workspace` choice,
            // and a failure while the environment is READY (provider-less
            // server, `requireThreadAbsent` rejection) is a terminal, VISIBLE
            // drop — never an eternal carry-over; only a genuine mid-flush
            // env drop raises `OfflineRetry` (queue keeps the intent + ⏳).
            run: runOfflineCreateFlush({
              chatKey,
              chatType: message.chatType,
              replyToMessageId: message.messageId,
              projectId: project.id,
              getSelectedProject: workspace.get(chatKey),
              resolveModel: runOnEnv(
                resolveModelSelection(project.defaultModelSelection, config.modelOverride),
              ),
              dispatchCreate: (flushModelSelection) =>
                runOnEnv(
                  createThread({
                    commandId: createCommandId,
                    threadId,
                    projectId: project.id,
                    title: `Feishu · ${message.senderName ?? message.senderId} (${message.chatId.slice(0, 12)})`,
                    modelSelection: flushModelSelection,
                    // M3a: p2p stays full-access; group/topic creates an
                    // approval-required thread (matches the online create path).
                    runtimeMode,
                    interactionMode: "default",
                    branch: null,
                    worktreePath: null,
                  }),
                ),
              // Bind through the in-memory authority (BindingState), which also
              // mirrors the write to the durable store and absorbs a persist
              // failure (logged, not propagated) — so the create flush stays
              // total and the next message resolves the binding from memory.
              // M3b: store the trigger message id as the topic reply anchor and
              // the bind-time density (see `ensureThreadForChat` for the full
              // rationale); p2p stores them harmlessly.
              bindChat: bindings.bind(chatKey, {
                threadId,
                origin: "self-created",
                topicAnchorMessageId: message.messageId,
                density: densityForRuntime(runtimeMode, groupChatDensity),
                // M-3 p2p-density: stamp private-ness from the chat's native mode.
                chatIsP2p: runtimeMode === "full-access",
              }),
              isEnvReady,
              clearPendingCreate,
              sendNotice,
            }),
          });
          return threadId;
        });

        const ready = yield* isEnvReady;
        if (!ready) {
          return yield* bufferOfflineCreate;
        }

        // M-1: resolve the model selection for THIS create from the selected
        // project's default (T3_MODEL override wins inside). Captured as an
        // exit; the disposition (review fix A) hinges on a READINESS RE-READ:
        //  - env no longer ready → a genuine mid-resolve drop (TOCTOU with
        //    `isEnvReady`) → offline buffer (the reconnect edge WILL flush it);
        //  - env still ready → a provider-less server. Buffering would be a
        //    LIE: the flush is edge-triggered on reconnect, and an environment
        //    that never dropped never re-fires it — the intent (and its "queued"
        //    receipt) would hang forever while the live turn dispatches against
        //    a thread that was never created (defect → message lost). Fail
        //    HONESTLY instead: notice + no thread, no queue, `null`.
        const selectionExit = yield* runOnEnv(
          resolveModelSelection(project.defaultModelSelection, config.modelOverride),
        ).pipe(Effect.exit);
        if (selectionExit._tag === "Failure") {
          if (!(yield* isEnvReady)) {
            yield* Effect.logWarning(
              `[feishu-bot] environment dropped mid model-resolution for chat ${message.chatId}; falling back to offline buffer.`,
              selectionExit.cause,
            );
            return yield* bufferOfflineCreate;
          }
          yield* Effect.logWarning(
            `[feishu-bot] model resolution failed for chat ${message.chatId} while connected (no ready provider?); refusing the message visibly.`,
            selectionExit.cause,
          );
          yield* sendNotice(chatKey, noProviderNoticeText, message.messageId);
          return null;
        }
        const modelSelection = selectionExit.value;

        // Online first contact. Attempt `createThread` + persist now. Capture the
        // exit so a mid-create environment drop (a TOCTOU between `isEnvReady` and
        // the dispatch — `runOnEnv` would orDie it into a defect) falls back to the
        // offline buffer instead of silently dropping the user's first message.
        const ensuredExit = yield* ensureThreadForChat(
          message.chatId,
          message,
          {
            environmentId,
            projectId: project.id,
            modelSelection,
            dispatch: runOnEnv,
            generateThreadId: genId(ThreadId),
          },
          // M3a: per-chat-type runtimeMode + topic id (forms the composite binding
          // key + the topic-aware thread id derivation inside the helper).
          runtimeMode,
          groupChatDensity,
          larkThreadId,
        ).pipe(Effect.provideService(BindingState, bindings), Effect.exit);

        if (ensuredExit._tag === "Failure") {
          // Same readiness-re-read disposition as the resolve above (review fix
          // B backstop): a mid-create env drop buffers (the reconnect edge will
          // replay it); a rejection while STILL CONNECTED is the server actively
          // refusing the create (dominantly `requireThreadAbsent`: the
          // deterministic id is occupied by an archived/deleted thread the
          // shell snapshot cannot show) — retrying or buffering can never
          // succeed, so fail visibly instead of wedging in the queue.
          if (!(yield* isEnvReady)) {
            yield* Effect.logWarning(
              `[feishu-bot] online first-contact create failed for chat ${message.chatId} (environment dropped); falling back to offline buffer.`,
              ensuredExit.cause,
            );
            return yield* bufferOfflineCreate;
          }
          yield* Effect.logWarning(
            `[feishu-bot] server rejected first-contact create for chat ${message.chatId}; refusing the message visibly.`,
            ensuredExit.cause,
          );
          yield* sendNotice(chatKey, createRejectedNoticeText(message.chatType), message.messageId);
          return null;
        }
        // M9: record the (stable) create commandId locally on a fresh create so a
        // crash-recovery replay short-circuits instead of re-dispatching (the
        // server's commandReceipt store is the authoritative second line). The
        // triple mirrors `ensureThreadForChat`'s internal derivation (part: 1).
        if (ensuredExit.value.created) {
          const createCommandId = deriveCommandId(message.chatId, threadId, message.messageId, 1);
          yield* sent.add(createCommandId).pipe(Effect.ignore);
        }
        return ensuredExit.value.threadId;
      });

    return { ensureThread, hasPendingCreate } as const;
  });
