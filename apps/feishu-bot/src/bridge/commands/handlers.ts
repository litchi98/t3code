/**
 * Slash-command handlers (M2a).
 *
 * Builds the command table consumed by `commands/registry.tryHandleCommand`:
 * `/help`, `/status`, `/workspace`, `/resume`, `/release`, `/whoami`. These are
 * the bridge's *control* surface — distinct from the normal turn path — so they
 * must work even for a chat with no binding yet (`/help`, `/workspace`,
 * `/resume` listing candidates). The caller (`bot.ts`) therefore routes
 * commands *before* `ensureThread` (and before the M-1 workspace gate).
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
import {
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  type ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import * as NodeOS from "node:os";

import type { BindingState } from "../bindingState.ts";
import {
  anchorOf,
  compositeChatKey,
  refusesFullAccessTakeover,
  runtimeModeForChatType,
} from "../chatThreadMap.ts";
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
  /**
   * The per-chat workspace selection authority (M-1): total reads/writes over
   * the `WorkspaceState` service, keyed by the composite chat key. `/workspace`
   * writes it; `/resume` reads it for the selected-project ownership check.
   */
  readonly workspace: {
    readonly get: (chatKey: string) => Effect.Effect<ProjectId | null>;
    readonly select: (chatKey: string, projectId: ProjectId) => Effect.Effect<void>;
  };
  /**
   * `/workspace add <local path>` backend: dispatch a `createProject` at
   * `workspaceRoot` (creating the directory when missing) and resolve once the
   * new project is visible in the shell snapshot, returning its shell. Fails
   * with a user-facing {@link WorkspaceCommandError} the handler sends verbatim.
   */
  readonly createWorkspaceProject: (
    workspaceRoot: string,
  ) => Effect.Effect<OrchestrationProjectShell, WorkspaceCommandError>;
  /**
   * `/workspace add <git url>` backend: clone `remoteUrl` into
   * `destinationPath` **server-side** (the server resolves `~`/relative paths
   * against its own filesystem) and return the resulting checkout `cwd`, ready
   * for {@link createWorkspaceProject}. Fails with a user-facing
   * {@link WorkspaceCommandError}.
   */
  readonly cloneRepository: (
    remoteUrl: string,
    destinationPath: string,
  ) => Effect.Effect<string, WorkspaceCommandError>;
  /**
   * Whether a buffered first-contact `createThread` intent is pending for this
   * chat (review fix C①). Such an intent captured its project at buffer time,
   * so `/workspace switch` — and `/workspace add`'s auto-switch — must be
   * refused until it flushes; otherwise the visible selection and the
   * eventually-created thread would silently diverge. (The flush side
   * re-validates the selection too — fix C②, `bridge/createIntent.ts`.)
   */
  readonly hasPendingCreate: (chatKey: string) => Effect.Effect<boolean>;
}

/**
 * User-facing failure of a `/workspace add` backend operation (M-1). The
 * `message` is display-ready (Chinese, one line) — handlers send it verbatim as
 * a notice instead of pattern-matching on transport-level error shapes.
 */
export class WorkspaceCommandError extends Data.TaggedError("WorkspaceCommandError")<{
  readonly message: string;
}> {}

/**
 * Whether a `/workspace add` argument is a git clone source rather than a
 * local path: an explicit scheme (`https?://`, `ssh://`, `git://`), an
 * scp-like `git@host:owner/repo`, or a trailing `.git`. Local paths are
 * detected separately (leading `/` or `~`) BEFORE this test, so a local
 * `/repos/foo.git` never reaches it.
 */
export const isGitUrl = (value: string): boolean =>
  /^(https?|ssh|git):\/\//i.test(value) || /^git@[^:]+:/.test(value) || value.endsWith(".git");

/**
 * Derive the repository directory name from a clone URL: the last `/`- or
 * `:`-separated segment, minus a trailing `.git`. Falls back to `"repo"` for
 * degenerate inputs (the server-side clone would fail on those anyway; the
 * fallback only keeps the destination path well-formed).
 */
export const repoNameOf = (url: string): string => {
  const tail = url.replace(/\/+$/, "").split(/[/:]/).pop() ?? "";
  const name = tail.endsWith(".git") ? tail.slice(0, -4) : tail;
  return name.length > 0 ? name : "repo";
};

