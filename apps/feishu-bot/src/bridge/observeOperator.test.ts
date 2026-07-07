import { describe, expect, it } from "vite-plus/test";

import { resolveObserveOperator } from "./observeOperator.ts";

const INITIATOR = "ou_initiator";
const HANDLE_OP = "ou_handle_operator";

describe("resolveObserveOperator — precedence", () => {
  it("returns the trusted map initiator when present (even over a handle operator)", () => {
    // The per-thread feishuInitiators value wins: it is the turn's trusted Feishu
    // initiator, written only by driveTurn / /resume / M18.
    expect(resolveObserveOperator(INITIATOR, HANDLE_OP)).toBe(INITIATOR);
  });

  it("returns the map initiator when no handle operator is present", () => {
    expect(resolveObserveOperator(INITIATOR, undefined)).toBe(INITIATOR);
  });

  it("falls back to the handle operator when the map has no entry (M18 restart)", () => {
    // Right after a restart the in-process map is empty, but a durable handle still
    // carries the recovered operator so the button stays signed.
    expect(resolveObserveOperator(undefined, HANDLE_OP)).toBe(HANDLE_OP);
  });

  it("falls back to the handle operator when the map value is an empty string", () => {
    // An empty open_id carries no authority; treat it as absent and fall through.
    expect(resolveObserveOperator("", HANDLE_OP)).toBe(HANDLE_OP);
  });

  it("returns undefined when neither source has a non-empty operator", () => {
    // No Feishu initiator: a web/terminal-started turn the bot merely mirrors. The
    // caller then signs payload.o empty → the initiator-mode gate rejects non-owner
    // clicks. There is NO driftable-ref fallback behind this undefined.
    expect(resolveObserveOperator(undefined, undefined)).toBeUndefined();
    expect(resolveObserveOperator("", "")).toBeUndefined();
    expect(resolveObserveOperator("", undefined)).toBeUndefined();
    expect(resolveObserveOperator(undefined, "")).toBeUndefined();
  });
});

describe("resolveObserveOperator — pin-drift security invariant", () => {
  it("only ever returns a trusted source, never a bystander-supplied value", () => {
    // The two inputs are the trusted map value and the durable handle — neither is a
    // driftable per-chat "last sender" ref. A bystander who drifts an unrelated ref
    // cannot appear here, so payload.o can only ever be the real initiator or empty.
    expect(resolveObserveOperator(INITIATOR, undefined)).toBe(INITIATOR);
    // A turn with no Feishu initiator resolves to undefined (→ signed empty →
    // initiator-mode rejects non-owner clicks), never to some ambient sender.
    expect(resolveObserveOperator(undefined, undefined)).toBeUndefined();
  });
});
