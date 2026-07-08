import { describe, expect, it } from "vite-plus/test";

import { FEISHU_RENDER_DENSITIES } from "@t3tools/contracts";

import { DEFAULT_APPROVAL_MODE, effectiveChatConfig } from "./chatConfig.ts";
import { rendersAtP2pDensity, resolveP2pDensity, resolveRenderDensity } from "./chatThreadMap.ts";
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

describe("resolveP2pDensity — private-chat density (M-3 p2p-density)", () => {
  it("returns the configured p2pDensity when set (放开 p2p 硬门:所见=所判)", () => {
    // The old M3b invariant FORCED every private chat to `card`; p2p density is now
    // configurable via `feishuChatDefaults.p2pDensity`, and the bot renders whatever
    // is set — so the web control and the bot agree.
    expect(resolveP2pDensity("text")).toBe("text");
    expect(resolveP2pDensity("markdown")).toBe("markdown");
    expect(resolveP2pDensity("card")).toBe("card");
  });

  it("defaults to card when unset (preserves the pre-M3 p2p-always-card default)", () => {
    expect(resolveP2pDensity(undefined)).toBe("card");
  });
});

describe("rendersAtP2pDensity — density follows the CHAT not the thread (M-3 p2p-density)", () => {
  it("the stamped chatIsP2p is AUTHORITATIVE over the (web-mutable) thread runtimeMode", () => {
    // A stamped p2p chat is p2p even if its thread was flipped to approval-required
    // (cross-context /resume, or a web composer mode change).
    expect(rendersAtP2pDensity("approval-required", true)).toBe(true);
    expect(rendersAtP2pDensity("full-access", true)).toBe(true);
    // A stamped GROUP chat is NOT p2p even if its thread was flipped to full-access on
    // the web — the stamp VETOes the runtime-mode heuristic (the #A regression fix).
    expect(rendersAtP2pDensity("full-access", false)).toBe(false);
    expect(rendersAtP2pDensity("approval-required", false)).toBe(false);
  });

  it("an unstamped (legacy) binding falls back to the full-access ⟹ p2p heuristic", () => {
    // Correct for the common fresh-p2p case (full-access thread); a stale
    // approval-required-in-p2p legacy binding self-heals on next use (see ensureThread).
    expect(rendersAtP2pDensity("full-access", undefined)).toBe(true);
    expect(rendersAtP2pDensity("approval-required", undefined)).toBe(false);
  });
});

describe("resolveRenderDensity — group/topic precedence (PR-C3)", () => {
  it("group/topic precedence: config > binding > groupChatDensity", () => {
    // p2p is resolved separately (`resolveP2pDensity`); this function only handles
    // group/topic chats now, so there is no full-access branch — a group default can
    // never cross into a private chat because the two paths never meet.
    // per-chat/defaults config wins
    expect(resolveRenderDensity("text", "markdown", "card")).toBe("text");
    // no config → the bind-time binding density
    expect(resolveRenderDensity(undefined, "markdown", "card")).toBe("markdown");
    // no config, no binding → the env group default
    expect(resolveRenderDensity(undefined, undefined, "text")).toBe("text");
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
