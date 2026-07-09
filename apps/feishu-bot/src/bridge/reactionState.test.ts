import { describe, expect, it } from "vite-plus/test";

import type {
  OrchestrationLatestTurn,
  OrchestrationSession,
  OrchestrationThread,
} from "@t3tools/contracts";

import {
  REACTION_COMPLETED,
  REACTION_FAILED,
  REACTION_INTERRUPTED,
  terminalReactionEmoji,
} from "./reactionState.ts";

const TS = "2026-01-01T00:00:00.000Z";

const turn = (
  state: OrchestrationLatestTurn["state"],
  settled: boolean,
): OrchestrationLatestTurn => ({
  turnId: "turn-1" as OrchestrationLatestTurn["turnId"],
  state,
  requestedAt: TS,
  startedAt: TS,
  completedAt: settled ? TS : null,
  assistantMessageId: null,
});

const session = (status: OrchestrationSession["status"]): OrchestrationSession => ({
  threadId: "thread-1" as OrchestrationSession["threadId"],
  status,
  providerName: "claude",
  runtimeMode: "approval-required",
  activeTurnId: null,
  lastError: null,
  updatedAt: TS,
});

const makeThread = (
  latestTurn: OrchestrationLatestTurn | null,
  sessionStatus: OrchestrationSession["status"] | null,
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
  latestTurn,
  createdAt: TS,
  updatedAt: TS,
  archivedAt: null,
  deletedAt: null,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: sessionStatus === null ? null : session(sessionStatus),
});

describe("terminalReactionEmoji", () => {
  it("maps a completed turn to the DONE emoji", () => {
    const thread = makeThread(turn("completed", true), "ready");
    expect(terminalReactionEmoji(thread)).toBe(REACTION_COMPLETED);
  });

  it("maps an interrupted turn to the stop emoji (distinct from failure)", () => {
    const thread = makeThread(turn("interrupted", true), "interrupted");
    expect(terminalReactionEmoji(thread)).toBe(REACTION_INTERRUPTED);
    // The whole point of reading the server status: an interrupt is NOT a failure.
    expect(terminalReactionEmoji(thread)).not.toBe(REACTION_FAILED);
  });

  it("maps an errored turn to the CrossMark emoji", () => {
    const thread = makeThread(turn("error", true), "error");
    expect(terminalReactionEmoji(thread)).toBe(REACTION_FAILED);
  });

  it("returns null while the turn is still running (no premature terminal swap)", () => {
    const thread = makeThread(turn("running", false), "running");
    expect(terminalReactionEmoji(thread)).toBeNull();
  });

  it("uses the terminal emoji keys from Feishu's named enum (not unicode)", () => {
    expect(REACTION_COMPLETED).toBe("DONE");
    expect(REACTION_FAILED).toBe("CrossMark");
    expect(REACTION_INTERRUPTED).toBe("GeneralDoNotDisturb");
  });
});
