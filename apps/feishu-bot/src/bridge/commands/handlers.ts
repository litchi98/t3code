/**
 * Slash-command handlers (M2a).
 *
 * Builds the command table consumed by `commands/registry.tryHandleCommand`:
 * `/help`, `/status`, `/resume`, `/release`. These are the bridge's *control*
 * surface — distinct from the normal turn path — so they must work even for a
 * chat with no binding yet (`/help`, `/resume` listing candidates). The caller
 * (`bot.ts`) therefore routes commands *before* `ensureThread`.
 *
 * The handlers are deliberately decoupled from the registry/store/gateway
 * concrete shapes: every side effect (notice send, binding read/write, mirror
 * start/stop, turn-running probe) arrives through {@link CommandDeps}, and each
 * handler is total (`Effect.Effect<void>`) so it slots straight into the table
 * (the registry already isolates a handler failure under `Effect.catchCause`).
 *
 * `/resume` with no argument lists the active threads and remembers, per chat,
 * the ordered candidate `ThreadId`s it printed, so a follow-up `/resume <n>`
 * can resolve an ordinal back to the thread the user saw. That candidate cache
 * is a module-local `Ref<Map<chatId, …>>`; M2a's 1:1 private chats do not need
 * a TTL (a stale list is harmless — the target is re-validated against the live
 * shell before any re-bind).
 */
