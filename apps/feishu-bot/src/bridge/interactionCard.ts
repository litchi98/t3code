/**
 * Interaction section renderer + cardAction value parser (M2b-1, contract A4).
 *
 * Strictly pure: no IO, no clock, no randomness of its own. Two concerns:
 *
 *  - {@link renderInteractionSection} turns the derived pending approvals /
 *    user-inputs (plus stale + resolved overlays) into CardKit 2.0 elements.
 *    Every callback button carries a freshly-signed HMAC token minted via the
 *    injected {@link CallbackAuth} (`ctx.auth.sign`). The token binds the button
 *    to `(chatId, threadId, runtimeMode, operatorOpenId, action)` so a stale or
 *    cross-context click fails verification on the way back.
 *  - {@link parseCardActionValue} / {@link formValueToAnswers} /
 *    {@link actionToApprovalDecision} parse a `CardActionEvent` back into the
 *    pieces the cardAction handler routes to the shared respond RPCs.
 *
 * Answer shape is mirrored verbatim from `apps/web` (the single source of truth,
 * `apps/web/src/pendingUserInput.ts#resolvePendingUserInputAnswer`):
 *   - answers are keyed by `question.id`;
 *   - a free-form custom answer WINS over any selected option (trimmed string);
 *   - otherwise a single-select answer is the chosen `option.label` (a string);
 *   - and a multi-select answer is a `string[]` of chosen `option.label`s.
 *
 * Every user-input prompt renders as ONE unified CardKit 2.0 `form` (M2b-1, no
 * single-question button-group special case anymore). Per question the form
 * carries an option control (`select_static` for single-select,
 * `multi_select_static` for multi-select, keyed by `name = question.id`) PLUS a
 * free-text `input` (`name = ui_free_<question.id>`, labelled "或自由输入") so the
 * operator can answer outside the options. A single submit button drives a
 * native form submit, whose `formValue` carries every element's value back: a
 * `select_static` echoes the chosen option's `value` (a string), and a
 * `multi_select_static` echoes the chosen options' `value`s (a `string[]`).
 * Because every option here is built with `value = option.label`, both shapes
 * decode straight into the answer label(s) (see {@link formValueToAnswers}).
 * `checkbox` is deliberately NOT used: it is unsupported by CardKit 2.0 (the
 * "[parse card json err] not support tag: checkbox" 400 that crashed the bot).
 * Option `description`s are listed in the question body markdown
 * (`label — description`) because CardKit's `select_static`/`multi_select_static`
 * option shape (`{ text, value }`) has no per-option description display slot.
 *
 * {@link formValueToAnswers} then mirrors web's priority: the per-question free
 * input wins when non-empty (trimmed); otherwise the selected option label(s).
 */
import type {
  PendingApproval,
  PendingUserInput,
} from "@t3tools/client-runtime/state/thread-activity";
import type {
  ProviderApprovalDecision,
  ProviderUserInputAnswers,
  UserInputQuestion,
} from "@t3tools/contracts";

import type { CardElement } from "../lark/card.ts";
import { type CallbackAuth, computePolicyFingerprint } from "./callbackAuth.ts";

// ── Action constants ────────────────────────────────────────────────────────

const ACTION_APPROVAL_ACCEPT = "approval:accept";
const ACTION_APPROVAL_ACCEPT_FOR_SESSION = "approval:acceptForSession";
const ACTION_APPROVAL_DECLINE = "approval:decline";
const ACTION_USER_INPUT_SUBMIT = "user-input:submit";

/**
 * Element-name prefix for a question's free-text ("或自由输入") box. The submitted
 * `formValue` therefore carries `[question.id]` (the option pick) and
 * `[ui_free_<question.id>]` (the free text) as separate keys; the free one wins
 * when non-empty (see {@link formValueToAnswers}).
 */
const FREE_INPUT_PREFIX = "ui_free_";

// ── Public types ────────────────────────────────────────────────────────────

/**
 * Context threaded into {@link renderInteractionSection} so every button can be
 * signed for its exact `(chat, thread, runtimeMode, operator)` scope.
 */
