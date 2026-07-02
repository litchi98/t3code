import { describe, expect, it } from "vite-plus/test";

import { authorizeApprovalClick } from "./authz.ts";

const OWNER = "ou_owner";
const MEMBER = "ou_member";
const INITIATOR = "ou_initiator";
const STRANGER = "ou_stranger";

describe("authorizeApprovalClick — owner-always (PR2a)", () => {
  it("authorizes the owner even when not in the allowlist and not the initiator", () => {
    expect(
      authorizeApprovalClick({
        owner: OWNER,
        effectiveAllowlist: [MEMBER],
        clicker: OWNER,
        initiator: INITIATOR,
      }),
    ).toBe(true);
  });

  it("authorizes the owner when the allowlist is empty (owner-always beats initiator fallback)", () => {
    expect(
      authorizeApprovalClick({
        owner: OWNER,
        effectiveAllowlist: [],
        clicker: OWNER,
        initiator: INITIATOR,
      }),
    ).toBe(true);
  });

  it("does not treat an unbound (null) owner as a match for an empty clicker", () => {
    expect(
      authorizeApprovalClick({
        owner: null,
        effectiveAllowlist: [],
        clicker: "",
        initiator: "",
      }),
    ).toBe(false);
  });
});

describe("authorizeApprovalClick — allowlist branch (active)", () => {
  it("authorizes a clicker present in a non-empty allowlist", () => {
    expect(
      authorizeApprovalClick({
        owner: OWNER,
        effectiveAllowlist: [MEMBER, STRANGER],
        clicker: MEMBER,
        initiator: INITIATOR,
      }),
    ).toBe(true);
  });

  it("denies a clicker absent from a non-empty allowlist (and not the owner)", () => {
    expect(
      authorizeApprovalClick({
        owner: OWNER,
        effectiveAllowlist: [MEMBER],
        clicker: STRANGER,
        initiator: STRANGER,
      }),
    ).toBe(false);
  });
});

describe("authorizeApprovalClick — initiator fallback (empty allowlist)", () => {
  it("authorizes the signed initiator when the allowlist is empty", () => {
    expect(
      authorizeApprovalClick({
        owner: null,
        effectiveAllowlist: [],
        clicker: INITIATOR,
        initiator: INITIATOR,
      }),
    ).toBe(true);
  });

  it("denies a non-initiator when the allowlist is empty", () => {
    expect(
      authorizeApprovalClick({
        owner: null,
        effectiveAllowlist: [],
        clicker: STRANGER,
        initiator: INITIATOR,
      }),
    ).toBe(false);
  });

  it("denies an empty clicker even when the signed initiator is also empty", () => {
    expect(
      authorizeApprovalClick({
        owner: null,
        effectiveAllowlist: [],
        clicker: "",
        initiator: "",
      }),
    ).toBe(false);
  });
});
