/**
 * M-1: slash-command handler tests — the `/workspace` family (list / switch
 * gates / add argument parsing) and the `/resume` selected-project ownership
 * checks. Exercises `buildCommandTable` through `tryHandleCommand` with fully
 * faked {@link CommandDeps}, so no gateway/registry is involved.
 */
import { assert, describe, it } from "@effect/vitest";
import {
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
  isGitUrl,
  normalizeLocalWorkspacePath,
  repoNameOf,
  WorkspaceCommandError,
} from "./handlers.ts";
import { tryHandleCommand } from "./registry.ts";
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

    const shellCache: ShellSnapshotCache = {
      current: Effect.succeed(snapshot),
      activeThreads: Effect.succeed(
        (snapshot?.threads ?? []).filter((thread) => thread.archivedAt === null),
      ),
      threadById: (id) =>
        Effect.succeed(snapshot?.threads.find((thread) => thread.id === id) ?? null),
      changes: (() => {
        throw new Error("changes is not consumed by command handlers");
      }) as never,
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
    };

    return {
      table: buildCommandTable(deps),
      notices: Ref.get(notices),
      selection: (chatKey) =>
        Ref.get(selections).pipe(Effect.map((map) => map.get(chatKey) ?? null)),
      mirrors: Ref.get(mirrors),
      createdRoots: Ref.get(createdRoots),
      clones: Ref.get(clones),
    } satisfies Harness;
  });

/** Run one command line through the harness's (stable) command table. */
const run = (harness: Harness, text: string, chatType: "p2p" | "group" = "p2p") =>
  tryHandleCommand(message(text, chatType), harness.table);

const lastNotice = (harness: Harness) =>
  harness.notices.pipe(
    Effect.map((all) => Option.fromUndefinedOr(all[all.length - 1])),
    Effect.map(Option.getOrElse(() => "")),
  );

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
      const harness = yield* makeHarness();
      yield* run(harness, "/workspace add relative/path");
      assert.include(yield* lastNotice(harness), "无法识别参数");
      assert.deepStrictEqual(yield* harness.createdRoots, []);
    }),
  );

  it.effect("adds a local absolute path and auto-selects the new project", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* run(harness, "/workspace add /repos/gamma");
      assert.deepStrictEqual(yield* harness.createdRoots, ["/repos/gamma"]);
      assert.strictEqual(yield* harness.selection("oc_test_chat"), PROJECT_B);
      assert.include(yield* lastNotice(harness), "已添加工作区,已切换");
    }),
  );

  it.effect("re-selects an existing project instead of double-adding its root", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* run(harness, "/workspace add /repos/alpha");
      assert.deepStrictEqual(yield* harness.createdRoots, []);
      assert.strictEqual(yield* harness.selection("oc_test_chat"), PROJECT_A);
    }),
  );

  it.effect("clones a git url into the derived default destination", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
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
      const harness = yield* makeHarness();
      yield* run(harness, "/workspace add git@github.com:acme/widget.git /custom/dest");
      assert.deepStrictEqual(yield* harness.clones, [
        ["git@github.com:acme/widget.git", "/custom/dest"],
      ]);
    }),
  );

  it.effect("surfaces a clone failure as a notice and selects nothing", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cloneFailure: "克隆失败: no route" });
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
      const harness = yield* makeHarness({ busy: true });
      yield* run(harness, "/workspace add /repos/gamma");
      assert.deepStrictEqual(yield* harness.createdRoots, ["/repos/gamma"]);
      assert.strictEqual(yield* harness.selection("oc_test_chat"), null);
      assert.include(yield* lastNotice(harness), "仍在使用原工作区");
    }),
  );

  it.effect("G: a trailing-slash path reuses the existing project", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
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
