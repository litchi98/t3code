/**
 * First-contact create-intent flush flow + failure-disposition texts (M-1
 * review fixes A/B/C/F).
 *
 * The outbound compensation queue's contract (see `bridge/outbound.ts`) is:
 * an intent whose `run` FAILS is carried over and retried on the next flush;
 * an intent whose `run` SUCCEEDS is recorded as sent and its ⏳ receipt
 * cleared. Flushes are edge-triggered on the environment's reconnect — so an
 * intent that can never succeed while the environment stays connected (no
 * ready provider, a server-side `requireThreadAbsent` rejection, a stale
 * workspace selection) must NOT signal a retry: there may never be another
 * flush edge, and the ⏳ would be a permanent lie. The invariant this module
 * enforces:
 *
 *   **never silently drop a message, never silently retry forever** — a
 *   failure is either a genuine "environment dropped again" (→ typed
 *   {@link OfflineRetry}, the queue keeps the intent + ⏳ for the next
 *   reconnect edge) or a terminal rejection (→ the intent is consumed, the
 *   user gets an honest notice telling them the message was NOT processed).
 *
 * The disposition test is `isEnvReady` re-read AFTER the failure: still ready
 * ⇒ the server actively refused (terminal); not ready ⇒ the env dropped
 * mid-flush (retry). The same test — and the same notice texts — are used by
 * `bot.ts`'s ONLINE first-contact path, which must equally not fake-queue a
 * message the flush machinery would never deliver.
 *
 * Extracted from `bot.ts` (closure) into an injected-deps module so the
 * dispositions are unit-testable without a live bridge.
 */
import type { ModelSelection, ProjectId } from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

/**
 * "Still offline — retry me" signal. A buffered intent raised by the outbound
 * flush fails with this when the environment dropped again mid-flush, so the
 * outbound queue keeps the intent (+ its ⏳) and retries on a later flush
 * rather than recording it as sent. Internal to the bridge; never escapes a
 * handler. (Moved here from `bot.ts` so this module can raise it directly.)
 */
export class OfflineRetry extends Data.TaggedError("OfflineRetry") {}

/**
 * Honest notice for "the environment is connected but no ready model provider
 * exists": the message was NOT queued (a queued intent would wait for a
 * reconnect edge that may never come) and must be re-sent once a provider is
 * configured.
 */
export const noProviderNoticeText =
  "服务器当前没有可用的模型 provider,本条消息未处理;请在 web 端配置 provider 后重新发送。";

/**
 * Honest notice for a buffered create whose chat switched workspaces while the
 * intent sat in the queue (fix C②): dispatching the OLD project would silently
 * diverge from the visible selection, so the intent is dropped instead.
 */
export const staleSelectionNoticeText =
  "排队期间该对话已切换工作区,这条排队消息未处理;请重新发送。";

/**
 * Per-chat-type outlet line for "this conversation's deterministic thread id
 * is already taken" (fix F). A p2p chat has no "new topic" escape and
 * `/resume` only reaches threads that already exist in the target workspace —
 * so it is pointed at the web end; a group/topic chat can also just open a
 * fresh topic.
 */
export const workspaceCollisionOutlet = (chatType: string): string =>
  chatType === "p2p"
    ? "可先在 web 端于目标工作区发起会话,再回来用 /resume 接管。"
    : "可用 /resume 接管当前工作区的会话,或在新话题中重新开始。";

/**
 * Honest notice for a server-side createThread rejection while the environment
 * is connected (fix B backstop). The dominant cause is `requireThreadAbsent`:
 * the deterministic thread id is occupied by an archived/deleted thread the
 * shell snapshot cannot see, so the bot-side adopt-if-exists fast path never
 * fired. Retrying can never succeed → terminal, visible failure.
 */
export const createRejectedNoticeText = (chatType: string): string =>
  "会话创建被服务器拒绝(该对话的会话 ID 可能已被已归档或已删除的历史会话占用)。" +
  workspaceCollisionOutlet(chatType);

/**
 * Honest notice for a server-side turn.start rejection (fix A③ / turn-intent
 * backstop): the dispatch was actively refused (e.g. the thread does not
 * exist), so the message is dropped VISIBLY instead of orDie-ing the fiber
 * (live path) or carrying the intent over forever (flush path).
 */
export const turnRejectedNoticeText =
  "服务器拒绝了本条消息的派发,消息未处理;请检查会话状态(/status)后重新发送。";

