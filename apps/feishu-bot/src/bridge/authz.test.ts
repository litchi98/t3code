import { describe, expect, it } from "vite-plus/test";

import { authorizeApprovalClick } from "./authz.ts";

const OWNER = "ou_owner";
const APPROVER = "ou_approver";
const INITIATOR = "ou_initiator";
const STRANGER = "ou_stranger";

describe("authorizeApprovalClick — empty clicker + owner-always overlay", () => {
  it("never authorizes an empty clicker in any mode", () => {
    for (const mode of ["initiator", "designated", "all"] as const) {
      expect(
        authorizeApprovalClick({
          owner: OWNER,
          mode,
          approvers: [OWNER],
          clicker: "",
          initiator: "",
        }),
      ).toBe(false);
    }
  });

  it("authorizes the owner in every mode, even when not initiator/approver", () => {
    for (const mode of ["initiator", "designated", "all"] as const) {
      expect(
        authorizeApprovalClick({
          owner: OWNER,
          mode,
          approvers: [APPROVER],
          clicker: OWNER,
          initiator: INITIATOR,
        }),
      ).toBe(true);
    }
  });

  it("does not treat a null owner as a match", () => {
    expect(
      authorizeApprovalClick({
        owner: null,
        mode: "designated",
        approvers: [APPROVER],
        clicker: STRANGER,
        initiator: INITIATOR,
      }),
    ).toBe(false);
  });
});

describe("authorizeApprovalClick — initiator mode", () => {
  it("authorizes the signed initiator", () => {
    expect(
      authorizeApprovalClick({
        owner: null,
        mode: "initiator",
        approvers: [],
        clicker: INITIATOR,
        initiator: INITIATOR,
      }),
    ).toBe(true);
  });

  it("denies a non-initiator (bystander)", () => {
    expect(
      authorizeApprovalClick({
        owner: OWNER,
        mode: "initiator",
        approvers: [STRANGER],
        clicker: STRANGER,
        initiator: INITIATOR,
      }),
    ).toBe(false);
  });
});

describe("authorizeApprovalClick — designated mode", () => {
  it("authorizes an open_id in the approvers list", () => {
    expect(
      authorizeApprovalClick({
        owner: null,
        mode: "designated",
        approvers: [APPROVER, "ou_other"],
        clicker: APPROVER,
        initiator: INITIATOR,
      }),
    ).toBe(true);
  });

  it("denies an open_id absent from the approvers list (even the initiator)", () => {
    expect(
      authorizeApprovalClick({
        owner: null,
        mode: "designated",
        approvers: [APPROVER],
        clicker: INITIATOR,
        initiator: INITIATOR,
      }),
    ).toBe(false);
  });
});

describe("authorizeApprovalClick — all mode", () => {
  it("authorizes any non-empty clicker (a card clicker is a chat member by construction)", () => {
    expect(
      authorizeApprovalClick({
        owner: null,
        mode: "all",
        approvers: [],
        clicker: STRANGER,
        initiator: INITIATOR,
      }),
    ).toBe(true);
  });
});
