import type {
  PendingApproval,
  PendingUserInput,
} from "@t3tools/client-runtime/state/thread-activity";
import { ApprovalRequestId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { CardElement } from "../lark/card.ts";
import { authorizeApprovalClick } from "./authz.ts";
import { CallbackAuth, computePolicyFingerprint } from "./callbackAuth.ts";
import {
  type InteractionContext,
  parseCardActionValue,
  renderInteractionSection,
  type ResolvedNoticeEntry,
} from "./interactionCard.ts";
import { resolveObserveOperator } from "./observeOperator.ts";

/**
 * Covers the "echo re-sign" step of cardAction.ts §12 (the observe pin-drift
 * class fix, feishu-bridge-observe-pin-drift-initiator-bypass): when a click on
 * one pending request echoes onto a card, every still-pending SIBLING request on
 * that same card is re-rendered with a LIVE button, re-signed via
 * `renderInteractionSection`/`actionValue` under `ctx.operatorOpenId`. cardAction.ts
 * sets that to the TRUSTED session operator (`resolveObserveOperator` over
 * `feishuInitiators` → durable handle), never the clicker — otherwise a bystander
 * authorised only by `all`/`designated` mode could plant themselves into a
 * sibling's `payload.o` and later self-authorize it once the chat tightens to
 * `initiator` mode. `resolveObserveOperator` itself is covered in
 * observeOperator.test.ts; this file covers the composition cardAction.ts
 * actually performs — ctx.operatorOpenId flowing through renderInteractionSection
 * into every re-rendered sibling's signed token — which nothing exercised before.
 */

const CHAT_ID = "oc_chat";
const THREAD_ID = "thread-1";
const RUNTIME_MODE = "full-access";
const TTL_MS = 5 * 60_000;

const REQ_CLICKED = ApprovalRequestId.make("req-clicked");
const REQ_SIBLING = ApprovalRequestId.make("req-sibling");

/** The bystander who clicked req-clicked, authorised only because the chat is `all` mode. */
const CLICKER_B = "ou_clicker_b";
/** The real turn initiator — what `feishuInitiators`/the durable handle carries. */
const TRUSTED_OPERATOR = "ou_session_operator";

const auth = new CallbackAuth({
  keys: [{ version: 1, secret: "test-secret" }],
  nonces: { state: () => undefined },
});

const approval = (requestId: ApprovalRequestId, detail: string): PendingApproval => ({
  requestId,
  requestKind: "command",
  createdAt: "2026-07-10T00:00:00.000Z",
  detail,
});

const userInput = (requestId: ApprovalRequestId): PendingUserInput => ({
  requestId,
  createdAt: "2026-07-10T00:00:00.000Z",
  questions: [
    {
      id: "q1",
      header: "确认",
      question: "继续吗?",
      options: [],
      multiSelect: false,
    },
  ],
});

interface RawCardActionValue {
  readonly rid: string;
  readonly t: string;
  readonly k?: string;
  readonly lt?: string;
}

/**
 * Recursively collect every callback button's `value` out of a rendered card
 * section, regardless of nesting (a `buttonRow`'s `column_set` → `column` →
 * `button`, or a `form`'s flat `elements`). Mirrors what the real Feishu SDK
 * echoes back on a click — the raw `behaviors[0].value` object.
 */
const collectButtonValues = (elements: ReadonlyArray<CardElement>): RawCardActionValue[] => {
  const out: RawCardActionValue[] = [];
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    if (Array.isArray(record.behaviors)) {
      for (const behavior of record.behaviors as ReadonlyArray<Record<string, unknown>>) {
        if (behavior.type === "callback" && behavior.value) {
          out.push(behavior.value as RawCardActionValue);
        }
      }
    }
    for (const value of Object.values(record)) {
      if (Array.isArray(value)) {
        for (const item of value) walk(item);
      } else if (value && typeof value === "object") {
        walk(value);
      }
    }
  };
  for (const element of elements) walk(element);
  return out;
};

/** Verify a raw button value against the fixed test context, asserting it decodes ok. */
const verifyButtonValue = (raw: RawCardActionValue) => {
  const parsed = parseCardActionValue(raw);
  if (parsed === null) {
    throw new Error("expected a parseable card action value");
  }
  const res = auth.verify(parsed.token, {
    runId: THREAD_ID,
    scope: CHAT_ID,
    chatId: CHAT_ID,
    policyFingerprint: computePolicyFingerprint(CHAT_ID, THREAD_ID, RUNTIME_MODE),
  });
  if (!res.ok) {
    throw new Error(`expected the token to verify, got reason=${res.reason}`);
  }
  return res.payload;
};

