/**
 * Notice-card helpers extracted from bot.ts.
 *
 * Owns placeholder-thread construction and static notice rendering while the
 * bridge split keeps the original rendering behaviour intact.
 */
import {
  MessageId,
  ModelSelection,
  type OrchestrationMessage,
  type OrchestrationThread,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { renderThreadCard } from "./eventRenderer.ts";
import { splitChatKey } from "./chatThreadMap.ts";
import type { LarkGateway } from "../lark/index.ts";
import type { SendOptions } from "../lark/types.ts";

/**
 * Decode a `TrimmedNonEmptyString`. Compiled once at module scope (the schema's
 * decoder is rebuilt on every call site otherwise). Used only for the
 * statically-valid placeholder title, so callers `Effect.orDie` the result.
 */
const decodeTrimmedNonEmpty = Schema.decodeEffect(TrimmedNonEmptyString);

/**
 * Decode a {@link ModelSelection} from a plain literal. Compiled once at module
 * scope. Used only for the statically-valid placeholder selection (M-1: the
 * placeholder thread no longer inherits a startup project/model), so callers
 * `Effect.orDie` the result.
 */
const decodeModelSelection = Schema.decodeUnknownEffect(ModelSelection);

// ── M3a (group + topic) routing helpers ──────────────────────────────────────

/**
 * Build the SDK {@link SendOptions} that post a streaming card *inside* a Feishu
 * topic or plain-group thread (M3a). Only produced when BOTH an anchor
 * (`larkThreadId`, non-undefined for topic / in-thread plain-group turns) and a
 * reply target (`replyTo`, the triggering message) are known — Feishu requires
 * `replyTo` to anchor the card inside the thread. Otherwise `undefined`, which
 * posts at the chat root (pre-M3a behaviour, and the acceptable degradation for
 * the observe path which has no triggering message). p2p always yields `undefined`
 * (`anchorOf` returns `undefined` for p2p, so no `larkThreadId` is ever set).
 * Plain-group and topic turns carry the composite anchor (rootId / messageId) and
 * post with `replyInThread: true`, which is also why plain-group turns require
 * topic mode (Feishu error 230071 otherwise).
 */
export const topicSendOpts = (
  larkThreadId: string | undefined,
  replyTo: string | undefined,
): SendOptions | undefined =>
  larkThreadId !== undefined && replyTo !== undefined
    ? { replyTo, replyInThread: true }
    : undefined;

/** Dependencies for constructing the notice helpers. */
export interface NoticesDeps {
  readonly gateway: LarkGateway["Service"];
  readonly genId: <A>(brand: { readonly make: (value: string) => A }) => Effect.Effect<A>;
}

/** Handle returned by {@link makeNotices}. */
export interface NoticesHandle {
  readonly placeholderThread: OrchestrationThread;
  readonly makeNoticeThread: (text: string) => OrchestrationThread;
  readonly sendNotice: (
    chatKey: string,
    text: string,
    replyToMessageId?: string,
  ) => Effect.Effect<void>;
  readonly renderTranscriptMarkdown: (
    messages: ReadonlyArray<OrchestrationMessage>,
  ) => string | null;
  readonly updateCardNotice: (messageId: string, text: string) => Effect.Effect<void>;
}

/** Construct notice-card helpers for one bound Feishu session. */
export const makeNotices = (deps: NoticesDeps): Effect.Effect<NoticesHandle> =>
  Effect.gen(function* () {
    const { gateway, genId } = deps;

    // A minimal, schema-valid `OrchestrationThread` used as the seed for the
    // first card render (before any tick) and as the envelope for static notice
    // cards. Built once from real branded ids + the resolved model selection, so
    // it satisfies every required field with proper types — no `as unknown`
    // cast. `renderThreadCard` only reads `messages`/`activities`/`session`; the
    // rest is well-typed filler.
    // A statically-valid constant; a decode failure here would be a programmer
    // error, so surface it as a defect rather than threading `SchemaError`.
    const placeholderTitle = yield* decodeTrimmedNonEmpty("feishu-bot").pipe(Effect.orDie);
    const placeholderTimestamp = "1970-01-01T00:00:00.000Z";
    const placeholderThreadId = yield* genId(ThreadId);
    const placeholderMessageId = yield* genId(MessageId);
    // M-1: with no startup project the placeholder carries *synthetic* ids. It
    // is a local render seed only — `renderThreadCard` reads
    // `messages`/`activities`/`session` and never the project/model fields, and
    // the workspace gate guarantees a real selected project exists before any
    // real thread render replaces this seed. The decode is statically valid, so
    // a failure is a programmer error (defect), same as `placeholderTitle`.
    const placeholderProjectId = yield* genId(ProjectId);
    const placeholderModelSelection = yield* decodeModelSelection({
      instanceId: "feishu-bot",
      model: "placeholder",
    }).pipe(Effect.orDie);
    const placeholderThread: OrchestrationThread = {
      id: placeholderThreadId,
      projectId: placeholderProjectId,
      title: placeholderTitle,
      modelSelection: placeholderModelSelection,
      // Safe default for the first streaming frame: driveTurn / runObserveFiber
      // render this placeholder before the real snapshot arrives, and
      // approval-required carries no header badge — so the card never flashes a
      // misleading red `bypass` for what is actually an approval-required session.
      // The real runtimeMode overwrites it on the first folded frame. (sendNotice
      // renders this thread with chrome:false, so the value is moot there.)
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      latestTurn: null,
      createdAt: placeholderTimestamp,
      updatedAt: placeholderTimestamp,
      archivedAt: null,
      deletedAt: null,
      messages: [],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
      session: null,
    };

    // Render a static, single-message notice card into the placeholder envelope.
    // The notice text rides in as one assistant message so it flows through the
    // real renderer (markdown body, byte clamping) instead of hand-built JSON.
    const makeNoticeThread = (text: string): OrchestrationThread => {
      const message: OrchestrationMessage = {
        id: placeholderMessageId,
        role: "assistant",
        text,
        turnId: null,
        streaming: false,
        createdAt: placeholderTimestamp,
        updatedAt: placeholderTimestamp,
      };
      return { ...placeholderThread, messages: [message] };
    };

    // Send a one-off, non-streaming notice card to `chatId` (e.g. "text only",
    // "server not connected"). Opens a streaming card whose completion is already
    // resolved, so the SDK producer renders once and settles immediately. Failures
    // are logged and swallowed — a notice must never crash the handler.
    // M3a: `chatKey` is the composite `chatId[:larkThreadId]` (the bridge's
    // internal conversation identity). Fix 5: when the notice answers a *triggering*
    // message (`replyToMessageId` supplied) AND the key is a topic, `topicSendOpts`
    // anchors the card inside that topic; for p2p / plain group / no anchor it
    // returns `undefined` so the card posts at the chat/group root (byte-identical
    // to pre-Fix-5). A bare `chatId` (p2p / plain group) has no `larkThreadId`, so
    // the topic opts never fire there.
    const sendNotice = (
      chatKey: string,
      text: string,
      replyToMessageId?: string,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const { chatId, larkThreadId } = splitChatKey(chatKey);
        const done = yield* Deferred.make<void>();
        yield* Deferred.succeed(done, undefined);
        // #3/#4: notice cards carry only a short text body on a synthetic
        // placeholder thread (no real title/workspace), so `chrome: false`
        // suppresses the 🧵 header + 📁 subtitle that would otherwise be noise.
        const card = renderThreadCard(makeNoticeThread(text), {
          streaming: false,
          chrome: false,
        }).card;
        yield* gateway
          .startStreamingCard(
            chatId,
            card,
            { done: Deferred.await(done) },
            topicSendOpts(larkThreadId, replyToMessageId),
          )
          .pipe(
            Effect.tapError((error) =>
              Console.error(`[feishu-bot] notice card failed for chat ${chatId}: ${error.message}`),
            ),
            Effect.ignore,
          );
      });

    // Render the last few messages of a takeover snapshot into a compact
    // markdown transcript (M2b-2). One line per message: `🧑 …` (user) / `🤖 …`
    // (assistant), each on its own paragraph. Each message body is trimmed to a
    // single short excerpt so the takeover card stays light — this is a *simple*
    // transcript, not the live card (no tools/reasoning). The renderer's global
    // byte-clamp is the backstop; this keeps the common case readable.
    const TRANSCRIPT_MESSAGE_COUNT = 5;
    const TRANSCRIPT_EXCERPT_CHARS = 280;
    const renderTranscriptMarkdown = (
      messages: ReadonlyArray<OrchestrationMessage>,
    ): string | null => {
      const recent = messages
        .filter(
          (message) =>
            (message.role === "user" || message.role === "assistant") &&
            message.text.trim().length > 0,
        )
        .slice(-TRANSCRIPT_MESSAGE_COUNT);
      if (recent.length === 0) {
        return null;
      }
      return recent
        .map((message) => {
          const icon = message.role === "user" ? "🧑" : "🤖";
          const text = message.text.trim();
          const excerpt =
            text.length > TRANSCRIPT_EXCERPT_CHARS
              ? `${text.slice(0, TRANSCRIPT_EXCERPT_CHARS)}…`
              : text;
          return `${icon} ${excerpt}`;
        })
        .join("\n\n");
    };

    // Echo an outcome onto the very card that was clicked. `messageId` is taken
    // from the event (E④), so this never queries the card-handle store. Failures
    // degrade the card to a "已失效/已接管" notice rather than crashing the fiber.
    const updateCardNotice = (messageId: string, text: string): Effect.Effect<void> =>
      gateway
        .updateCard(
          messageId,
          // #3/#4: same notice/status card path as `sendNotice` — `chrome: false`
          // drops the meaningless 🧵/📁 chrome on the synthetic placeholder thread.
          renderThreadCard(makeNoticeThread(text), { streaming: false, chrome: false }).card,
        )
        .pipe(
          Effect.tapError((error) =>
            Console.error(`[feishu-bot] card update failed for ${messageId}: ${error.message}`),
          ),
          Effect.ignore,
        );

    return {
      placeholderThread,
      makeNoticeThread,
      sendNotice,
      renderTranscriptMarkdown,
      updateCardNotice,
    } as const;
  });
