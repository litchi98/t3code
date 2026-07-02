import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_APPROVAL_MODE, effectiveChatConfig } from "./chatConfig.ts";

const CHAT = "oc_group_a";

describe("effectiveChatConfig — field-level fallback", () => {
  it("falls back to the built-in initiator mode when nothing is configured", () => {
    const eff = effectiveChatConfig(CHAT, {}, {});
    expect(eff.approvalMode).toBe(DEFAULT_APPROVAL_MODE);
    expect(eff.approvalMode).toBe("initiator");
    expect(eff.approvers).toEqual([]);
    expect(eff.workspaces).toBeUndefined();
  });

  it("takes each field independently: per-chat approvalMode + defaults approvers", () => {
    const eff = effectiveChatConfig(
      CHAT,
      { [CHAT]: { approvalMode: "designated" } },
      { approvers: ["ou_default"] },
    );
    // approvalMode from the per-chat entry, approvers falls through to defaults —
    // field-level, NOT object-level (the per-chat entry does not shadow approvers).
    expect(eff.approvalMode).toBe("designated");
    expect(eff.approvers).toEqual(["ou_default"]);
  });

  it("per-chat entry wins over defaults for the same field", () => {
    const eff = effectiveChatConfig(
      CHAT,
      { [CHAT]: { approvalMode: "all", approvers: ["ou_a"] } },
      { approvalMode: "initiator", approvers: ["ou_default"] },
    );
    expect(eff.approvalMode).toBe("all");
    expect(eff.approvers).toEqual(["ou_a"]);
  });

  it("uses defaults for a chat with no per-chat entry", () => {
    const eff = effectiveChatConfig(
      "oc_unknown",
      { [CHAT]: { approvalMode: "all" } },
      {
        approvalMode: "designated",
        approvers: ["ou_default"],
      },
    );
    expect(eff.approvalMode).toBe("designated");
    expect(eff.approvers).toEqual(["ou_default"]);
  });

  it("surfaces M-3 fields (workspaces/commands/toolPolicy) with undefined = not configured", () => {
    const eff = effectiveChatConfig(
      CHAT,
      { [CHAT]: { commands: ["/status"], toolPolicy: { mode: "denylist", tools: ["Write"] } } },
      {},
    );
    expect(eff.commands).toEqual(["/status"]);
    expect(eff.toolPolicy).toEqual({ mode: "denylist", tools: ["Write"] });
    expect(eff.workspaces).toBeUndefined();
  });
});
