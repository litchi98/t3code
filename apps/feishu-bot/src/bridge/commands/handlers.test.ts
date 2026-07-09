/**
 * M-1: slash-command handler tests — the `/workspace` family (list / switch
 * gates / add argument parsing) and the `/resume` selected-project ownership
 * checks. Exercises `buildCommandTable` through `tryHandleCommand` with fully
 * faked {@link CommandDeps}, so no gateway/registry is involved.
 */
import { assert, describe, it } from "@effect/vitest";
import {
  FEISHU_COMMAND_REGISTRY,
  type OrchestrationProjectShell,
  OrchestrationShellSnapshot,
  ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as NodeOS from "node:os";

import {
  buildCommandTable,
  type CommandDeps,
  defaultCloneDestination,
  HELP_SECTIONS,
  isGitUrl,
  normalizeLocalWorkspacePath,
  repoNameOf,
  WorkspaceCommandError,
} from "./handlers.ts";
import { tryHandleCommand } from "./registry.ts";
import type { EffectiveChatConfig } from "../chatConfig.ts";
import { refusesFullAccessTakeover } from "../chatThreadMap.ts";
import type { ChatBinding } from "../bindingState.ts";
import type { ShellSnapshotCache } from "../shellCache.ts";
import type { InboundMessage } from "../../lark/types.ts";

const PROJECT_A = ProjectId.make("11111111-1111-4111-8111-111111111111");
const PROJECT_B = ProjectId.make("22222222-2222-4222-8222-222222222222");

const decodeSnapshot = Schema.decodeUnknownSync(OrchestrationShellSnapshot);

const TIMESTAMP = "2026-01-01T00:00:00.000Z";

const projectFixture = (id: ProjectId, title: string, workspaceRoot: string) => ({
  id,
  title,
  workspaceRoot,
  defaultModelSelection: null,
  scripts: [],
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
});

const threadFixture = (id: string, projectId: ProjectId, title: string) => ({
  id,
  projectId,
  title,
  modelSelection: { instanceId: "claude", model: "claude-fable-5" },
  runtimeMode: "full-access",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
  archivedAt: null,
  session: null,
  latestUserMessageAt: TIMESTAMP,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
});

/** The default two-project / two-thread snapshot most tests use. */
const defaultSnapshot = decodeSnapshot({
  snapshotSequence: 1,
  projects: [
    projectFixture(PROJECT_A, "alpha", "/repos/alpha"),
    projectFixture(PROJECT_B, "beta", "/repos/beta"),
  ],
  threads: [
    threadFixture("thread-a", PROJECT_A, "session in alpha"),
    threadFixture("thread-b", PROJECT_B, "session in beta"),
  ],
  updatedAt: TIMESTAMP,
});

/** An inbound message carrying `text` (p2p by default; group for gate tests). */
const message = (text: string, chatType: "p2p" | "group" = "p2p"): InboundMessage => ({
  chatId: "oc_test_chat",
  chatType,
  messageId: "om_message_1",
  senderId: "ou_sender",
  text,
  attachments: [],
  createTime: 0,
  ...(chatType === "group" ? { chatMode: "group" as const, mentionedBot: true } : {}),
});

/** The composite chat key a GROUP `message()` resolves to (anchorOf → messageId). */
const GROUP_CHAT_KEY = "oc_test_chat:om_message_1";

interface Harness {
  /** The command table, built ONCE per harness (the `/workspace` and `/resume`
   *  ordinal caches live in the table's closure, so rebuilding per call would
   *  wipe them between a listing and the follow-up `<n>` command). */
  readonly table: ReturnType<typeof buildCommandTable>;
  /** Notices sent, in order (text only). */
  readonly notices: Effect.Effect<ReadonlyArray<string>>;
  /** The chat's current selection. */
  readonly selection: (chatKey: string) => Effect.Effect<ProjectId | null>;
  /** startMirror invocations as `[chatKey, threadId]`. */
  readonly mirrors: Effect.Effect<ReadonlyArray<readonly [string, ThreadId]>>;
  /** createWorkspaceProject invocations (workspaceRoot). */
  readonly createdRoots: Effect.Effect<ReadonlyArray<string>>;
  /** cloneRepository invocations as `[remoteUrl, destinationPath]`. */
  readonly clones: Effect.Effect<ReadonlyArray<readonly [string, string]>>;
  /** M-3: chatIds passed to `deps.authz.config`, to assert the BARE-chatId grain. */
  readonly configChatIds: Effect.Effect<ReadonlyArray<string>>;
}

interface HarnessOptions {
  readonly snapshot?: OrchestrationShellSnapshot | null;
  readonly busy?: boolean;
  readonly binding?: ChatBinding | null;
  readonly initialSelection?: readonly [string, ProjectId];
  /** Fail `cloneRepository` with this message instead of succeeding. */
  readonly cloneFailure?: string;
  /** Simulate a buffered first-contact create pending for every chat (fix C①). */
  readonly pendingCreate?: boolean;
  /** M-3: per-chat workspace allowlist (`effectiveChatConfig.workspaces`); undefined = unrestricted. */
  readonly workspaces?: ReadonlyArray<string>;
  /** M-3: per-chat command allowlist (`effectiveChatConfig.commands`); undefined = unrestricted. */
  readonly commands?: ReadonlyArray<string>;
  /** M-3: the binding owner open_id (`ownerRef`); undefined = null (no owner, so no exemption). */
  readonly owner?: string;
}

const makeHarness = (options: HarnessOptions = {}): Effect.Effect<Harness> =>
  Effect.gen(function* () {
    const snapshot = options.snapshot === undefined ? defaultSnapshot : options.snapshot;
    const notices = yield* Ref.make<ReadonlyArray<string>>([]);
    const selections = yield* Ref.make<ReadonlyMap<string, ProjectId>>(
      new Map(options.initialSelection === undefined ? [] : [options.initialSelection]),
    );
    const mirrors = yield* Ref.make<ReadonlyArray<readonly [string, ThreadId]>>([]);
    const createdRoots = yield* Ref.make<ReadonlyArray<string>>([]);
    const clones = yield* Ref.make<ReadonlyArray<readonly [string, string]>>([]);
    const configChatIds = yield* Ref.make<ReadonlyArray<string>>([]);

    const shellCache: ShellSnapshotCache = {
      current: Effect.succeed(snapshot),
      activeThreads: Effect.succeed(
        (snapshot?.threads ?? []).filter((thread) => thread.archivedAt === null),
      ),
      threadById: (id) =>
        Effect.succeed(snapshot?.threads.find((thread) => thread.id === id) ?? null),
      snapshotAndChanges: (() => {
        throw new Error("snapshotAndChanges is not consumed by command handlers");
      }) as never,
      firstSnapshot: Effect.die("firstSnapshot is not consumed by command handlers"),
    };

    const deps: CommandDeps = {
      sendNotice: (_chatKey, text) => Ref.update(notices, (all) => [...all, text]),
      bindings: {
        get: () => Effect.succeed(options.binding ?? null),
        bind: () => Effect.void,
        unbind: () => Effect.void,
        entries: Effect.succeed([]),
      },
      shellCache,
      startMirror: (chatKey, threadId) =>
        Ref.update(mirrors, (all) => [...all, [chatKey, threadId] as const]),
      stopMirror: () => Effect.void,
      clearNoticeMemory: () => Effect.void,
      clearResolvedNotices: () => Effect.void,
      isChatBusy: () => Effect.succeed(options.busy ?? false),
      workspace: {
        get: (chatKey) => Ref.get(selections).pipe(Effect.map((map) => map.get(chatKey) ?? null)),
        select: (chatKey, projectId) =>
          Ref.update(selections, (map) => new Map(map).set(chatKey, projectId)),
      },
      createWorkspaceProject: (workspaceRoot) =>
        Ref.update(createdRoots, (all) => [...all, workspaceRoot]).pipe(
          Effect.as({
            ...projectFixture(PROJECT_B, "created", workspaceRoot),
            title: "created",
          } as OrchestrationProjectShell),
        ),
      cloneRepository: (remoteUrl, destinationPath) =>
        options.cloneFailure !== undefined
          ? Effect.fail(new WorkspaceCommandError({ message: options.cloneFailure }))
          : Ref.update(clones, (all) => [...all, [remoteUrl, destinationPath] as const]).pipe(
              Effect.as(`${destinationPath}/checkout`),
            ),
      hasPendingCreate: () => Effect.succeed(options.pendingCreate ?? false),
      authz: {
        owner: Effect.succeed(options.owner ?? null),
        config: (chatId) =>
          Ref.update(configChatIds, (all) => [...all, chatId]).pipe(
            Effect.as({
              approvalMode: "initiator",
              approvers: [],
              workspaces: options.workspaces,
              commands: options.commands,
              toolPolicy: undefined,
              density: undefined,
            } satisfies EffectiveChatConfig),
          ),
      },
    };

    return {
      table: buildCommandTable(deps),
      notices: Ref.get(notices),
      selection: (chatKey) =>
        Ref.get(selections).pipe(Effect.map((map) => map.get(chatKey) ?? null)),
      mirrors: Ref.get(mirrors),
      createdRoots: Ref.get(createdRoots),
      clones: Ref.get(clones),
      configChatIds: Ref.get(configChatIds),
    } satisfies Harness;
  });

/** Run one command line through the harness's (stable) command table. The
 *  `isCommandAllowed` predicate defaults to "allow all" (the M-1 tests exercise
 *  handlers directly); M-3 command-allowlist tests pass a real predicate. */
const run = (
  harness: Harness,
  text: string,
  chatType: "p2p" | "group" = "p2p",
  isCommandAllowed: (command: string) => boolean = () => true,
) => tryHandleCommand(message(text, chatType), harness.table, isCommandAllowed);

const lastNotice = (harness: Harness) =>
  harness.notices.pipe(
    Effect.map((all) => Option.fromUndefinedOr(all[all.length - 1])),
    Effect.map(Option.getOrElse(() => "")),
  );

describe("command registry parity (M-3 PR-C)", () => {
  it.effect("the built command table's keys match the contracts registry tokens", () =>
    Effect.gen(function* () {
      // The web command-allowlist editor renders `FEISHU_COMMAND_REGISTRY`; if the
      // bot ever adds/removes a command without updating the registry, the editor
      // silently drifts. Assert the two are exactly the same command set.
      const harness = yield* makeHarness();
      const tableTokens = [...harness.table.keys()].sort();
      const registryTokens = FEISHU_COMMAND_REGISTRY.map((command) => command.token).sort();
      assert.deepStrictEqual(tableTokens, registryTokens);
    }),
  );

  it("HELP_SECTIONS advertises exactly the registry's command set (order-independent)", () => {
    // `/help` filters HELP_SECTIONS through `authorizeCommand`, so a command missing
    // here is never advertised even where it is allowlisted (and a stale entry
    // advertises a removed command). The parity test above only guards the table
    // keys; assert the help surface stays in sync with the registry too.
    const helpTokens = HELP_SECTIONS.map((section) => section.command).sort();
    const registryTokens = FEISHU_COMMAND_REGISTRY.map((command) => command.token).sort();
    assert.deepStrictEqual(helpTokens, registryTokens);
  });
});

describe("/workspace", () => {
  it.effect("lists projects with ordinals and marks the current selection", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        initialSelection: ["oc_test_chat", PROJECT_B],
      });
      const outcome = yield* run(harness, "/workspace");
      assert.isTrue(outcome.handled);
      const notice = yield* lastNotice(harness);
      assert.include(notice, "[1] alpha · /repos/alpha · id 11111111");
      assert.include(notice, "[2] beta · /repos/beta · id 22222222 ✅ 当前");
    }),
  );

  it.effect("prompts to add when the server has no projects", () =>
    Effect.gen(function* () {
      const empty = decodeSnapshot({
        snapshotSequence: 1,
        projects: [],
        threads: [],
        updatedAt: TIMESTAMP,
      });
      const harness = yield* makeHarness({ snapshot: empty });
      yield* run(harness, "/workspace");
      assert.include(yield* lastNotice(harness), "/workspace add");
    }),
  );

  it.effect("switches by ordinal from the last listing", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* run(harness, "/workspace"); // populate the ordinal cache
      yield* run(harness, "/workspace 2");
      assert.strictEqual(yield* harness.selection("oc_test_chat"), PROJECT_B);
      assert.include(yield* lastNotice(harness), "已切换到工作区: beta");
    }),
  );

  it.effect("switches by title via the explicit switch sub-command", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* run(harness, "/workspace switch alpha");
      assert.strictEqual(yield* harness.selection("oc_test_chat"), PROJECT_A);
    }),
  );

  it.effect("refuses to switch while the chat is busy", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ busy: true });
      yield* run(harness, "/workspace switch alpha");
      assert.strictEqual(yield* harness.selection("oc_test_chat"), null);
      assert.include(yield* lastNotice(harness), "正在处理");
    }),
  );

  it.effect("refuses to switch while the chat is bound (requires /release)", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        binding: { threadId: "thread-a" as ThreadId, origin: "self-created" },
      });
      yield* run(harness, "/workspace switch alpha");
      assert.strictEqual(yield* harness.selection("oc_test_chat"), null);
      assert.include(yield* lastNotice(harness), "/release");
    }),
  );

  it.effect("rejects an add argument that is neither a local path nor a git url", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ owner: "ou_sender" });
      yield* run(harness, "/workspace add relative/path");
      assert.include(yield* lastNotice(harness), "无法识别参数");
      assert.deepStrictEqual(yield* harness.createdRoots, []);
    }),
  );

  it.effect("adds a local absolute path and auto-selects the new project", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ owner: "ou_sender" });
      yield* run(harness, "/workspace add /repos/gamma");
      assert.deepStrictEqual(yield* harness.createdRoots, ["/repos/gamma"]);
      assert.strictEqual(yield* harness.selection("oc_test_chat"), PROJECT_B);
      assert.include(yield* lastNotice(harness), "已添加工作区,已切换");
    }),
  );

  it.effect("re-selects an existing project instead of double-adding its root", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ owner: "ou_sender" });
      yield* run(harness, "/workspace add /repos/alpha");
      assert.deepStrictEqual(yield* harness.createdRoots, []);
      assert.strictEqual(yield* harness.selection("oc_test_chat"), PROJECT_A);
    }),
  );

  it.effect("clones a git url into the derived default destination", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ owner: "ou_sender" });
      yield* run(harness, "/workspace add https://github.com/acme/widget.git");
      assert.deepStrictEqual(yield* harness.clones, [
        ["https://github.com/acme/widget.git", "~/t3-workspaces/widget"],
      ]);
      // The clone's checkout cwd (not the raw dest) feeds project creation.
      assert.deepStrictEqual(yield* harness.createdRoots, ["~/t3-workspaces/widget/checkout"]);
      assert.strictEqual(yield* harness.selection("oc_test_chat"), PROJECT_B);
    }),
  );

  it.effect("passes an explicit clone destination through", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ owner: "ou_sender" });
      yield* run(harness, "/workspace add git@github.com:acme/widget.git /custom/dest");
      assert.deepStrictEqual(yield* harness.clones, [
        ["git@github.com:acme/widget.git", "/custom/dest"],
      ]);
    }),
  );

  it.effect("surfaces a clone failure as a notice and selects nothing", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        cloneFailure: "克隆失败: no route",
        owner: "ou_sender",
      });
      yield* run(harness, "/workspace add https://github.com/acme/widget.git");
      assert.include(yield* lastNotice(harness), "克隆失败");
      assert.strictEqual(yield* harness.selection("oc_test_chat"), null);
    }),
  );
});

