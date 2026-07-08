import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  FEISHU_COMMAND_FLOOR,
  FEISHU_COMMAND_REGISTRY,
  FEISHU_CONFIGURABLE_COMMANDS,
  FeishuChatDirectorySnapshot,
} from "./feishu.ts";

describe("Feishu slash-command registry (M-3 PR-C)", () => {
  it("keeps the floor byte-identical to the bot's self-lock floor", () => {
    // Red line: the floor is what `bridge/authz.COMMAND_FLOOR` re-exports, so it
    // must stay exactly `/help` + `/whoami` (a widened floor would silently let a
    // narrowed allowlist run commands it never listed).
    expect(FEISHU_COMMAND_FLOOR).toEqual(["/help", "/whoami"]);
  });

  it("exposes exactly the four configurable (non-floor) commands", () => {
    expect(FEISHU_CONFIGURABLE_COMMANDS).toEqual(["/workspace", "/resume", "/status", "/release"]);
  });

  it("partitions the registry into floor ∪ configurable with no overlap", () => {
    const floor = new Set(FEISHU_COMMAND_FLOOR);
    const configurable = new Set(FEISHU_CONFIGURABLE_COMMANDS);
    // Disjoint.
    for (const token of floor) {
      expect(configurable.has(token)).toBe(false);
    }
    // Exhaustive: floor + configurable == every registry token, no duplicates.
    const tokens = FEISHU_COMMAND_REGISTRY.map((command) => command.token);
    expect(new Set(tokens).size).toBe(tokens.length);
    expect(new Set([...floor, ...configurable])).toEqual(new Set(tokens));
  });

  it("normalises every token to a lowercase, `/`-prefixed form and labels it", () => {
    for (const command of FEISHU_COMMAND_REGISTRY) {
      expect(command.token).toBe(command.token.toLowerCase());
      expect(command.token.startsWith("/")).toBe(true);
      expect(command.label.length).toBeGreaterThan(0);
    }
  });
});

describe("FeishuChatDirectorySnapshot botIdentity (M-3 PR-C4)", () => {
  const decode = Schema.decodeUnknownSync(FeishuChatDirectorySnapshot);

  it("decodes a snapshot carrying a full bot identity", () => {
    const decoded = decode({
      chats: [],
      reportedAt: "2026-07-07T00:00:00Z",
      botIdentity: { appId: "cli_abc", name: "Client Bot", avatarUrl: "https://cdn/a.png" },
    });
    expect(decoded.botIdentity).toEqual({
      appId: "cli_abc",
      name: "Client Bot",
      avatarUrl: "https://cdn/a.png",
    });
  });

  it("decodes an identity without an avatar (avatar is optional)", () => {
    const decoded = decode({ chats: [], botIdentity: { appId: "cli_abc", name: "Client Bot" } });
    expect(decoded.botIdentity).toEqual({ appId: "cli_abc", name: "Client Bot" });
    expect("avatarUrl" in decoded.botIdentity!).toBe(false);
  });

  it("decodes an identity with an empty name (name may be empty)", () => {
    const decoded = decode({ chats: [], botIdentity: { appId: "cli_abc", name: "" } });
    expect(decoded.botIdentity).toEqual({ appId: "cli_abc", name: "" });
  });

  it("back-compat: decodes an older snapshot with no botIdentity at all", () => {
    const decoded = decode({ chats: [], reportedAt: "2026-07-07T00:00:00Z" });
    expect("botIdentity" in decoded).toBe(false);
  });

  it("rejects an identity with an empty appId (the re-bind association key)", () => {
    expect(() => decode({ chats: [], botIdentity: { appId: "", name: "Bot" } })).toThrow();
  });
});