export interface InteractionContext {
  readonly chatId: string;
  readonly threadId: string;
  readonly operatorOpenId: string;
  readonly runtimeMode: string;
  readonly auth: CallbackAuth;
  readonly ttlMs: number;
  /**
   * Optional Feishu topic id (`omt_…`) for M3a group/topic chats. Threaded into
   * every button's signed token (`payload.lt`) AND echoed in the plain button
   * value (`lt`) so the cardAction handler can recover the topic to locate its
   * binding — `CardActionEvent` carries no thread field. `undefined` for p2p /
   * non-topic chats (token + value then identical to the pre-M3a shape).
   */
  readonly larkThreadId?: string;
}

/**
 * One resolved-notice overlay entry (M2b-2). Replaces the bare string that M2b-1
 * stored in the `resolvedNotice` map. The renderer uses these fields to emit:
 *   - approval accepted  → `✅ 已由 @<operatorName> 授权 · <commandSummary>`
 *   - approval declined  → `🚫 已由 @<operatorName> 拒绝 · <commandSummary>`
 *   - user-input submit  → `✅ 已由 @<operatorName> 提交`  (decision = "submit")
 *
 * `commandSummary` comes from the approval's `detail` text (trimmed, then
 * truncated to {@link RESOLVED_SUMMARY_MAX_CHARS} characters). It is `null` for
 * user-input resolves (which have no single-line detail to surface).
 *
 * `operatorName` is the Feishu display name resolved by `resolveOperatorName`
 * in bot.ts; it falls back to the raw `openId` when the lookup fails.
 */
export interface ResolvedNoticeEntry {
  readonly operatorName: string;
  readonly commandSummary: string | null;
  readonly decision: "accept" | "acceptForSession" | "decline" | "submit";
}

/**
 * The typed view of a callback button's `value` object. `t` is the signed token,
 * `rid` indexes back to the originating pending request. `q` is a legacy slot
 * (formerly the answered question id for single-question button groups, removed
 * in M2b-1's unified-form rendering); kept optional for value-shape stability.
 */
export interface CardActionValue {
  readonly t: string;
  readonly rid: string;
  readonly q?: string;
  /**
   * Optional Feishu topic id (`omt_…`, M3a). A pre-verify bootstrap hint echoed
   * back on click so the handler can locate the topic binding *before* it can
   * recompute the policy fingerprint to verify the token. Untrusted on its own
   * but tamper-evident: the signed fingerprint derives from the topic's thread
   * id, so a forged `lt` fails verification with `context-mismatch`. The
   * authoritative copy is the signed `payload.lt` returned by `verify`. Omitted
   * for p2p / non-topic buttons (value identical to the pre-M3a shape).
   */
  readonly lt?: string;
}

/** Parsed pieces of a `CardActionEvent` the handler needs to route a response. */
export interface ParsedCardAction {
  readonly token: string;
  readonly requestId: string;
  readonly formValue?: Record<string, unknown>;
  /**
   * The Feishu topic id (`omt_…`) the button was rendered for (M3a), echoed in
   * the value's `lt`. A pre-verify bootstrap the handler uses to locate the topic
   * binding; cross-validated by the signed fingerprint at `verify` (whose
   * `payload.lt` is the authoritative copy). Absent for p2p / non-topic.
   */
  readonly larkThreadId?: string;
}

// ── Rendering ────────────────────────────────────────────────────────────────

const PLACEHOLDER_DETAIL = "(无详情)";

/**
 * Maximum visible characters for a command summary in a resolved-notice line.
 * Keeps the greyed-out echo well inside CardKit's soft per-element byte limit.
 * Strings beyond this length are truncated with a trailing `…`.
 */
const RESOLVED_SUMMARY_MAX_CHARS = 60;

/** Truncate `text` to {@link RESOLVED_SUMMARY_MAX_CHARS} chars, appending `…`. */
const truncateSummary = (text: string): string =>
  text.length <= RESOLVED_SUMMARY_MAX_CHARS
    ? text
    : `${text.slice(0, RESOLVED_SUMMARY_MAX_CHARS)}…`;

/**
 * Render the "interaction" section: pending approvals first, then pending
 * user-inputs, each with an overlay for stale (request expired) or resolved
 * (already answered) state. Returns a flat element array the caller splices into
 * the card body (it does **not** include a leading divider unless there is at
 * least one block to render).
 *
 * `resolvedNotice` is now keyed by requestId → {@link ResolvedNoticeEntry},
 * replacing the bare-string shape from M2b-1. Each entry carries the operator
 * display name, the approval command summary, and the decision, so the renderer
 * can emit `✅ 已由 @X 授权 · <命令摘要>` or `🚫 已由 @X 拒绝 · <命令摘要>`.
 */
