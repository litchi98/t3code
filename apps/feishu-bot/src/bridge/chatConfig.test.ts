import { describe, expect, it } from "vite-plus/test";

import { FEISHU_RENDER_DENSITIES } from "@t3tools/contracts";

import { DEFAULT_APPROVAL_MODE, effectiveChatConfig } from "./chatConfig.ts";
import { resolveRenderDensity } from "./chatThreadMap.ts";
import { RENDER_DENSITIES } from "./eventRenderer.ts";

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

  it("resolves density per-field: per-chat > defaults > undefined (PR-C3)", () => {
    // per-chat density wins over the default
    expect(
      effectiveChatConfig(CHAT, { [CHAT]: { density: "text" } }, { density: "markdown" }).density,
    ).toBe("text");
    // no per-chat density → falls through to the default
    expect(effectiveChatConfig(CHAT, {}, { density: "markdown" }).density).toBe("markdown");
    // neither set → undefined (the render read points apply the runtime fallback)
    expect(effectiveChatConfig(CHAT, {}, {}).density).toBeUndefined();
  });
});

describe("resolveRenderDensity — p2p gate + group precedence (PR-C3)", () => {
  it("forces p2p (full-access) to card REGARDLESS of config or binding density", () => {
    // The invariant that a group default / per-chat density must NEVER lower a
    // private chat below `card` (M3b, mirrored by densityForRuntime).
    expect(resolveRenderDensity("full-access", "text", "markdown", "text")).toBe("card");
    expect(resolveRenderDensity("full-access", undefined, undefined, "text")).toBe("card");
  });

  it("group/topic precedence: config > binding > groupChatDensity", () => {
    // per-chat/defaults config wins
    expect(resolveRenderDensity("approval-required", "text", "markdown", "card")).toBe("text");
    // no config → the bind-time binding density
    expect(resolveRenderDensity("approval-required", undefined, "markdown", "card")).toBe(
      "markdown",
    );
    // no config, no binding → the env group default
    expect(resolveRenderDensity("approval-required", undefined, undefined, "text")).toBe("text");
  });
});

describe("density literal parity — contract ↔ bot RenderDensity", () => {
  it("FEISHU_RENDER_DENSITIES equals the renderer's RENDER_DENSITIES set", () => {
    // The web editor renders `FEISHU_RENDER_DENSITIES` (contracts) while the bot
    // renders per `RenderDensity` (eventRenderer). If one drifts, the editor could
    // write a density the bot can't render (or vice-versa). Assert the two literal
    // SETS are identical (order-independent).
    expect([...FEISHU_RENDER_DENSITIES].sort()).toEqual([...RENDER_DENSITIES].sort());
  });
});
