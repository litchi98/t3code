import { describe, expect, it } from "vite-plus/test";

import {
  authorizeApprovalClick,
  authorizeCommand,
  COMMAND_FLOOR,
  isOwnerExempt,
  isWorkspaceAuthorized,
} from "./authz.ts";

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

// ── M-3: command allowlist + workspace authorization (shared owner overlay) ──

const SENDER = "ou_sender";

describe("isOwnerExempt (M-3 shared owner-always overlay)", () => {
  it("matches a non-empty sender equal to the owner", () => {
    expect(isOwnerExempt(OWNER, OWNER)).toBe(true);
  });

  it("never matches when there is no owner (unbound)", () => {
    expect(isOwnerExempt(null, SENDER)).toBe(false);
  });

  it("never matches an empty sender (an unresolved open_id must not slip through)", () => {
    expect(isOwnerExempt(OWNER, "")).toBe(false);
    expect(isOwnerExempt("", "")).toBe(false);
    expect(isOwnerExempt(null, "")).toBe(false);
  });

  it("does not match a different sender", () => {
    expect(isOwnerExempt(OWNER, STRANGER)).toBe(false);
  });
});

describe("COMMAND_FLOOR", () => {
  it("is exactly /help + /whoami (the user-confirmed self-lock floor)", () => {
    expect([...COMMAND_FLOOR]).toEqual(["/help", "/whoami"]);
  });
});

describe("authorizeCommand (M-3 per-chat command allowlist)", () => {
  it("allows everything when the allowlist is undefined (not configured)", () => {
    expect(
      authorizeCommand({
        owner: null,
        sender: SENDER,
        command: "/workspace",
        allowlist: undefined,
        floor: COMMAND_FLOOR,
      }),
    ).toBe(true);
  });

  it("allows a floor command even against an empty allowlist", () => {
    expect(
      authorizeCommand({
        owner: null,
        sender: SENDER,
        command: "/help",
        allowlist: [],
        floor: COMMAND_FLOOR,
      }),
    ).toBe(true);
    expect(
      authorizeCommand({
        owner: null,
        sender: SENDER,
        command: "/whoami",
        allowlist: [],
        floor: COMMAND_FLOOR,
      }),
    ).toBe(true);
  });

  it("denies a non-floor command outside the allowlist", () => {
    expect(
      authorizeCommand({
        owner: null,
        sender: SENDER,
        command: "/workspace",
        allowlist: ["/status"],
        floor: COMMAND_FLOOR,
      }),
    ).toBe(false);
  });

  it("allows a command inside the allowlist", () => {
    expect(
      authorizeCommand({
        owner: null,
        sender: SENDER,
        command: "/status",
        allowlist: ["/status"],
        floor: COMMAND_FLOOR,
      }),
    ).toBe(true);
  });

  it("owner bypasses the allowlist entirely (owner-always)", () => {
    expect(
      authorizeCommand({
        owner: OWNER,
        sender: OWNER,
        command: "/workspace",
        allowlist: [],
        floor: COMMAND_FLOOR,
      }),
    ).toBe(true);
  });

  it("matches an allowlist entry case-insensitively (hand-authored config robustness)", () => {
    expect(
      authorizeCommand({
        owner: null,
        sender: SENDER,
        command: "/status",
        allowlist: ["/STATUS"],
        floor: COMMAND_FLOOR,
      }),
    ).toBe(true);
  });
});

describe("isWorkspaceAuthorized (M-3 per-chat workspace allowlist)", () => {
  const P_A = "proj-a";
  const P_B = "proj-b";

  it("allows every project when the allowlist is undefined (not configured)", () => {
    expect(
      isWorkspaceAuthorized({ owner: null, sender: SENDER, projectId: P_A, authorized: undefined }),
    ).toBe(true);
  });

  it("denies a project outside the allowlist", () => {
    expect(
      isWorkspaceAuthorized({ owner: null, sender: SENDER, projectId: P_B, authorized: [P_A] }),
    ).toBe(false);
  });

  it("allows a project inside the allowlist", () => {
    expect(
      isWorkspaceAuthorized({ owner: null, sender: SENDER, projectId: P_A, authorized: [P_A] }),
    ).toBe(true);
  });

  it("denies against an empty allowlist for a non-owner", () => {
    expect(
      isWorkspaceAuthorized({ owner: null, sender: SENDER, projectId: P_A, authorized: [] }),
    ).toBe(false);
  });

  it("owner bypasses the allowlist (owner-always)", () => {
    expect(
      isWorkspaceAuthorized({ owner: OWNER, sender: OWNER, projectId: P_B, authorized: [P_A] }),
    ).toBe(true);
  });
});
