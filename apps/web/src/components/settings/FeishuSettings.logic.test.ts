import { describe, expect, it } from "vite-plus/test";

import {
  chatModeSelection,
  commandsSummary,
  deepEqual,
  defaultsModeSelection,
  defaultsSummary,
  describeInheritedCommands,
  describeInheritedWorkspaces,
  effectiveConfig,
  isChatConfigEmpty,
  isChatOverridden,
  restingChatSummary,
  setConfigApprovalMode,
  setConfigCommands,
  setConfigWorkspaces,
  setDefaultsApprovalMode,
  toggleApprover,
  toggleConfigApprover,
  toggleConfigCommand,
  toggleConfigWorkspace,
  toggleDefaultsApprover,
  workspacesSummary,
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

describe("deepEqual", () => {
  it("compares nested config maps regardless of object key order", () => {
    expect(
      deepEqual(
        { oc_a: { approvalMode: "designated", approvers: ["ou_x"] } },
        { oc_a: { approvers: ["ou_x"], approvalMode: "designated" } },
      ),
    ).toBe(true);
  });

  it("is order-sensitive for arrays and detects differing values/keys", () => {
    expect(deepEqual(["ou_x", "ou_y"], ["ou_y", "ou_x"])).toBe(false);
    expect(
      deepEqual({ oc_a: { approvalMode: "all" } }, { oc_a: { approvalMode: "initiator" } }),
    ).toBe(false);
    expect(deepEqual({ oc_a: {} }, {})).toBe(false);
    expect(deepEqual({}, {})).toBe(true);
  });
});

describe("isChatConfigEmpty", () => {
  it("is true only when every field is absent/empty", () => {
    expect(isChatConfigEmpty({})).toBe(true);
    expect(isChatConfigEmpty({ approvers: [] })).toBe(true);
    expect(isChatConfigEmpty({ approvalMode: "initiator" })).toBe(false);
    expect(isChatConfigEmpty({ approvalMode: "designated", approvers: [] })).toBe(false);
    expect(isChatConfigEmpty({ commands: [] })).toBe(false);
    // Empty workspaces is also a real override ("nobody authorized").
    expect(isChatConfigEmpty({ workspaces: [] })).toBe(false);
  });
});

describe("setConfigCommands / toggleConfigCommand (M-3 PR-C)", () => {
  it("clears the field with undefined (inherit / unrestricted) and keeps a list", () => {
    expect(setConfigCommands({ commands: ["/status"] }, undefined)).toEqual({});
    expect(setConfigCommands({}, ["/status"])).toEqual({ commands: ["/status"] });
    // An empty [] is a real override ("only the floor commands"), NOT dropped.
    expect(setConfigCommands({}, [])).toEqual({ commands: [] });
  });

  it("preserves sibling fields (approval / workspaces) when editing commands", () => {
    expect(setConfigCommands({ approvalMode: "all", workspaces: ["p1"] }, ["/status"])).toEqual({
      approvalMode: "all",
      workspaces: ["p1"],
      commands: ["/status"],
    });
    // Clearing commands leaves the others intact.
    expect(setConfigCommands({ approvalMode: "all", commands: ["/status"] }, undefined)).toEqual({
      approvalMode: "all",
    });
  });

  it("keeps the designated approvers invariant (empty [] present) while editing commands", () => {
    expect(setConfigCommands({ approvalMode: "designated", approvers: [] }, ["/status"])).toEqual({
      approvalMode: "designated",
      approvers: [],
      commands: ["/status"],
    });
  });

  it("toggles a token in/out, materializing an empty list first", () => {
    expect(toggleConfigCommand({}, "/status")).toEqual({ commands: ["/status"] });
    expect(toggleConfigCommand({ commands: ["/status", "/resume"] }, "/status")).toEqual({
      commands: ["/resume"],
    });
    // Toggling the last token off leaves an explicit empty [] (only-floor), not undefined.
    expect(toggleConfigCommand({ commands: ["/status"] }, "/status")).toEqual({ commands: [] });
  });

  it("a chat whose ONLY override is commands is written, and dropped when cleared", () => {
    expect(writeChatConfig({}, CHAT, setConfigCommands({}, ["/status"]))).toEqual({
      [CHAT]: { commands: ["/status"] },
    });
    expect(
      writeChatConfig(
        { [CHAT]: { commands: ["/status"] } },
        CHAT,
        setConfigCommands({}, undefined),
      ),
    ).toEqual({});
  });
});

describe("setConfigWorkspaces / toggleConfigWorkspace (M-3 PR-C)", () => {
  it("clears the field with undefined (inherit / all authorized) and keeps a list", () => {
    expect(setConfigWorkspaces({ workspaces: ["p1"] }, undefined)).toEqual({});
    expect(setConfigWorkspaces({}, ["p1"])).toEqual({ workspaces: ["p1"] });
    // An empty [] is a real override ("nobody authorized"), NOT dropped.
    expect(setConfigWorkspaces({}, [])).toEqual({ workspaces: [] });
  });

  it("preserves sibling fields when editing workspaces", () => {
    expect(setConfigWorkspaces({ approvalMode: "all", commands: ["/status"] }, ["p1"])).toEqual({
      approvalMode: "all",
      commands: ["/status"],
      workspaces: ["p1"],
    });
  });

  it("toggles a projectId in/out, materializing an empty list first", () => {
    expect(toggleConfigWorkspace({}, "p1")).toEqual({ workspaces: ["p1"] });
    expect(toggleConfigWorkspace({ workspaces: ["p1", "p2"] }, "p1")).toEqual({
      workspaces: ["p2"],
    });
    expect(toggleConfigWorkspace({ workspaces: ["p1"] }, "p1")).toEqual({ workspaces: [] });
  });
});

describe("describeInherited* — faithful inherit hints (M-3 PR-C)", () => {
  it("commands hint reflects the actual default, never a blanket 'allows all'", () => {
    // absent default → truly unrestricted
    expect(describeInheritedCommands(undefined)).toContain("允许全部命令");
    // empty default → only the floor commands (NOT "allows all")
    expect(describeInheritedCommands([])).toContain("仅基础命令");
    expect(describeInheritedCommands([])).not.toContain("允许全部");
    // restricted default → count of allowed commands
    expect(describeInheritedCommands(["/status", "/resume"])).toContain("2 项命令");
    expect(describeInheritedCommands(["/status", "/resume"])).not.toContain("允许全部");
  });

  it("workspaces hint says 'nobody' for an empty default, never 'allows all'", () => {
    expect(describeInheritedWorkspaces(undefined)).toContain("允许全部工作区");
    // empty default = NOBODY authorized (opposite of the empty-command case)
    expect(describeInheritedWorkspaces([])).toContain("未授权任何工作区");
    expect(describeInheritedWorkspaces([])).not.toContain("允许全部");
    expect(describeInheritedWorkspaces(["p1"])).toContain("1 个工作区");
    expect(describeInheritedWorkspaces(["p1"])).not.toContain("允许全部");
  });
});

describe("effectiveConfig — field-level fallback mirrors the bot (所见=所判)", () => {
  it("a clean chat resolves every field from defaults, tagged [默认] / built-in [内置]", () => {
    const eff = effectiveConfig(
      CHAT,
      {},
      { approvalMode: "designated", approvers: ["ou_x"], commands: ["/status"] },
    );
    expect(eff.approvalMode).toEqual({ value: "designated", source: "default" });
    expect(eff.approvers).toEqual({ value: ["ou_x"], source: "default" });
    expect(eff.commands).toEqual({ value: ["/status"], source: "default" });
    // no default workspaces → built-in unrestricted
    expect(eff.workspaces).toEqual({ value: undefined, source: "builtin" });
  });

  it("built-in fallback when neither chat nor defaults set a field", () => {
    const eff = effectiveConfig(CHAT, {}, {});
    expect(eff.approvalMode).toEqual({ value: "initiator", source: "builtin" });
    expect(eff.approvers).toEqual({ value: [], source: "builtin" });
    expect(eff.commands).toEqual({ value: undefined, source: "builtin" });
    expect(eff.workspaces).toEqual({ value: undefined, source: "builtin" });
  });

  it("per-chat fields win and are tagged [本群]; unset fields still fall back per-field", () => {
    const eff = effectiveConfig(
      CHAT,
      { [CHAT]: { workspaces: ["p1", "p2"] } },
      { approvalMode: "all" },
    );
    // own workspaces override
    expect(eff.workspaces).toEqual({ value: ["p1", "p2"], source: "chat" });
    // approvalMode not set on the chat → inherited from defaults
    expect(eff.approvalMode).toEqual({ value: "all", source: "default" });
  });

  it("an empty per-chat list is a REAL override (source 本群), not inheritance", () => {
    const eff = effectiveConfig(CHAT, { [CHAT]: { commands: [] } }, { commands: ["/status"] });
    // empty own list wins over the non-empty default (bot enforces "only floor")
    expect(eff.commands).toEqual({ value: [], source: "chat" });
  });
});

describe("isChatOverridden", () => {
  it("undefined / empty entries are NOT overrides; a real field is", () => {
    expect(isChatOverridden(undefined)).toBe(false);
    expect(isChatOverridden({})).toBe(false);
    expect(isChatOverridden({ approvers: [] })).toBe(false); // no mode → empty no-op
    expect(isChatOverridden({ commands: [] })).toBe(true);
    expect(isChatOverridden({ approvalMode: "designated", approvers: [] })).toBe(true);
  });
});

describe("summary labels — compact resting/preview text", () => {
  it("commands/workspaces: undefined→全部, []→仅基础/未授权, list→count", () => {
    expect(commandsSummary(undefined)).toBe("全部");
    expect(commandsSummary([])).toBe("仅基础");
    expect(commandsSummary(["/a", "/b"])).toBe("2 项");
    expect(workspacesSummary(undefined)).toBe("全部");
    expect(workspacesSummary([])).toBe("未授权");
    expect(workspacesSummary(["p1"])).toBe("1 个");
  });

  it("clean chat reads '继承默认 · <mode>'; only inherited approval shown", () => {
    const eff = effectiveConfig(CHAT, {}, { approvalMode: "designated", approvers: ["a", "b"] });
    expect(restingChatSummary(eff, false)).toBe("继承默认 · 指定审批人 · 2 人");
  });

  it("overridden chat drops '继承默认' and appends only its OWN overridden dimensions", () => {
    // only workspaces overridden; approval inherited (initiator built-in)
    const eff = effectiveConfig(CHAT, { [CHAT]: { workspaces: ["p1", "p2"] } }, {});
    expect(restingChatSummary(eff, true)).toBe("仅发起人 · 工作区 2 个");
    // an inherited commands restriction is NOT listed (only own overrides), so it
    // doesn't masquerade as this chat's override
    const eff2 = effectiveConfig(CHAT, { [CHAT]: { approvalMode: "all" } }, { commands: [] });
    expect(restingChatSummary(eff2, true)).toBe("任意群成员");
  });

  it("defaultsSummary lists審批/命令/工作区 from the explicit defaults", () => {
    expect(defaultsSummary({})).toEqual([
      { key: "审批", value: "仅发起人" },
      { key: "命令", value: "全部" },
      { key: "工作区", value: "全部" },
    ]);
    expect(
      defaultsSummary({ approvalMode: "designated", approvers: ["a"], workspaces: [] }),
    ).toEqual([
      { key: "审批", value: "指定审批人 · 1 人" },
      { key: "命令", value: "全部" },
      { key: "工作区", value: "未授权" },
    ]);
  });
});