import { type OrchestrationThreadShell, ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import type { BindingState } from "../bindingState.ts";
import { anchorOf, compositeChatKey, runtimeModeForChatType } from "../chatThreadMap.ts";
import { type ShellSnapshotCache, shellStatus } from "../shellCache.ts";
import type { CommandContext, CommandHandler } from "./registry.ts";

/** Maximum number of candidate threads `/resume` lists at once. */
const MAX_CANDIDATES = 5;

/**
 * M3a: the composite conversation key (`chatId[:anchor]`) for a command's
 * triggering message. Delegates to {@link anchorOf} (the same function used by
 * the turn pipeline in `bot.ts`) as the single source of truth, so commands
 * always resolve the same composite key as the turn that created the session —
 * no divergence between the slash-command layer and the turn layer.
 */
const chatKeyOf = (ctx: CommandContext): string =>
  // Reuse chatThreadMap.anchorOf as single source, consistent with turn pipeline.
  compositeChatKey(ctx.message.chatId, anchorOf(ctx.message));

/** Dependencies the command handlers need, injected by `bot.ts` (Integrate). */
export interface CommandDeps {
  /**
   * Push a single plain-text notice card to `chatId` (a composite `chatId[:larkThreadId]`
   * key). Fix 5 (M3a): pass the triggering command's `messageId` as `replyToMessageId`
   * to anchor the confirmation inside its topic; omitted / p2p / plain group posts at
   * the chat root (byte-identical to pre-Fix-5).
   */
  readonly sendNotice: (
    chatId: string,
    text: string,
    replyToMessageId?: string,
  ) => Effect.Effect<void>;
  /** The mutable chat↔thread binding state (resolved service). */
  readonly bindings: BindingState["Service"];
  /** The resident shell snapshot cache (read-only here). */
  readonly shellCache: ShellSnapshotCache;
  /**
   * Take over `threadId` for `chatId` (mirror-light): re-bind as `origin:
   * "resumed"` and push a one-off takeover snapshot card. Validation that the
   * thread is live happens in the handler *before* this is called.
   */
  readonly startMirror: (
    chatId: string,
    threadId: ThreadId,
    replyToMessageId?: string,
  ) => Effect.Effect<void>;
  /** Tear down any mirror state for `chatId` (mirror-light: candidate-cache clear). */
  readonly stopMirror: (chatId: string) => Effect.Effect<void>;
  /**
   * Drop the shell-watcher's per-thread dedup memory for `threadId`, called on the
   * discrete `/release` lifecycle event so a later `/resume` of the same thread
   * re-pushes its existing pending approval instead of being suppressed by stale
   * dedup state. No-op if the watcher never recorded anything for the thread.
   */
  readonly clearNoticeMemory: (threadId: ThreadId) => Effect.Effect<void>;
  /**
   * Drop the chat's resolved-interaction overlay (the per-chat "✅ 已由 …" greyed
   * notices the cardAction echo persists), called on `/release` so a later
   * session in the same chat does not inherit stale resolved controls (P2).
   */
  readonly clearResolvedNotices: (chatId: string) => Effect.Effect<void>;
  /**
   * Whether the chat is *busy* — a turn is running **or** messages are coalescing
   * in the idle merge window (a dispatch is imminent). A `/resume` re-bind is
   * refused while busy, so a re-point never interleaves with an in-flight or
   * about-to-dispatch turn (the re-bind TOCTOU; backstopped by the dispatch
   * carrying its own resolved threadId).
   */
  readonly isChatBusy: (chatId: string) => Effect.Effect<boolean>;
}

/**
 * Format an ISO timestamp as a coarse relative time ("just now", "5m ago", …).
 * `nowMs` is supplied by the caller (via `Clock.currentTimeMillis`) — time access
 * goes through Effect's `Clock`, never a bare `Date.now()`.
 */
const relativeTime = (iso: string | null, nowMs: number): string => {
  if (iso === null) {
    return "unknown";
  }
  const then = Date.parse(iso);
  if (Number.isNaN(then)) {
    return "unknown";
  }
  const deltaMs = nowMs - then;
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
};

/**
 * Short live-status tag for a (present) thread shell, mapping the shared
 * {@link shellStatus} classifier to its display token. A non-null shell never
 * classifies as `"unknown"`, so the tag is always one of the three live states.
 */
const statusTag = (shell: OrchestrationThreadShell): string => shellStatus(shell);

/**
 * Build the slash-command table (`/help`, `/status`, `/resume`, `/release`).
 *
 * Table keys are `/`-prefixed lowercase tokens, matching the registry's
 * normalisation (`parts[0].toLowerCase()` keeps the leading `/`). Every value is
 * a total {@link CommandHandler}; the registry runs them under
 * `Effect.catchCause`, so a handler may assume failures are logged + swallowed.
 */
export const buildCommandTable = (deps: CommandDeps): ReadonlyMap<string, CommandHandler> => {
  // Per-chat ordered candidate cache for `/resume <n>`: the ThreadIds last
  // printed by a bare `/resume`, in display order. Closure-local (constructed
  // unsafely, the house pattern for per-build mutable state — cf. `bot.ts`'s
  // `Semaphore.makeUnsafe`); no TTL needed (the target is re-validated against
  // the live shell on use).
  const candidates = Ref.makeUnsafe<ReadonlyMap<string, ReadonlyArray<ThreadId>>>(new Map());

  const help: CommandHandler = (ctx) =>
    deps.sendNotice(
      chatKeyOf(ctx),
      [
        "可用命令:",
        "• /resume — 列出可接管的会话",
        "• /resume <序号|threadId> — 接管指定会话",
        "• /status — 查看当前绑定与会话状态",
        "• /release — 退出当前会话",
        "• /whoami — 查看你的飞书 openId(用于配置 FEISHU_OWNER_OPEN_IDS)",
      ].join("\n"),
      ctx.message.messageId,
    );

  const status: CommandHandler = (ctx) =>
    Effect.gen(function* () {
      const chatKey = chatKeyOf(ctx);
      const binding = yield* deps.bindings.get(chatKey);
      if (binding === null) {
        yield* deps.sendNotice(
          chatKey,
          "当前未绑定任何会话。用 /resume 选择一个会话接管。",
          ctx.message.messageId,
        );
        return;
      }
      const shell = yield* deps.shellCache.threadById(binding.threadId);
      if (shell === null) {
        yield* deps.sendNotice(
          chatKey,
          `当前绑定: ${binding.threadId} (${binding.origin})\n该会话已不在列表中(可能已删除/归档),用 /resume 重新选择。`,
          ctx.message.messageId,
        );
        return;
      }
      yield* deps.sendNotice(
        chatKey,
        [
          `当前绑定: ${shell.title}`,
          `threadId: ${binding.threadId}`,
          `来源: ${binding.origin}`,
          `状态: ${statusTag(shell)}`,
        ].join("\n"),
        ctx.message.messageId,
      );
    });

  // `/resume` with no arg: list the active candidates and remember them.
  const listCandidates: CommandHandler = (ctx) =>
    Effect.gen(function* () {
      const chatKey = chatKeyOf(ctx);
      const active = yield* deps.shellCache.activeThreads;
      if (active.length === 0) {
        yield* deps.sendNotice(chatKey, "当前没有可接管的会话。", ctx.message.messageId);
        return;
      }
      const top = active.slice(0, MAX_CANDIDATES);
      yield* Ref.update(candidates, (map) =>
        new Map(map).set(
          chatKey,
          top.map((shell) => shell.id),
        ),
      );
      const nowMs = yield* Clock.currentTimeMillis;
      const lines = top.map(
        (shell, index) =>
          `[${index + 1}] ${shell.title} · ${relativeTime(
            shell.latestUserMessageAt ?? shell.updatedAt,
            nowMs,
          )} · (${statusTag(shell)})`,
      );
      yield* deps.sendNotice(
        chatKey,
        ["可接管的会话:", ...lines, "", "回复 /resume <序号> 或 /resume <threadId> 接管。"].join(
          "\n",
        ),
        ctx.message.messageId,
      );
    });

  // `/resume <n|threadId>`: resolve target → guard turn → validate → mirror.
  const resumeTarget = (ctx: Parameters<CommandHandler>[0], arg: string) =>
    Effect.gen(function* () {
      const chatKey = chatKeyOf(ctx);

      // Resolve the target threadId: a small positive integer is an ordinal
      // into the chat's last-listed candidates; anything else is a raw id.
      let target: ThreadId;
      const ordinal = Number.parseInt(arg, 10);
      if (String(ordinal) === arg && ordinal >= 1) {
        const list = (yield* Ref.get(candidates)).get(chatKey) ?? [];
        const picked = list[ordinal - 1];
        if (picked === undefined) {
          yield* deps.sendNotice(
            chatKey,
            "序号无效。先发送 /resume(不带参数)查看候选列表。",
            ctx.message.messageId,
          );
          return;
        }
        target = picked;
      } else {
        target = ThreadId.make(arg);
      }

      // Refuse a re-bind while the chat is busy (a turn running OR messages
      // coalescing in the idle merge window): re-pointing mid-turn — or while a
      // dispatch is imminent — would steer/observe the wrong thread.
      const busy = yield* deps.isChatBusy(chatKey);
      if (busy) {
        yield* deps.sendNotice(
          chatKey,
          "当前有消息正在处理,请稍后再切换会话。",
          ctx.message.messageId,
        );
        return;
      }

      // Validate the target is live (present + not archived) before binding.
      const shell = yield* deps.shellCache.threadById(target);
      if (shell === null || shell.archivedAt !== null) {
        yield* deps.sendNotice(chatKey, "会话不存在或已归档。", ctx.message.messageId);
        return;
      }

      // Fix 2 (M3a): full-access gate. A thread's `runtimeMode` is pinned at
      // creation and every turn runs under it (the server ignores `turn.start`'s
      // per-turn `runtimeMode`). So a group / topic chat (`approval-required`)
      // `/resume`-ing a thread that was created `full-access` elsewhere (p2p / web)
      // would run every subsequent turn unattended at full access — bypassing the
      // group's approval-required safety. Refuse the takeover. p2p (`required ===
      // "full-access"`) never trips this, so its behaviour is unchanged.
      const required = runtimeModeForChatType(ctx.message.chatType);
      if (required === "approval-required" && shell.runtimeMode === "full-access") {
        yield* deps.sendNotice(
          chatKey,
          "⚠️ 该会话为 full-access(全权限)模式,群聊/话题不可接管全权限会话,以免无人值守执行破坏性操作。",
          ctx.message.messageId,
        );
        return;
      }

      // Hand off to mirror-light: it does the re-bind + takeover snapshot card.
      // M3b path A: pass the `/resume` command message id (belongs to this topic) so
      // the takeover/approval cards anchor inside the topic and the binding records it.
      yield* deps.startMirror(chatKey, target, ctx.message.messageId);
    });

  const resume: CommandHandler = (ctx) => {
    const arg = ctx.args.trim();
    return arg.length === 0 ? listCandidates(ctx) : resumeTarget(ctx, arg);
  };

  const release: CommandHandler = (ctx) =>
    Effect.gen(function* () {
      // M3a: release only the current topic's binding (composite key), not the
      // whole group — a sibling topic's takeover in the same chat is untouched.
      const chatKey = chatKeyOf(ctx);
      // Resolve the bound thread *before* unbinding so we can clear the watcher's
      // dedup memory for it: otherwise a later `/resume` of the same thread would
      // not re-push its still-pending approval (suppressed by stale dedup state).
      const binding = yield* deps.bindings.get(chatKey);
      yield* deps.bindings.unbind(chatKey);
      if (binding !== null) {
        yield* deps.clearNoticeMemory(binding.threadId);
      }
      // P2: clear the conversation's resolved-interaction overlay too, so a future
      // session here starts with no stale greyed-out "✅ 已由 …" controls.
      yield* deps.clearResolvedNotices(chatKey);
      yield* deps.stopMirror(chatKey);
      yield* deps.sendNotice(chatKey, "已退出当前会话。", ctx.message.messageId);
    });

  const whoami: CommandHandler = (ctx) =>
    deps.sendNotice(
      chatKeyOf(ctx),
      `你的飞书 openId: ${ctx.message.senderId}`,
      ctx.message.messageId,
    );

  const table = new Map<string, CommandHandler>([
    ["/help", help],
    ["/status", status],
    ["/resume", resume],
    ["/release", release],
    ["/whoami", whoami],
  ]);
  return table as ReadonlyMap<string, CommandHandler>;
};