describe("/resume ownership (M-1)", () => {
  it.effect("requires a selected workspace before listing", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* run(harness, "/resume");
      assert.include(yield* lastNotice(harness), "/workspace");
      assert.deepStrictEqual(yield* harness.mirrors, []);
    }),
  );

  it.effect("lists only the selected workspace's threads", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        initialSelection: ["oc_test_chat", PROJECT_A],
      });
      yield* run(harness, "/resume");
      const notice = yield* lastNotice(harness);
      assert.include(notice, "session in alpha");
      assert.notInclude(notice, "session in beta");
    }),
  );

  it.effect("requires a selected workspace before a targeted takeover", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* run(harness, "/resume thread-a");
      assert.include(yield* lastNotice(harness), "/workspace");
      assert.deepStrictEqual(yield* harness.mirrors, []);
    }),
  );

  it.effect("refuses a takeover of another workspace's thread", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        initialSelection: ["oc_test_chat", PROJECT_A],
      });
      yield* run(harness, "/resume thread-b");
      assert.include(yield* lastNotice(harness), "不属于当前选中的工作区");
      assert.deepStrictEqual(yield* harness.mirrors, []);
    }),
  );

  it.effect("hands a same-workspace takeover to startMirror", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        initialSelection: ["oc_test_chat", PROJECT_A],
      });
      yield* run(harness, "/resume thread-a");
      const mirrors = yield* harness.mirrors;
      assert.deepStrictEqual(mirrors, [["oc_test_chat", "thread-a" as ThreadId]]);
    }),
  );
});

