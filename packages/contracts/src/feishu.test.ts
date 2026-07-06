import { describe, expect, it } from "vite-plus/test";

import {
  FEISHU_COMMAND_FLOOR,
  FEISHU_COMMAND_REGISTRY,
  FEISHU_CONFIGURABLE_COMMANDS,
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
