import { describe, expect, it } from "vite-plus/test";

import type { OrchestrationThread, OrchestrationThreadActivity } from "@t3tools/contracts";

import { tokenUsageSuffix } from "./status.ts";

const TS = "2026-01-01T00:00:00.000Z";

const activity = (kind: string, payload: unknown, index: number): OrchestrationThreadActivity => ({
  id: `event-${index}` as OrchestrationThreadActivity["id"],
  tone: "info",
  kind,
  summary: "s",
  payload,
  turnId: null,
  createdAt: TS,
});

const threadWith = (
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): OrchestrationThread => ({
  id: "thread-1" as OrchestrationThread["id"],
  projectId: "project-1" as OrchestrationThread["projectId"],
  title: "t",
  modelSelection: {
    instanceId: "claude",
    model: "claude-fable-5",
  } as OrchestrationThread["modelSelection"],
  runtimeMode: "approval-required",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: TS,
  updatedAt: TS,
  archivedAt: null,
  deletedAt: null,
  messages: [],
  proposedPlans: [],
  activities,
  checkpoints: [],
  session: null,
});

const usage = (usedTokens: number, maxTokens?: number) =>
  maxTokens === undefined ? { usedTokens } : { usedTokens, maxTokens };

describe("tokenUsageSuffix", () => {
  it("returns '' when no context-window activity is present (byte-identical no-op)", () => {
    expect(tokenUsageSuffix(threadWith([]))).toBe("");
    expect(tokenUsageSuffix(threadWith([activity("tool.start", { foo: 1 }, 0)]))).toBe("");
  });

  it("renders `pct% used/max` when the window size is known", () => {
    expect(
      tokenUsageSuffix(
        threadWith([activity("context-window.updated", usage(70_000, 1_000_000), 0)]),
      ),
    ).toBe(" · 7% 70k/1M");
    expect(
      tokenUsageSuffix(
        threadWith([activity("context-window.updated", usage(353_100, 1_000_000), 0)]),
      ),
    ).toBe(" · 35% 353.1k/1M");
    expect(
      tokenUsageSuffix(threadWith([activity("context-window.updated", usage(70_000, 200_000), 0)])),
    ).toBe(" · 35% 70k/200k");
  });

  it("clamps the percentage at 100 when used exceeds max", () => {
    expect(
      tokenUsageSuffix(
        threadWith([activity("context-window.updated", usage(250_000, 200_000), 0)]),
      ),
    ).toBe(" · 100% 250k/200k");
  });

  it("falls back to ` · N tok` when the window size is unknown", () => {
    expect(tokenUsageSuffix(threadWith([activity("context-window.updated", usage(500), 0)]))).toBe(
      " · 500 tok",
    );
    expect(tokenUsageSuffix(threadWith([activity("context-window.updated", usage(1234), 0)]))).toBe(
      " · 1.2k tok",
    );
    expect(
      tokenUsageSuffix(threadWith([activity("context-window.updated", usage(1_500_000), 0)])),
    ).toBe(" · 1.5M tok");
  });

  it("uses the LATEST context-window activity (scans back)", () => {
    const thread = threadWith([
      activity("context-window.updated", usage(1000, 1_000_000), 0),
      activity("tool.start", {}, 1),
      activity("context-window.updated", usage(2000, 1_000_000), 2),
    ]);
    expect(tokenUsageSuffix(thread)).toBe(" · 0% 2k/1M");
  });

  it("skips a malformed usage activity and falls back to an older well-formed one", () => {
    const thread = threadWith([
      activity("context-window.updated", usage(1500), 0),
      activity("context-window.updated", { notUsedTokens: 9 }, 1),
    ]);
    expect(tokenUsageSuffix(thread)).toBe(" · 1.5k tok");
  });

  it("returns '' when the only usage activity is malformed", () => {
    const thread = threadWith([activity("context-window.updated", { usedTokens: "nope" }, 0)]);
    expect(tokenUsageSuffix(thread)).toBe("");
  });
});