/** Dependencies of one buffered first-contact create intent (all pre-bound to
 *  the chat: effects, not chat-parameterised functions, except the notice). */
export interface OfflineCreateFlushDeps {
  /** Composite conversation key the intent belongs to. */
  readonly chatKey: string;
  /** Feishu chat type (drives the fix-F outlet text). */
  readonly chatType: string;
  /** The triggering message id (notice reply anchor). */
  readonly replyToMessageId: string;
  /** The project the create was buffered FOR (captured at buffer time). */
  readonly projectId: ProjectId;
  /** Current selection for this chat (fix C②: re-read at flush time). */
  readonly getSelectedProject: Effect.Effect<ProjectId | null>;
  /** Resolve the model selection (live RPC; may die when offline/provider-less). */
  readonly resolveModel: Effect.Effect<ModelSelection>;
  /** Dispatch the createThread with the flush-resolved selection (may die). */
  readonly dispatchCreate: (modelSelection: ModelSelection) => Effect.Effect<unknown>;
  /** Persist the chat↔thread binding after a successful create. */
  readonly bindChat: Effect.Effect<void>;
  /** Whether the t3code environment is currently connected. */
  readonly isEnvReady: Effect.Effect<boolean>;
  /** Un-mark this chat's pending-create dedup so a fresh message can retry. */
  readonly clearPendingCreate: Effect.Effect<void>;
  /** Send a notice card to the chat (total; failures already swallowed). */
  readonly sendNotice: (
    chatKey: string,
    text: string,
    replyToMessageId?: string,
  ) => Effect.Effect<void>;
}

/**
 * The `run` effect of a buffered first-contact create intent.
 *
 * Success ⇒ the outbound queue consumes the intent (clears ⏳). A terminal
 * rejection is therefore modelled as SUCCESS-after-notice (+
 * `clearPendingCreate`, so the chat's next message may attempt a fresh
 * create); only a genuine "environment dropped again" raises
 * {@link OfflineRetry} so the queue carries the intent to the next reconnect
 * edge. See the module doc for the disposition rule.
 */
export const runOfflineCreateFlush = (
  deps: OfflineCreateFlushDeps,
): Effect.Effect<void, OfflineRetry> =>
  Effect.gen(function* () {
    // Fix C②: the chat may have `/workspace switch`ed while this intent sat in
    // the buffer. Creating under the OLD project would silently contradict the
    // visible selection — drop honestly instead.
    const nowSelected = yield* deps.getSelectedProject;
    if (nowSelected !== deps.projectId) {
      yield* deps.clearPendingCreate;
      yield* deps.sendNotice(deps.chatKey, staleSelectionNoticeText, deps.replyToMessageId);
      return;
    }

    // Fix A (flush side): resolve the model NOW (needs a live RPC). On failure,
    // re-read readiness — dropped again ⇒ retry on the next edge; still ready
    // ⇒ provider-less server, terminal (another flush edge may never come).
    const modelExit = yield* Effect.exit(deps.resolveModel);
    if (modelExit._tag === "Failure") {
      if (!(yield* deps.isEnvReady)) {
        return yield* new OfflineRetry();
      }
      yield* Effect.logWarning(
        `[feishu-bot] flush-time model resolution failed for chat ${deps.chatKey}; dropping the create intent with a notice.`,
        modelExit.cause,
      );
      yield* deps.clearPendingCreate;
      yield* deps.sendNotice(deps.chatKey, noProviderNoticeText, deps.replyToMessageId);
      return;
    }

    // Fix B backstop: a create the server actively rejects (requireThreadAbsent
    // — the deterministic id is occupied by an archived/deleted thread the
    // shell snapshot cannot show — or a previously-rejected receipt) can never
    // succeed by retrying. Terminal + visible; never carry over.
    const createExit = yield* Effect.exit(deps.dispatchCreate(modelExit.value));
    if (createExit._tag === "Failure") {
      if (!(yield* deps.isEnvReady)) {
        return yield* new OfflineRetry();
      }
      yield* Effect.logWarning(
        `[feishu-bot] server rejected the buffered createThread for chat ${deps.chatKey}; dropping the intent with a notice.`,
        createExit.cause,
      );
      yield* deps.clearPendingCreate;
      yield* deps.sendNotice(
        deps.chatKey,
        createRejectedNoticeText(deps.chatType),
        deps.replyToMessageId,
      );
      return;
    }

    // Create THEN persist the binding — only a created thread gets a binding
    // (same ordering as the pre-extraction inline flow).
    yield* deps.bindChat;
  });