/**
 * Default clone destination when `/workspace add <url>` omits the `[dest]`
 * argument: `~/t3-workspaces/<repo>`, expanded by the SERVER (its
 * `normalizeDestinationPath` runs `expandHomePath` + `path.resolve`), so the
 * convention lands under the server user's home regardless of where the bot
 * process runs.
 */
export const defaultCloneDestination = (url: string): string =>
  `~/t3-workspaces/${repoNameOf(url)}`;

/**
 * Normalise a `/workspace add` local path for comparison against (and creation
 * of) server-side `workspaceRoot`s (review fix G): strip trailing slashes and
 * expand a leading `~` against the local home directory — mirroring the
 * server's `expandHomePath` + `resolve` semantics. Valid because the bot and
 * the server share a host (dev: same machine; prod: the bot is the server's
 * child process), so both resolve `~` to the same home.
 */
export const normalizeLocalWorkspacePath = (raw: string): string => {
  const stripped = raw.replace(/\/+$/, "");
  const trimmed = stripped.length > 0 ? stripped : "/";
  if (trimmed === "~") {
    return NodeOS.homedir();
  }
  if (trimmed.startsWith("~/")) {
    return `${NodeOS.homedir()}${trimmed.slice(1)}`;
  }
  return trimmed;
};

/** Minimum length for a projectId *prefix* to count as a switch target (H). */
const MIN_ID_PREFIX = 6;