describe("M-3 per-chat command allowlist + workspace authorization", () => {
  // ── command allowlist (registry predicate) ──
  it.effect("a denied command returns deniedCommand and does NOT run its handler", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      // Predicate denies /workspace (as a per-chat allowlist without it would).
      const outcome = yield* run(harness, "/workspace", "p2p", (cmd) => cmd !== "/workspace");
      assert.isTrue(outcome.handled);
      assert.strictEqual(outcome.deniedCommand, "/workspace");
      // handler never ran → no listing notice was sent
      assert.deepStrictEqual(yield* harness.notices, []);
    }),
  );

  it.effect("an allowed command runs its handler (no deniedCommand)", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const outcome = yield* run(harness, "/workspace", "p2p", () => true);
      assert.isTrue(outcome.handled);
      assert.strictEqual(outcome.deniedCommand, undefined);
      assert.include(yield* lastNotice(harness), "可选工作区");
    }),
  );

  // ── /help reflects the allowlist (lists only what actually runs here) ──
  it.effect("/help lists only allowlisted + floor commands", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ commands: ["/status"] });
      yield* run(harness, "/help");
      const notice = yield* lastNotice(harness);
      assert.include(notice, "/status"); // allowlisted
      assert.include(notice, "/whoami"); // floor
      assert.include(notice, "/help"); // floor
      assert.notInclude(notice, "/workspace"); // not allowlisted → hidden
      assert.notInclude(notice, "/resume");
    }),
  );

  it.effect("/help lists everything when no command allowlist is set", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(); // commands undefined
      yield* run(harness, "/help");
      const notice = yield* lastNotice(harness);
      assert.include(notice, "/workspace");
      assert.include(notice, "/resume");
    }),
  );

  it.effect("owner /help lists everything despite an allowlist (owner-always)", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ commands: ["/status"], owner: "ou_sender" });
      yield* run(harness, "/help");
      assert.include(yield* lastNotice(harness), "/workspace");
    }),
  );

  // ── workspace authorization (handler gates) ──
  it.effect("lists only authorized workspaces (list filter)", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ workspaces: [PROJECT_A] });
      yield* run(harness, "/workspace");
      const notice = yield* lastNotice(harness);
      assert.include(notice, "alpha");
      assert.notInclude(notice, "beta");
    }),
  );

  it.effect("an empty allowlist lists nothing, with an authz hint (not the add hint)", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ workspaces: [] });
      yield* run(harness, "/workspace");
      assert.include(yield* lastNotice(harness), "未授权任何工作区");
    }),
  );

  it.effect("switch by ordinal only sees authorized projects (ordinal cache is filtered)", () =>
    Effect.gen(function* () {
      // PROJECT_B is the SECOND project, so filtering must make it ordinal [1]. If
      // the ordinal cache were UNfiltered, [1] would be alpha (unauthorized) → the
      // switch gate refuses → selection stays null, failing this assertion. Using
      // PROJECT_B (not the first project) is what makes this test able to falsify
      // "the cache is filtered".
      const harness = yield* makeHarness({ workspaces: [PROJECT_B] });
      yield* run(harness, "/workspace"); // populate ordinals from the FILTERED list
      yield* run(harness, "/workspace 1"); // [1] must be beta (alpha filtered out)
      assert.strictEqual(yield* harness.selection("oc_test_chat"), PROJECT_B);
    }),
  );

  it.effect("refuses switching to an unauthorized workspace", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ workspaces: [PROJECT_A] });
      yield* run(harness, "/workspace switch beta");
      assert.strictEqual(yield* harness.selection("oc_test_chat"), null);
      assert.include(yield* lastNotice(harness), "未在本群授权");
    }),
  );

  it.effect("owner may switch to an unauthorized workspace (owner-always overlay)", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ workspaces: [PROJECT_A], owner: "ou_sender" });
      yield* run(harness, "/workspace switch beta");
      assert.strictEqual(yield* harness.selection("oc_test_chat"), PROJECT_B);
    }),
  );

  it.effect("a non-owner cannot add a workspace (owner-only, even with no allowlist)", () =>
    Effect.gen(function* () {
      // owner-only add: a non-owner is refused regardless of the workspace
      // allowlist — even with NO allowlist set (the pre-M-3 "anyone can add").
      const harness = yield* makeHarness();
      yield* run(harness, "/workspace add /repos/gamma");
      assert.deepStrictEqual(yield* harness.createdRoots, []);
      assert.include(yield* lastNotice(harness), "仅 bot 管理员可新增工作区");
    }),
  );

  it.effect("owner may add a workspace (owner-only gate passes for owner)", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ owner: "ou_sender" });
      yield* run(harness, "/workspace add /repos/gamma");
      assert.deepStrictEqual(yield* harness.createdRoots, ["/repos/gamma"]);
    }),
  );

  it.effect("/resume refuses a selected workspace narrowed out of the allowlist", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        initialSelection: ["oc_test_chat", PROJECT_A],
        workspaces: [PROJECT_B],
      });
      yield* run(harness, "/resume");
      assert.include(yield* lastNotice(harness), "不在本群授权范围");
      assert.deepStrictEqual(yield* harness.mirrors, []);
    }),
  );

  it.effect("owner /resume bypasses the workspace allowlist", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        initialSelection: ["oc_test_chat", PROJECT_A],
        workspaces: [PROJECT_B],
        owner: "ou_sender",
      });
      yield* run(harness, "/resume");
      assert.include(yield* lastNotice(harness), "session in alpha");
    }),
  );

  // resumeTarget is a SEPARATE authz gate from listCandidates (the bare `/resume`
  // above) — `/resume <threadId>` must independently ∩ the authorized set.
  it.effect("/resume <threadId> also refuses a workspace narrowed out (resumeTarget gate)", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        initialSelection: ["oc_test_chat", PROJECT_A],
        workspaces: [PROJECT_B],
      });
      yield* run(harness, "/resume thread-a");
      assert.include(yield* lastNotice(harness), "不在本群授权范围");
      assert.deepStrictEqual(yield* harness.mirrors, []);
    }),
  );

  it.effect("owner /resume <threadId> bypasses the workspace allowlist (resumeTarget gate)", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        initialSelection: ["oc_test_chat", PROJECT_A],
        workspaces: [PROJECT_B],
        owner: "ou_sender",
      });
      yield* run(harness, "/resume thread-a");
      assert.deepStrictEqual(yield* harness.mirrors, [["oc_test_chat", "thread-a" as ThreadId]]);
    }),
  );

  it.effect("resolves per-chat config by BARE chatId, not the composite chat key", () =>
    Effect.gen(function* () {
      // A GROUP message's composite chat key is `oc_test_chat:om_message_1`; the
      // per-chat config MUST still resolve by the bare `oc_test_chat` (the approval
      // gate's grain), or a topic/group's config would never be found.
      const harness = yield* makeHarness({ workspaces: [PROJECT_A] });
      yield* run(harness, "/workspace", "group");
      const ids = yield* harness.configChatIds;
      assert.isAbove(ids.length, 0);
      for (const id of ids) {
        assert.strictEqual(id, "oc_test_chat");
      }
    }),
  );

  it.effect("unrestricted (undefined allowlist) is byte-identical to M-1 behavior", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(); // workspaces undefined
      yield* run(harness, "/workspace switch beta");
      assert.strictEqual(yield* harness.selection("oc_test_chat"), PROJECT_B);
    }),
  );
});