describe("renderInteractionSection — echo re-sign (observe pin-drift class, cardAction.ts §12)", () => {
  it("signs a still-pending SIBLING's re-rendered buttons with the trusted session operator, never the clicker", () => {
    // Mirrors cardAction.ts's `trustedEchoOperator` computation: resolved from the
    // trusted `feishuInitiators` map (never a driftable ref), with no durable-handle
    // fallback needed here.
    const trustedEchoOperator = resolveObserveOperator(TRUSTED_OPERATOR, undefined) ?? "";
    expect(trustedEchoOperator).toBe(TRUSTED_OPERATOR);

    const ctx: InteractionContext = {
      chatId: CHAT_ID,
      threadId: THREAD_ID,
      operatorOpenId: trustedEchoOperator,
      runtimeMode: RUNTIME_MODE,
      auth,
      ttlMs: TTL_MS,
    };

    // The echo: req-clicked (what CLICKER_B just clicked) is resolved/greyed out;
    // req-sibling is STILL PENDING and gets re-rendered with LIVE buttons on the
    // SAME `updateCard` call.
    const resolvedEntry: ResolvedNoticeEntry = {
      operatorName: "Clicker B",
      commandSummary: "rm -rf /tmp/x",
      decision: "accept",
    };
    const resolvedNotice = new Map<string, ResolvedNoticeEntry>([[REQ_CLICKED, resolvedEntry]]);
    const elements = renderInteractionSection(
      [approval(REQ_CLICKED, "rm -rf /tmp/x"), approval(REQ_SIBLING, "cat secrets.env")],
      [],
      new Set<string>(),
      resolvedNotice,
      ctx,
    );

    const buttonValues = collectButtonValues(elements);
    // req-clicked is resolved → no live buttons for it.
    expect(buttonValues.some((v) => v.rid === REQ_CLICKED)).toBe(false);
    // req-sibling is still pending → 3 live buttons (拒绝 / 始终允许 / 允许).
    const siblingValues = buttonValues.filter((v) => v.rid === REQ_SIBLING);
    expect(siblingValues.length).toBe(3);

    for (const raw of siblingValues) {
      const payload = verifyButtonValue(raw);
      // THE INVARIANT: payload.o is the trusted session operator, NEVER the
      // bystander clicker who triggered this echo re-render.
      expect(payload.o).toBe(TRUSTED_OPERATOR);
      expect(payload.o).not.toBe(CLICKER_B);
    }
  });

  it("applies the same trusted-operator signing to a still-pending user-input sibling", () => {
    // renderInteractionSection threads the SAME ctx into renderUserInputBlock's
    // form submit button — cover that branch too, not just approvals.
    const ctx: InteractionContext = {
      chatId: CHAT_ID,
      threadId: THREAD_ID,
      operatorOpenId: resolveObserveOperator(TRUSTED_OPERATOR, undefined) ?? "",
      runtimeMode: RUNTIME_MODE,
      auth,
      ttlMs: TTL_MS,
    };
    const elements = renderInteractionSection(
      [],
      [userInput(REQ_SIBLING)],
      new Set<string>(),
      new Map<string, ResolvedNoticeEntry>(),
      ctx,
    );
    const [raw] = collectButtonValues(elements);
    if (raw === undefined) {
      throw new Error("expected the pending user-input's submit button to render");
    }
    const payload = verifyButtonValue(raw);
    expect(payload.o).toBe(TRUSTED_OPERATOR);
  });

  it("security property: after the chat tightens all→initiator, the echo's clicker cannot self-authorize the re-signed sibling", () => {
    const ctx: InteractionContext = {
      chatId: CHAT_ID,
      threadId: THREAD_ID,
      operatorOpenId: resolveObserveOperator(TRUSTED_OPERATOR, undefined) ?? "",
      runtimeMode: RUNTIME_MODE,
      auth,
      ttlMs: TTL_MS,
    };
    const elements = renderInteractionSection(
      [approval(REQ_SIBLING, "cat secrets.env")],
      [],
      new Set<string>(),
      new Map<string, ResolvedNoticeEntry>(),
      ctx,
    );
    const [raw] = collectButtonValues(elements);
    if (raw === undefined) {
      throw new Error("expected the pending approval's buttons to render");
    }
    const payload = verifyButtonValue(raw);

    // Bystander B (authorised under `all` mode when they clicked req-clicked)
    // clicks this re-rendered live sibling AFTER the chat has been tightened to
    // `initiator`. Because the token was signed with the trusted operator, not B,
    // B is correctly rejected — the nonce is never reached/consumed (cardAction.ts
    // step 6b runs the authz gate strictly before the nonce consume in step 8).
    expect(
      authorizeApprovalClick({
        owner: null,
        mode: "initiator",
        approvers: [],
        clicker: CLICKER_B,
        initiator: payload.o,
      }),
    ).toBe(false);

    // Control: the true session operator remains authorized — proves the
    // rejection above is about identity, not a blanket signature failure.
    expect(
      authorizeApprovalClick({
        owner: null,
        mode: "initiator",
        approvers: [],
        clicker: TRUSTED_OPERATOR,
        initiator: payload.o,
      }),
    ).toBe(true);
  });

  it("regression guard: had the echo signed siblings with the CLICKER instead, the same tightened click would WRONGLY self-authorize", () => {
    // Documents *why* the invariant matters: ctx.operatorOpenId flows straight into
    // every rendered button's payload.o (interactionCard.ts `actionValue`). If
    // cardAction.ts's echo path ever regressed to `ctx.operatorOpenId = clicker`
    // (the exact pin-drift bug class the tests above guard against), this same
    // authorizeApprovalClick check would flip to `true` — a real privilege escalation.
    const buggyCtx: InteractionContext = {
      chatId: CHAT_ID,
      threadId: THREAD_ID,
      operatorOpenId: CLICKER_B, // the BUGGY value — never what cardAction.ts actually sets
      runtimeMode: RUNTIME_MODE,
      auth,
      ttlMs: TTL_MS,
    };
    const elements = renderInteractionSection(
      [approval(REQ_SIBLING, "cat secrets.env")],
      [],
      new Set<string>(),
      new Map<string, ResolvedNoticeEntry>(),
      buggyCtx,
    );
    const [raw] = collectButtonValues(elements);
    if (raw === undefined) {
      throw new Error("expected the pending approval's buttons to render");
    }
    const payload = verifyButtonValue(raw);
    expect(
      authorizeApprovalClick({
        owner: null,
        mode: "initiator",
        approvers: [],
        clicker: CLICKER_B,
        initiator: payload.o,
      }),
    ).toBe(true); // ← the bypass this file's other tests prove cardAction.ts avoids
  });
});
