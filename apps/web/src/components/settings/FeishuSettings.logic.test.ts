import { describe, expect, it } from "vite-plus/test";

import {
  chatModeSelection,
  defaultsModeSelection,
  isChatConfigEmpty,
  setConfigApprovalMode,
  setDefaultsApprovalMode,
  toggleApprover,
  toggleConfigApprover,
  toggleDefaultsApprover,
  writeChatConfig,
} from "./FeishuSettings.logic.ts";

const CHAT = "oc_group_a";
const OTHER = "oc_group_b";

describe("toggleApprover", () => {
  it("adds an absent open_id and removes a present one", () => {
    expect(toggleApprover([], "ou_a")).toEqual(["ou_a"]);
    expect(toggleApprover(["ou_a", "ou_b"], "ou_a")).toEqual(["ou_b"]);
  });
});

describe("setConfigApprovalMode — approvers present iff designated", () => {
  it("switching to designated materializes an explicit empty roster (owner-only, no inheritance)", () => {
    expect(setConfigApprovalMode({}, "designated")).toEqual({
      approvalMode: "designated",
      approvers: [],
    });
  });

  it("switching to all/initiator drops any approvers", () => {
    expect(
      setConfigApprovalMode({ approvalMode: "designated", approvers: ["ou_a"] }, "all"),
    ).toEqual({ approvalMode: "all" });
    expect(setConfigApprovalMode({}, "initiator")).toEqual({ approvalMode: "initiator" });
  });

  it("switching to inherit clears BOTH mode and approvers (full inherit)", () => {
    expect(
      setConfigApprovalMode({ approvalMode: "designated", approvers: ["ou_a"] }, "inherit"),
    ).toEqual({});
  });

  it("preserves M-3 fields (workspaces/commands/toolPolicy) across mode changes", () => {
    expect(setConfigApprovalMode({ commands: ["/status"] }, "all")).toEqual({
      commands: ["/status"],
      approvalMode: "all",
    });
    // inherit drops approval fields but keeps the M-3 override
    expect(
      setConfigApprovalMode(
        { commands: ["/status"], approvalMode: "designated", approvers: ["ou_a"] },
        "inherit",
      ),
    ).toEqual({ commands: ["/status"] });
  });
});

describe("toggleConfigApprover", () => {
  it("adds then removes, keeping the roster PRESENT (empty [], not dropped) while designated", () => {
    const one = toggleConfigApprover({ approvalMode: "designated", approvers: [] }, "ou_a");
    expect(one).toEqual({ approvalMode: "designated", approvers: ["ou_a"] });
    expect(toggleConfigApprover(one, "ou_a")).toEqual({
      approvalMode: "designated",
      approvers: [],
    });
  });

  it("preserves M-3 fields while toggling approvers", () => {
    expect(toggleConfigApprover({ approvalMode: "designated", commands: ["/x"] }, "ou_a")).toEqual({
      approvalMode: "designated",
      commands: ["/x"],
      approvers: ["ou_a"],
    });
  });
});

describe("writeChatConfig — whole-map replacement", () => {
  it("drops the entry when it is an inherit-everything no-op", () => {
    expect(writeChatConfig({ [CHAT]: { approvalMode: "all" } }, CHAT, {})).toEqual({});
  });

  it("KEEPS a designated entry with an empty roster (owner-only override, not inheritance)", () => {
    expect(writeChatConfig({}, CHAT, { approvalMode: "designated", approvers: [] })).toEqual({
      [CHAT]: { approvalMode: "designated", approvers: [] },
    });
  });

  it("strips approvers from a non-designated entry", () => {
    expect(writeChatConfig({}, CHAT, { approvalMode: "all", approvers: ["ou_a"] })).toEqual({
      [CHAT]: { approvalMode: "all" },
    });
  });

  it("carries OTHER chats' entries through unchanged when writing one chat", () => {
    const base = { [OTHER]: { approvalMode: "all" as const } };
    expect(
      writeChatConfig(base, CHAT, { approvalMode: "designated", approvers: ["ou_a"] }),
    ).toEqual({
      [OTHER]: { approvalMode: "all" },
      [CHAT]: { approvalMode: "designated", approvers: ["ou_a"] },
    });
  });

  it("drops only the target chat, preserving siblings", () => {
    const base = {
      [OTHER]: { approvalMode: "all" as const },
      [CHAT]: { approvalMode: "all" as const },
    };
    expect(writeChatConfig(base, CHAT, {})).toEqual({ [OTHER]: { approvalMode: "all" } });
  });
});

describe("chatModeSelection", () => {
  it("returns inherit for a chat without an explicit mode", () => {
    expect(chatModeSelection(undefined)).toBe("inherit");
    expect(chatModeSelection({ approvers: ["ou_a"] })).toBe("inherit");
    expect(chatModeSelection({ approvalMode: "all" })).toBe("all");
  });
});

describe("defaults setters", () => {
  it("defaultsModeSelection falls back to built-in initiator", () => {
    expect(defaultsModeSelection({})).toBe("initiator");
    expect(defaultsModeSelection({ approvalMode: "designated" })).toBe("designated");
  });

  it("setDefaultsApprovalMode materializes/drops approvers by mode", () => {
    expect(setDefaultsApprovalMode({}, "all")).toEqual({ approvalMode: "all" });
    expect(setDefaultsApprovalMode({ approvers: ["ou_a"] }, "designated")).toEqual({
      approvalMode: "designated",
      approvers: ["ou_a"],
    });
    expect(
      setDefaultsApprovalMode({ approvalMode: "designated", approvers: ["ou_a"] }, "initiator"),
    ).toEqual({ approvalMode: "initiator" });
  });

  it("toggleDefaultsApprover keeps the designated mode and an empty roster present", () => {
    expect(toggleDefaultsApprover({ approvalMode: "designated" }, "ou_a")).toEqual({
      approvalMode: "designated",
      approvers: ["ou_a"],
    });
    expect(
      toggleDefaultsApprover({ approvalMode: "designated", approvers: ["ou_a"] }, "ou_a"),
    ).toEqual({ approvalMode: "designated", approvers: [] });
  });
});

describe("isChatConfigEmpty", () => {
  it("is true only when every field is absent/empty", () => {
    expect(isChatConfigEmpty({})).toBe(true);
    expect(isChatConfigEmpty({ approvers: [] })).toBe(true);
    expect(isChatConfigEmpty({ approvalMode: "initiator" })).toBe(false);
    expect(isChatConfigEmpty({ approvalMode: "designated", approvers: [] })).toBe(false);
    expect(isChatConfigEmpty({ commands: [] })).toBe(false);
  });
});