describe("/workspace review fixes (C/E/G/H)", () => {
  it.effect("C①: refuses to switch while a buffered create is pending", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ pendingCreate: true });
      yield* run(harness, "/workspace switch alpha");
      assert.strictEqual(yield* harness.selection("oc_test_chat"), null);
      assert.include(yield* lastNotice(harness), "排队中的消息");
    }),
  );

  it.effect("E: add while bound still creates but does NOT auto-switch", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        binding: { threadId: "thread-a" as ThreadId, origin: "self-created" },
        owner: "ou_sender",
      });
      yield* run(harness, "/workspace add /repos/gamma");
      assert.deepStrictEqual(yield* harness.createdRoots, ["/repos/gamma"]);
      assert.strictEqual(yield* harness.selection("oc_test_chat"), null);
      const notice = yield* lastNotice(harness);
      assert.include(notice, "已添加工作区");
      assert.include(notice, "仍在使用原工作区");
      assert.notInclude(notice, "已切换:");
    }),
  );

  it.effect("E: add while busy still creates but does NOT auto-switch", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ busy: true, owner: "ou_sender" });
      yield* run(harness, "/workspace add /repos/gamma");
      assert.deepStrictEqual(yield* harness.createdRoots, ["/repos/gamma"]);
      assert.strictEqual(yield* harness.selection("oc_test_chat"), null);
      assert.include(yield* lastNotice(harness), "仍在使用原工作区");
    }),
  );

  it.effect("G: a trailing-slash path reuses the existing project", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ owner: "ou_sender" });
      yield* run(harness, "/workspace add /repos/alpha/");
      assert.deepStrictEqual(yield* harness.createdRoots, []);
      assert.strictEqual(yield* harness.selection("oc_test_chat"), PROJECT_A);
    }),
  );

  it.effect("H: switches by a unique projectId prefix", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* run(harness, "/workspace switch 22222222");
      assert.strictEqual(yield* harness.selection("oc_test_chat"), PROJECT_B);
    }),
  );

  it.effect("H: duplicate titles point at the short id, not the title", () =>
    Effect.gen(function* () {
      const twin = decodeSnapshot({
        snapshotSequence: 1,
        projects: [
          projectFixture(PROJECT_A, "twin", "/repos/one"),
          projectFixture(PROJECT_B, "twin", "/repos/two"),
        ],
        threads: [],
        updatedAt: TIMESTAMP,
      });
      const harness = yield* makeHarness({ snapshot: twin });
      yield* run(harness, "/workspace switch twin");
      assert.strictEqual(yield* harness.selection("oc_test_chat"), null);
      assert.include(yield* lastNotice(harness), "短 id");
    }),
  );
});