export const renderInteractionSection = (
  pendingApprovals: ReadonlyArray<PendingApproval>,
  pendingUserInputs: ReadonlyArray<PendingUserInput>,
  staleRequestIds: ReadonlySet<string>,
  resolvedNotice: ReadonlyMap<string, ResolvedNoticeEntry>,
  ctx: InteractionContext,
): ReadonlyArray<CardElement> => {
  const elements: CardElement[] = [];

  const totalApprovals = pendingApprovals.length;
  for (let i = 0; i < pendingApprovals.length; i++) {
    const approval = pendingApprovals[i];
    if (!approval) continue;
    pushBlock(
      elements,
      renderApprovalBlock(approval, staleRequestIds, resolvedNotice, ctx, i + 1, totalApprovals),
    );
  }

  for (const userInput of pendingUserInputs) {
    pushBlock(elements, renderUserInputBlock(userInput, staleRequestIds, resolvedNotice, ctx));
  }

  return elements;
};

const pushBlock = (target: CardElement[], block: ReadonlyArray<CardElement>): void => {
  if (block.length === 0) return;
  if (target.length > 0) {
    target.push(divider());
  }
  for (const element of block) {
    target.push(element);
  }
};

/**
 * Map a {@link PendingApproval.requestKind} to a human-readable Chinese title
 * (aligning with web's "Command/File-read/File-change approval requested").
 */
const approvalKindTitle = (requestKind: PendingApproval["requestKind"]): string => {
  switch (requestKind) {
    case "command":
      return "命令审批";
    case "file-read":
      return "文件读取审批";
    case "file-change":
      return "文件修改审批";
  }
};

const renderApprovalBlock = (
  approval: PendingApproval,
  staleRequestIds: ReadonlySet<string>,
  resolvedNotice: ReadonlyMap<string, ResolvedNoticeEntry>,
  ctx: InteractionContext,
  /** 1-based index of this approval among all pending approvals (for progress display). */
  index: number,
  /** Total number of pending approvals (for progress display). */
  total: number,
): ReadonlyArray<CardElement> => {
  const requestId = approval.requestId;
  const detail = approval.detail?.trim() || PLACEHOLDER_DETAIL;
  const kindTitle = approvalKindTitle(approval.requestKind);
  const progressSuffix = total > 1 ? ` (${index}/${total})` : "";

  const entry = resolvedNotice.get(requestId);
  if (entry) {
    return [resolvedMarkdown(formatResolvedEntry(entry))];
  }
  if (staleRequestIds.has(requestId)) {
    return [staleMarkdown(`⚠️ ${kindTitle}${progressSuffix}:${detail}`)];
  }

  // Active approval: three buttons on a single row (拒绝 / 始终允许 / 允许),
  // mirroring web order Decline / Always allow this session / Approve once. The
  // row is one `flex_mode: "flow"` column_set with auto-width columns, so the
  // three short labels sit on one line (and degrade gracefully if ever too wide).
  // "始终允许" is the short button label for acceptForSession; the resolved echo
  // still spells out "设为本会话始终允许".
  return [
    markdown(`⚠️ **${kindTitle}${progressSuffix}**:${detail}`),
    buttonRow([
      callbackButton({
        text: "拒绝",
        type: "danger",
        value: actionValue(ctx, requestId, ACTION_APPROVAL_DECLINE),
      }),
      callbackButton({
        text: "始终允许",
        value: actionValue(ctx, requestId, ACTION_APPROVAL_ACCEPT_FOR_SESSION),
      }),
      callbackButton({
        text: "允许",
        type: "primary",
        value: actionValue(ctx, requestId, ACTION_APPROVAL_ACCEPT),
      }),
    ]),
  ];
};