/** Length of the short project id shown in `/workspace` listings (H). */
const SHORT_ID_LENGTH = 8;

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
 * Build the slash-command table (`/help`, `/status`, `/workspace`, `/resume`,
 * `/release`, `/whoami`).
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

  // Per-chat ordered candidate cache for `/workspace <n>` — the ProjectIds last
  // printed by a bare `/workspace`, in display order. A SEPARATE map instance
  // from the `/resume` cache above (same pattern), so `/workspace <n>` and
  // `/resume <n>` ordinals never overwrite each other.
  const workspaceOrdinals = Ref.makeUnsafe<ReadonlyMap<string, ReadonlyArray<ProjectId>>>(
    new Map(),
  );

  const help: CommandHandler = (ctx) =>
    deps.sendNotice(
      chatKeyOf(ctx),
      [
        "可用命令:",
        "• /workspace — 列出可选工作区(标记当前选中)",
        "• /workspace <序号|projectId|名称> — 切换工作区(已绑定会话需先 /release)",
        "• /workspace add <本地绝对路径|git URL> [克隆目标目录] — 添加工作区并切换",
        "• /resume — 列出当前工作区可接管的会话",
        "• /resume <序号|threadId> — 接管指定会话(须属于当前工作区)",
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

  // ── /workspace (M-1): list / switch / add ─────────────────────────────────

  // `/workspace` with no arg (or `list`): list every project in the shell
  // snapshot, mark the chat's current selection, and remember the display
  // order for `/workspace <n>`.
  const listWorkspaces: CommandHandler = (ctx) =>
    Effect.gen(function* () {
      const chatKey = chatKeyOf(ctx);
      const snapshot = yield* deps.shellCache.current;
      if (snapshot === null) {
        yield* deps.sendNotice(
          chatKey,
          "服务器尚未同步项目列表,请稍后再试。",
          ctx.message.messageId,
        );
        return;
      }
      const projects = snapshot.projects;
      if (projects.length === 0) {
        yield* deps.sendNotice(
          chatKey,
          "当前没有工作区。用 /workspace add <本地绝对路径|git URL> [克隆目标目录] 添加一个。",
          ctx.message.messageId,
        );
        return;
      }
      const selected = yield* deps.workspace.get(chatKey);
      yield* Ref.update(workspaceOrdinals, (map) =>
        new Map(map).set(
          chatKey,
          projects.map((project) => project.id),
        ),
      );
      // H: include a short id per line — it is the only surface a projectId is
      // ever visible on, and the disambiguation path for duplicate titles.
      const lines = projects.map(
        (project, index) =>
          `[${index + 1}] ${project.title} · ${project.workspaceRoot} · id ${project.id.slice(0, SHORT_ID_LENGTH)}` +
          (project.id === selected ? " ✅ 当前" : ""),
      );
      yield* deps.sendNotice(
        chatKey,
        [
          "可选工作区:",
          ...lines,
          "",
          "回复 /workspace <序号|projectId|名称> 切换;/workspace add <本地绝对路径|git URL> [克隆目标目录] 添加。",
        ].join("\n"),
        ctx.message.messageId,
      );
    });

  // `/workspace <n|projectId|名称>` (also `/workspace switch …`): change this
  // conversation's selected workspace. 方案 b (kickoff §5B): the derived
  // threadId is chat-keyed and project-agnostic, so a busy chat may not switch,
  // and a chat still BOUND to a session must `/release` first — a switch never
  // re-points or interleaves with a live session.
  const switchWorkspace = (ctx: CommandContext, arg: string) =>
    Effect.gen(function* () {
      const chatKey = chatKeyOf(ctx);

      // Gate 1 (mirrors `/resume`): never mutate the selection while a turn is
      // running or coalescing — the imminent dispatch resolved its project
      // under the old selection.
      if (yield* deps.isChatBusy(chatKey)) {
        yield* deps.sendNotice(
          chatKey,
          "当前有消息正在处理,请稍后再切换工作区。",
          ctx.message.messageId,
        );
        return;
      }
      // Gate 2 (方案 b): a bound conversation keeps its session; require an
      // explicit /release so "which thread is this chat talking to" never
      // changes out from under the user via a workspace switch.
      const binding = yield* deps.bindings.get(chatKey);
      if (binding !== null) {
        yield* deps.sendNotice(
          chatKey,
          "当前对话已绑定会话,请先 /release 退出会话后再切换工作区。",
          ctx.message.messageId,
        );
        return;
      }
      // Gate 3 (review fix C①): a buffered first-contact create captured its
      // project at buffer time — switching now would make the selection and the
      // thread the flush eventually creates silently diverge.
      if (yield* deps.hasPendingCreate(chatKey)) {
        yield* deps.sendNotice(
          chatKey,
          "该对话有排队中的消息正等待服务器重连,请等待重连完成(或该消息被明确拒绝)后再切换工作区。",
          ctx.message.messageId,
        );
        return;
      }

      const snapshot = yield* deps.shellCache.current;
      const projects = snapshot?.projects ?? [];

      // Resolve the target: a SMALL positive integer (≤ 3 digits — a longer
      // all-digit string is an id prefix, never a list position) is an ordinal
      // into the chat's last-listed workspaces; otherwise match projectId
      // exactly, then a unique id PREFIX (≥ MIN_ID_PREFIX chars — the listing
      // shows the first SHORT_ID_LENGTH, fix H), then title exactly (only when
      // unambiguous).
      let target: OrchestrationProjectShell | undefined;
      const ordinal = Number.parseInt(arg, 10);
      if (String(ordinal) === arg && ordinal >= 1 && arg.length <= 3) {
        const list = (yield* Ref.get(workspaceOrdinals)).get(chatKey) ?? [];
        const pickedId = list[ordinal - 1];
        target =
          pickedId === undefined ? undefined : projects.find((project) => project.id === pickedId);
        if (target === undefined) {
          yield* deps.sendNotice(
            chatKey,
            "序号无效。先发送 /workspace(不带参数)查看工作区列表。",
            ctx.message.messageId,
          );
          return;
        }
      } else {
        target = projects.find((project) => project.id === arg);
        if (target === undefined && arg.length >= MIN_ID_PREFIX) {
          const byPrefix = projects.filter((project) => project.id.startsWith(arg));
          if (byPrefix.length === 1) {
            target = byPrefix[0];
          }
        }
        if (target === undefined) {
          const byTitle = projects.filter((project) => project.title === arg);
          if (byTitle.length > 1) {
            yield* deps.sendNotice(
              chatKey,
              "有多个同名工作区,请用序号或列表中的短 id 指定。",
              ctx.message.messageId,
            );
            return;
          }
          target = byTitle[0];
        }
        if (target === undefined) {
          yield* deps.sendNotice(
            chatKey,
            "未找到匹配的工作区。发送 /workspace 查看可选项。(若工作区名称以 add/list/switch 开头,请用 /workspace switch <名称> 或序号)",
            ctx.message.messageId,
          );
          return;
        }
      }

      const current = yield* deps.workspace.get(chatKey);
      if (current === target.id) {
        yield* deps.sendNotice(chatKey, `当前已是工作区: ${target.title}`, ctx.message.messageId);
        return;
      }
      yield* deps.workspace.select(chatKey, target.id);
      yield* deps.sendNotice(
        chatKey,
        `已切换到工作区: ${target.title}\n${target.workspaceRoot}`,
        ctx.message.messageId,
      );
    });

  // `/workspace add <local path|git url> [dest]`: create (or clone-then-create)
  // a project and auto-switch this conversation to it — UNLESS the switch gates
  // (busy / bound / pending create, same as `/workspace switch`; review fix E)
  // block the auto-switch, in which case the project is still created but the
  // selection is left alone and the confirmation says so.
  const addWorkspace: CommandHandler = (ctx) =>
    Effect.gen(function* () {
      const chatKey = chatKeyOf(ctx);
      const target = ctx.argv[1];
      const dest = ctx.argv[2];
      const usage = "用法: /workspace add <本地绝对路径|git URL> [克隆目标目录]";
      if (target === undefined || ctx.argv.length > 3) {
        yield* deps.sendNotice(chatKey, usage, ctx.message.messageId);
        return;
      }

      // Review fix E: the auto-switch is a switch, so it must pass the SAME
      // gates. Evaluated up front (the create itself is never gated).
      const switchBlocked =
        (yield* deps.isChatBusy(chatKey)) ||
        (yield* deps.bindings.get(chatKey)) !== null ||
        (yield* deps.hasPendingCreate(chatKey));

      // Confirm a freshly created/found project: select + confirm when the
      // switch gates allow it; otherwise confirm the creation WITHOUT touching
      // the selection (never claim "已切换" while the chat keeps its session).
      // `head` is the completed action, e.g. "已添加工作区" / "该路径已是工作区".
      const selectAndConfirm = (project: OrchestrationProjectShell, head: string) =>
        switchBlocked
          ? deps.sendNotice(
              chatKey,
              `${head}: ${project.title}\n${project.workspaceRoot}\n当前对话仍在使用原工作区(有会话或排队消息);/release 后用 /workspace switch 切换。`,
              ctx.message.messageId,
            )
          : deps.workspace
              .select(chatKey, project.id)
              .pipe(
                Effect.andThen(
                  deps.sendNotice(
                    chatKey,
                    `${head},已切换: ${project.title}\n${project.workspaceRoot}`,
                    ctx.message.messageId,
                  ),
                ),
              );

      const isLocalPath = target.startsWith("/") || target.startsWith("~");
      if (isLocalPath) {
        if (dest !== undefined) {
          yield* deps.sendNotice(
            chatKey,
            `本地路径添加不支持目标目录参数。${usage}`,
            ctx.message.messageId,
          );
          return;
        }
        // Review fix G: normalise (trailing slashes, `~` expansion) BEFORE both
        // the reuse comparison and the create, aligning with the server's
        // `expandHomePath` + `resolve` semantics so `/repos/x/` or `~/repos/x`
        // match an existing project at `/repos/x`.
        const workspaceRoot = normalizeLocalWorkspacePath(target);
        // Re-use an existing project at the same root instead of double-adding
        // (the server keys active projects by workspaceRoot).
        const snapshot = yield* deps.shellCache.current;
        const existing = snapshot?.projects.find(
          (project) => project.workspaceRoot === workspaceRoot,
        );
        if (existing !== undefined) {
          yield* selectAndConfirm(existing, "该路径已是工作区");
          return;
        }
        yield* deps.createWorkspaceProject(workspaceRoot).pipe(
          Effect.flatMap((project) => selectAndConfirm(project, "已添加工作区")),
          Effect.catchTag("WorkspaceCommandError", (error) =>
            deps.sendNotice(chatKey, error.message, ctx.message.messageId),
          ),
        );
        return;
      }

      if (!isGitUrl(target)) {
        yield* deps.sendNotice(
          chatKey,
          `无法识别参数:请提供本地绝对路径(以 / 或 ~ 开头)或 git URL。${usage}(若工作区名称以 add/list/switch 开头,请用 /workspace switch <名称> 或序号切换)`,
          ctx.message.messageId,
        );
        return;
      }

      const destination = dest ?? defaultCloneDestination(target);
      yield* deps.sendNotice(
        chatKey,
        `⏳ 正在克隆 ${target} → ${destination} …`,
        ctx.message.messageId,
      );
      yield* deps.cloneRepository(target, destination).pipe(
        Effect.flatMap((cwd) =>
          Effect.gen(function* () {
            // The clone may land where a project already exists (re-add): reuse it.
            const snapshot = yield* deps.shellCache.current;
            const existing = snapshot?.projects.find((project) => project.workspaceRoot === cwd);
            if (existing !== undefined) {
              yield* selectAndConfirm(existing, "该目录已是工作区");
              return;
            }
            const project = yield* deps.createWorkspaceProject(cwd);
            yield* selectAndConfirm(project, "已克隆工作区");
          }),
        ),
        Effect.catchTag("WorkspaceCommandError", (error) =>
          deps.sendNotice(chatKey, error.message, ctx.message.messageId),
        ),
      );
    });

  // `/workspace` dispatcher: argv[0] selects the sub-command; a bare argument
  // is a switch target (`/workspace 2` ≡ `/workspace switch 2`).
  const workspaceCommand: CommandHandler = (ctx) =>
    Effect.gen(function* () {
      const sub = (ctx.argv[0] ?? "").toLowerCase();
      if (sub === "" || sub === "list") {
        return yield* listWorkspaces(ctx);
      }
      if (sub === "add") {
        return yield* addWorkspace(ctx);
      }
      if (sub === "switch") {
        // Raw remainder after the `switch` token, preserving inner spacing
        // (titles may contain spaces).
        const arg = ctx.args.slice(ctx.argv[0]?.length ?? 0).trim();
        if (arg.length === 0) {
          yield* deps.sendNotice(
            chatKeyOf(ctx),
            "用法: /workspace switch <序号|projectId|名称>",
            ctx.message.messageId,
          );
          return;
        }
        return yield* switchWorkspace(ctx, arg);
      }
      // Bare argument → switch (the raw remainder, so titles keep spacing).
      return yield* switchWorkspace(ctx, ctx.args.trim());
    });

  // `/resume` with no arg: list the active candidates and remember them.
  // M-1 ownership scope: only threads belonging to this conversation's selected
  // workspace are listed — `/resume` must not enumerate (or leak) other
  // projects' sessions. No selection → point at `/workspace` first.
  const listCandidates: CommandHandler = (ctx) =>
    Effect.gen(function* () {
      const chatKey = chatKeyOf(ctx);
      const selectedProject = yield* deps.workspace.get(chatKey);
      if (selectedProject === null) {
        yield* deps.sendNotice(
          chatKey,
          "请先用 /workspace 选择工作区,再用 /resume 查看该工作区的会话。",
          ctx.message.messageId,
        );
        return;
      }
      const active = (yield* deps.shellCache.activeThreads).filter(
        (shell) => shell.projectId === selectedProject,
      );
      if (active.length === 0) {
        yield* deps.sendNotice(chatKey, "当前工作区没有可接管的会话。", ctx.message.messageId);
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

      // M-1 ownership check, part 1: a takeover requires a selected workspace
      // (the target must be validated AGAINST something — no selection, no
      // resume). Mirrors the listing's guidance.
      const selectedProject = yield* deps.workspace.get(chatKey);
      if (selectedProject === null) {
        yield* deps.sendNotice(
          chatKey,
          "请先用 /workspace 选择工作区,再接管该工作区的会话。",
          ctx.message.messageId,
        );
        return;
      }

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

      // M-1 ownership check, part 2 (the authorization fix, kickoff §5E): the
      // target must belong to THIS conversation's selected workspace. Refuse a
      // cross-project takeover with a deliberately information-free message
      // (never echo the other project's identity). The `∩ per-chat authorized
      // workspaces` intersection is M-3's job — here only the M-1 selection is
      // consulted.
      if (shell.projectId !== selectedProject) {
        yield* deps.sendNotice(
          chatKey,
          "该会话不属于当前选中的工作区,无法接管。",
          ctx.message.messageId,
        );
        return;
      }

      // Fix 2 (M3a): full-access gate — via the shared predicate
      // (`refusesFullAccessTakeover`, also consumed by the M-1 adopt re-bind in
      // `bot.ts`, review fix D). A thread's `runtimeMode` is pinned at creation
      // and every turn runs under it, so a group / topic chat
      // (`approval-required`) `/resume`-ing a thread created `full-access`
      // elsewhere would run every subsequent turn unattended at full access.
      // Refuse the takeover. p2p never trips this (behaviour unchanged).
      const required = runtimeModeForChatType(ctx.message.chatType);
      if (refusesFullAccessTakeover(required, shell.runtimeMode)) {
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
    ["/workspace", workspaceCommand],
    ["/resume", resume],
    ["/release", release],
    ["/whoami", whoami],
  ]);
  return table as ReadonlyMap<string, CommandHandler>;
};