describe("full-access takeover gate (D)", () => {
  it("refuses only approval-required → full-access", () => {
    assert.isTrue(refusesFullAccessTakeover("approval-required", "full-access"));
    assert.isFalse(refusesFullAccessTakeover("approval-required", "approval-required"));
    assert.isFalse(refusesFullAccessTakeover("full-access", "full-access"));
    assert.isFalse(refusesFullAccessTakeover("full-access", "approval-required"));
  });

  it.effect("a group /resume of a full-access thread is refused via the shared predicate", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        initialSelection: [GROUP_CHAT_KEY, PROJECT_A],
      });
      // `thread-a` is full-access in the fixture; the group's required mode is
      // approval-required → the shared gate must refuse the takeover.
      yield* run(harness, "/resume thread-a", "group");
      assert.include(yield* lastNotice(harness), "full-access");
      assert.deepStrictEqual(yield* harness.mirrors, []);
    }),
  );
});

describe("local path normalization (G)", () => {
  it("strips trailing slashes and keeps absolute paths", () => {
    assert.strictEqual(normalizeLocalWorkspacePath("/repos/alpha/"), "/repos/alpha");
    assert.strictEqual(normalizeLocalWorkspacePath("/repos/alpha"), "/repos/alpha");
    assert.strictEqual(normalizeLocalWorkspacePath("/"), "/");
  });

  it("expands a leading ~ against the local home", () => {
    const home = NodeOS.homedir();
    assert.strictEqual(normalizeLocalWorkspacePath("~"), home);
    assert.strictEqual(normalizeLocalWorkspacePath("~/repos/x"), `${home}/repos/x`);
  });
});

describe("clone destination helpers", () => {
  it("classifies git urls", () => {
    assert.isTrue(isGitUrl("https://github.com/acme/widget.git"));
    assert.isTrue(isGitUrl("git@github.com:acme/widget.git"));
    assert.isTrue(isGitUrl("ssh://git@github.com/acme/widget"));
    assert.isTrue(isGitUrl("acme/widget.git"));
    assert.isFalse(isGitUrl("relative/path"));
    assert.isFalse(isGitUrl("widget"));
  });

  it("derives repo names", () => {
    assert.strictEqual(repoNameOf("https://github.com/acme/widget.git"), "widget");
    assert.strictEqual(repoNameOf("git@github.com:acme/widget.git"), "widget");
    assert.strictEqual(repoNameOf("https://github.com/acme/widget/"), "widget");
    assert.strictEqual(repoNameOf(""), "repo");
  });

  it("derives the default clone destination", () => {
    assert.strictEqual(
      defaultCloneDestination("https://github.com/acme/widget.git"),
      "~/t3-workspaces/widget",
    );
  });
});