const renderUserInputBlock = (
  userInput: PendingUserInput,
  staleRequestIds: ReadonlySet<string>,
  resolvedNotice: ReadonlyMap<string, ResolvedNoticeEntry>,
  ctx: InteractionContext,
): ReadonlyArray<CardElement> => {
  const requestId = userInput.requestId;
  const questions = userInput.questions;
  const heading = questions[0]?.header?.trim() || "需要你的输入";

  const entry = resolvedNotice.get(requestId);
  if (entry) {
    return [resolvedMarkdown(formatResolvedEntry(entry))];
  }
  if (staleRequestIds.has(requestId)) {
    return [staleMarkdown(`💬 ${heading}`)];
  }
  if (questions.length === 0) {
    return [];
  }

  // M2b-1: every prompt is one unified form (no button-group special case).
  return renderUserInputForm(userInput, ctx);
};

/** Free-text input element name for `question.id` (the "或自由输入" box). */
const freeInputName = (questionId: string): string => `${FREE_INPUT_PREFIX}${questionId}`;

const renderUserInputForm = (
  userInput: PendingUserInput,
  ctx: InteractionContext,
): ReadonlyArray<CardElement> => {
  const formName = `ui_form_${userInput.requestId}`;
  const formElements: CardElement[] = [];

  for (const question of userInput.questions) {
    // Question body: the prompt plus, when options carry descriptions, a
    // `label — description` list (CardKit option controls have no per-option
    // description slot, so they ride in the markdown body — see P5).
    formElements.push(markdown(questionBody(question)));
    // Option control (single-select `select_static` / multi-select
    // `multi_select_static`), only when there ARE options; keyed by `question.id`.
    const optionControl = questionOptionElement(question);
    if (optionControl !== null) {
      formElements.push(optionControl);
    }
    // A free-text box for an answer outside the options (or the sole control for
    // an option-less prompt). Keyed by `ui_free_<question.id>`; not required so a
    // pure option pick can submit without typing.
    formElements.push(freeInputElement(question));
  }

  formElements.push(
    callbackButton({
      text: "提交",
      type: "primary",
      formActionType: "submit",
      name: "submit_btn",
      value: actionValue(ctx, userInput.requestId, ACTION_USER_INPUT_SUBMIT),
    }),
  );

  return [
    {
      tag: "form",
      name: formName,
      elements: formElements,
    },
  ];
};

/**
 * Build a question's body markdown: the prompt, plus a `label — description`
 * bullet list when any option carries a distinct description (P5 — CardKit's
 * `select_static`/`multi_select_static` option shape `{ text, value }` cannot
 * show a per-option description, so it is surfaced here in the body instead).
 */
const questionBody = (question: UserInputQuestion): string => {
  const head = `💬 **${question.question}**`;
  const descriptive = question.options.filter(
    (option) => option.description && option.description !== option.label,
  );
  if (descriptive.length === 0) {
    return head;
  }
  const lines = descriptive.map((option) => `- ${option.label} — ${option.description}`);
  return [head, ...lines].join("\n");
};

/**
 * Pick the option control element for one question (keyed by `question.id`), or
 * `null` when the question has no options (a free-form prompt, answered solely
 * by its free-text box):
 *  - multi-select → `multi_select_static` (a CardKit 2.0 multi-select dropdown;
 *    `checkbox` is NOT a valid 2.0 tag and triggers Feishu's
 *    "not support tag: checkbox" 400);
 *  - single-select → `select_static`.
 *
 * Each option carries `value = option.label`, so the submitted `formValue` —
 * a single `value` string for `select_static`, a `string[]` of `value`s for
 * `multi_select_static` — already holds the answer label(s).
 */
const questionOptionElement = (question: UserInputQuestion): CardElement | null => {
  if (question.options.length === 0) {
    return null;
  }

  const options = question.options.map((option) => ({
    text: plainText(option.label),
    value: option.label,
  }));

  if (question.multiSelect) {
    return {
      tag: "multi_select_static",
      name: question.id,
      placeholder: plainText("请选择(可多选)…"),
      options,
    };
  }

  return {
    tag: "select_static",
    name: question.id,
    placeholder: plainText("请选择…"),
    options,
  };
};

/**
 * The free-text `input` box for a question (`name = ui_free_<question.id>`). For
 * an option-less prompt it is the only control and labelled as the answer; for an
 * option prompt it is the "或自由输入" escape hatch. Never `required` — a pure
 * option pick must be submittable without typing.
 */
const freeInputElement = (question: UserInputQuestion): CardElement => {
  const hasOptions = question.options.length > 0;
  return {
    tag: "input",
    name: freeInputName(question.id),
    label: plainText(hasOptions ? "或自由输入" : question.header || "回答"),
    placeholder: plainText("请输入…"),
  };
};

// ── Element constructors (CardKit 2.0 DSL) ───────────────────────────────────

const markdown = (content: string): CardElement => ({ tag: "markdown", content });

const divider = (): CardElement => ({ tag: "hr" });

const plainText = (content: string): { readonly tag: "plain_text"; readonly content: string } => ({
  tag: "plain_text",
  content,
});

/** Greyed-out "request expired" notice replacing the live controls. */
const staleMarkdown = (title: string): CardElement => ({
  tag: "markdown",
  content: `${title}\n<font color='grey'>请求已失效</font>`,
});

/**
 * Format a {@link ResolvedNoticeEntry} into a single markdown line:
 *   - accepted approval           → `✅ 已由 @<operatorName> 授权 · <commandSummary>`
 *   - acceptForSession approval   → `✅ 已由 @<operatorName> 设为本会话始终允许 · <commandSummary>`
 *   - declined approval           → `🚫 已由 @<operatorName> 拒绝 · <commandSummary>`
 *   - user-input submit           → `✅ 已由 @<operatorName> 提交`
 *
 * `commandSummary` is truncated to {@link RESOLVED_SUMMARY_MAX_CHARS} chars.
 * When absent (user-input), the `· <summary>` suffix is omitted.
 */
const formatResolvedEntry = (entry: ResolvedNoticeEntry): string => {
  const { operatorName, commandSummary, decision } = entry;
  const icon = decision === "decline" ? "🚫" : "✅";
  const verb =
    decision === "accept"
      ? "授权"
      : decision === "acceptForSession"
        ? "设为本会话始终允许"
        : decision === "decline"
          ? "拒绝"
          : "提交";
  const base = `${icon} 已由 @${operatorName} ${verb}`;
  if (commandSummary === null || commandSummary.trim().length === 0) {
    return base;
  }
  return `${base} · ${truncateSummary(commandSummary.trim())}`;
};

/** Greyed-out "already resolved" notice rendered from a {@link ResolvedNoticeEntry}. */
const resolvedMarkdown = (notice: string): CardElement => ({
  tag: "markdown",
  content: `<font color='grey'>${notice}</font>`,
});

const callbackButton = (options: {
  readonly text: string;
  readonly value: object;
  readonly type?: "primary" | "danger" | "default";
  readonly formActionType?: "submit";
  readonly name?: string;
}): CardElement => ({
  tag: "button",
  text: plainText(options.text),
  ...(options.type ? { type: options.type } : {}),
  ...(options.name ? { name: options.name } : {}),
  ...(options.formActionType ? { form_action_type: options.formActionType } : {}),
  behaviors: [{ type: "callback", value: options.value }],
});

/** Horizontal button row (auto-width columns). */
const buttonRow = (buttons: ReadonlyArray<CardElement>): CardElement => ({
  tag: "column_set",
  flex_mode: "flow",
  horizontal_spacing: "small",
  columns: buttons.map((button) => ({
    tag: "column",
    width: "auto",
    elements: [button],
  })),
});

/** Build a callback button's `value` object with a freshly-signed token. */
const actionValue = (
  ctx: InteractionContext,
  requestId: string,
  action: string,
): CardActionValue => ({
  t: ctx.auth.sign({
    runId: ctx.threadId,
    scope: ctx.chatId,
    chatId: ctx.chatId,
    operatorOpenId: ctx.operatorOpenId,
    action,
    policyFingerprint: computePolicyFingerprint(ctx.chatId, ctx.threadId, ctx.runtimeMode),
    ttlMs: ctx.ttlMs,
    // M3a: bind the topic id into the signed payload (`lt`) so the handler can
    // recover it after verify; conditionally spread (exactOptionalPropertyTypes)
    // so a p2p ctx omits the key entirely — `sign` then keeps the token
    // byte-identical to the pre-M3a shape.
    ...(ctx.larkThreadId !== undefined ? { larkThreadId: ctx.larkThreadId } : {}),
  }),
  rid: requestId,
  // Echo the topic id in the plain value too — a pre-verify bootstrap so the
  // handler can locate the topic binding before it can recompute the fingerprint
  // to verify (cross-checked by that signed fingerprint). Omitted for p2p so the
  // value object is unchanged from the pre-M3a shape.
  ...(ctx.larkThreadId !== undefined ? { lt: ctx.larkThreadId } : {}),
});

// ── Parsing ──────────────────────────────────────────────────────────────────

/**
 * Decode the `value` object Feishu echoes back on a card button click into the
 * token + requestId the handler needs. Returns `null` for anything that isn't a
 * bridge callback value (e.g. a legacy or foreign button). When the value also
 * carries a reconstructed form answer (`fv`, set by the single-select button
 * group), it is surfaced as {@link ParsedCardAction.formValue}.
 */
export const parseCardActionValue = (value: unknown): ParsedCardAction | null => {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const token = record.t;
  const requestId = record.rid;
  if (typeof token !== "string" || token.length === 0) {
    return null;
  }
  if (typeof requestId !== "string" || requestId.length === 0) {
    return null;
  }

  const fv = record.fv;
  const formValue =
    fv && typeof fv === "object" && !Array.isArray(fv)
      ? (fv as Record<string, unknown>)
      : undefined;

  // M3a: surface the topic id echoed in `lt` (a pre-verify bootstrap), only when
  // it is a non-empty string. Absent for p2p / non-topic values.
  const lt = record.lt;
  const larkThreadId = typeof lt === "string" && lt.length > 0 ? lt : undefined;

  return {
    token,
    requestId,
    ...(formValue ? { formValue } : {}),
    ...(larkThreadId !== undefined ? { larkThreadId } : {}),
  };
};

/**
 * Build the `ProviderUserInputAnswers` (keyed by `question.id`) from a submitted
 * form value, mirroring `apps/web` `resolvePendingUserInputAnswer`'s priority:
 *  1. the per-question **free input** (`ui_free_<question.id>`) WINS when its
 *     trimmed value is non-empty → that trimmed string;
 *  2. otherwise the selected option(s): multi-select reads the
 *     `multi_select_static` `string[]` of selected option `value`s → label
 *     `string[]`; single-select reads the `select_static` single `value`
 *     string → label string. (Both are labels because options carry
 *     `value = option.label`.)
 * Questions with no usable answer are omitted (the server treats the absence as
 * unanswered, matching web which refuses to submit a partial set; the bridge
 * sends whatever the operator supplied).
 */
export const formValueToAnswers = (
  formValue: Record<string, unknown> | undefined,
  questions: ReadonlyArray<UserInputQuestion>,
): ProviderUserInputAnswers => {
  const answers: Record<string, unknown> = {};
  if (!formValue) {
    return answers;
  }

  for (const question of questions) {
    // Free input wins (web parity): the operator typed an answer outside the
    // options, so use it verbatim (trimmed) and skip the option pick entirely.
    const free = freeText(formValue[freeInputName(question.id)]);
    if (free !== null) {
      answers[question.id] = free;
      continue;
    }
    const answer = normalizeAnswer(formValue[question.id], question);
    if (answer !== null) {
      answers[question.id] = answer;
    }
  }

  return answers;
};

/** A trimmed non-empty string from a raw form value, else `null`. */
const freeText = (raw: unknown): string | null => {
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const normalizeAnswer = (raw: unknown, question: UserInputQuestion): string | string[] | null => {
  if (question.multiSelect) {
    const labels = toStringArray(raw);
    return labels.length > 0 ? labels : null;
  }

  if (Array.isArray(raw)) {
    const labels = toStringArray(raw);
    return labels[0] ?? null;
  }

  if (typeof raw === "string") {
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  return null;
};

const toStringArray = (raw: unknown): string[] => {
  if (!Array.isArray(raw)) {
    if (typeof raw === "string") {
      const trimmed = raw.trim();
      return trimmed.length > 0 ? [trimmed] : [];
    }
    return [];
  }
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (trimmed.length > 0) {
      out.push(trimmed);
    }
  }
  return Array.from(new Set(out));
};

/** Map a token's `a` action to the provider approval decision (or null). */
export const actionToApprovalDecision = (action: string): ProviderApprovalDecision | null => {
  switch (action) {
    case ACTION_APPROVAL_ACCEPT:
      return "accept";
    case ACTION_APPROVAL_ACCEPT_FOR_SESSION:
      return "acceptForSession";
    case ACTION_APPROVAL_DECLINE:
      return "decline";
    default:
      return null;
  }
};
