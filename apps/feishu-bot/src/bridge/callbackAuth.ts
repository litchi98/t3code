/**
 * Callback-button token auth for Feishu interactive cards (M2b-1, contract A2).
 *
 * Ported from the reference bridge `src/card/callback-auth.ts` with three
 * deliberate changes mandated by the orchestrator review:
 *
 *  1. The nonce store is **not** imported here. Instead we inject a synchronous
 *     {@link NonceProbe} whose only member is a read (`state`). `verify` performs
 *     no write — it just rejects a `used`/`revoked` nonce. This keeps
 *     `CallbackAuth` a pure, IO-free class; the single authoritative consume
 *     (in-memory mark + durable persist) is performed by the cardAction handler
 *     *after* `verify` succeeds and *before* routing to the shared respond RPC
 *     (no double-write, no crash-replay window).
 *  2. `matchesExpected` / {@link CallbackVerifyExpected} drop the `a` (action)
 *     field. The action is still carried in the payload (`a`) and is protected
 *     by the whole-payload HMAC signature; the handler routes on `payload.a`.
 *  3. `verify` returns the decoded `payload` on success so the handler can read
 *     `payload.a` / `payload.n` / `payload.exp` without re-decoding.
 *
 * Token format: `bridge_cb.v1.<b64url(JSON payload)>.<b64url(HMAC-SHA256 sig)>`.
 * Signature: `createHmac("sha256", key.secret).update(encodedPayload).digest("base64url")`.
 * Signing key: the highest-version non-retired key. Verification is timing-safe
 * (length-checked first, then `timingSafeEqual`).
 */
import * as NodeCrypto from "node:crypto";

export interface CallbackKey {
  readonly version: number;
  readonly secret: string;
  readonly retired?: boolean;
}

export interface CallbackSignInput {
  readonly runId: string;
  readonly scope: string;
  readonly chatId: string;
  readonly operatorOpenId: string;
  readonly action: string;
  readonly policyFingerprint: string;
  readonly ttlMs: number;
}

/**
 * Context the verifier expects the token to match. Note: **no `action`** — the
 * action is carried by (and routed from) the signed payload (`payload.a`), so it
 * is integrity-protected without being part of the per-button expected context.
 */
export interface CallbackVerifyExpected {
  readonly runId: string;
  readonly scope: string;
  readonly chatId: string;
  readonly operatorOpenId: string;
  readonly policyFingerprint: string;
}

export interface CallbackPayload {
  r: string;
  s: string;
  c: string;
  o: string;
  a: string;
  exp: number;
  fp: string;
  n: string;
  kv: number;
}

export type CallbackVerifyResult =
  | { readonly ok: true; readonly payload: CallbackPayload }
  | {
      readonly ok: false;
      readonly reason:
        | "malformed"
        | "unknown-key"
        | "bad-signature"
        | "expired"
        | "context-mismatch"
        | "nonce-replay"
        | "nonce-revoked";
    };

/**
 * Synchronous, IO-free view of nonce state injected into {@link CallbackAuth}.
 *
 * `state` returns the current snapshot status of a nonce (`undefined` = unseen).
 * This is the **only** read `verify` performs — it has no write side-effect. The
 * single authoritative consume (in-memory mark + durable persist) is the
 * handler's responsibility: it awaits `nonceStore.consume` *after* `verify`
 * succeeds and *before* routing (orchestrator adjustment 1). Were `verify` to
 * also `consume`, it would write into the same map the handler's store backs,
 * so the handler's later `consume` would see the nonce already present and
 * reject every legitimate first click as a replay.
 */
export interface NonceProbe {
  readonly state: (nonce: string) => "used" | "revoked" | undefined;
}

const PREFIX = "bridge_cb.v1";

export const CALLBACK_TOKEN_PREFIX = PREFIX;

export class CallbackAuth {
  private readonly keys: ReadonlyArray<CallbackKey>;
  private readonly nonces: NonceProbe;
  private readonly now: () => number;
  private readonly createNonce: () => string;

  constructor(options: {
    keys: ReadonlyArray<CallbackKey>;
    nonces: NonceProbe;
    now?: () => number;
    createNonce?: () => string;
  }) {
    this.keys = [...options.keys].sort((a, b) => a.version - b.version);
    if (this.keys.length === 0) {
      throw new Error("at least one callback key is required");
    }
    this.nonces = options.nonces;
    this.now = options.now ?? Date.now;
    this.createNonce =
      options.createNonce ?? (() => NodeCrypto.randomBytes(16).toString("base64url"));
  }

  sign(input: CallbackSignInput): string {
    const key = this.signingKey();
    const payload: CallbackPayload = {
      r: input.runId,
      s: input.scope,
      c: input.chatId,
      o: input.operatorOpenId,
      a: input.action,
      exp: this.now() + input.ttlMs,
      fp: input.policyFingerprint,
      n: this.createNonce(),
      kv: key.version,
    };
    const encoded = encodeJson(payload);
    return `${PREFIX}.${encoded}.${sign(encoded, key.secret)}`;
  }

  verify(token: string, expected: CallbackVerifyExpected): CallbackVerifyResult {
    const parts = token.split(".");
    if (parts.length !== 4 || `${parts[0]}.${parts[1]}` !== PREFIX) {
      return { ok: false, reason: "malformed" };
    }
    const encodedPayload = parts[2];
    const signature = parts[3];
    if (!encodedPayload || !signature) return { ok: false, reason: "malformed" };

    const payload = decodePayload(encodedPayload);
    if (!payload) return { ok: false, reason: "malformed" };
    const key = this.keys.find((candidate) => candidate.version === payload.kv);
    if (!key) return { ok: false, reason: "unknown-key" };
    if (!signatureMatches(signature, sign(encodedPayload, key.secret))) {
      return { ok: false, reason: "bad-signature" };
    }
    if (payload.exp <= this.now()) return { ok: false, reason: "expired" };
    if (!matchesExpected(payload, expected)) {
      return { ok: false, reason: "context-mismatch" };
    }

    // Nonce check is a pure read: `verify` never writes. A `"used"`/`"revoked"`
    // state rejects the token; an unseen nonce passes here and is durably
    // consumed by the handler (the single authoritative writer) before routing.
    const nonceState = this.nonces.state(payload.n);
    if (nonceState === "revoked") return { ok: false, reason: "nonce-revoked" };
    if (nonceState === "used") return { ok: false, reason: "nonce-replay" };
    return { ok: true, payload };
  }

  private signingKey(): CallbackKey {
    const active = this.keys.filter((key) => !key.retired);
    const key = active.at(-1);
    if (!key) throw new Error("no active callback signing key");
    return key;
  }
}

/**
 * Deterministic policy fingerprint binding a callback token to a specific
 * `(chatId, threadId, runtimeMode)` context. Both render and verify recompute
 * this; a mismatch (e.g. runtimeMode changed since the card was rendered) fails
 * verification with `context-mismatch`.
 *
 *   = createHash("sha256").update(`${chatId}\0${threadId}\0${runtimeMode}`).digest("base64url")
 */
export const computePolicyFingerprint = (
  chatId: string,
  threadId: string,
  runtimeMode: string,
): string =>
  NodeCrypto.createHash("sha256")
    .update(`${chatId}\0${threadId}\0${runtimeMode}`)
    .digest("base64url");

function matchesExpected(payload: CallbackPayload, expected: CallbackVerifyExpected): boolean {
  return (
    payload.r === expected.runId &&
    payload.s === expected.scope &&
    payload.c === expected.chatId &&
    payload.o === expected.operatorOpenId &&
    payload.fp === expected.policyFingerprint
  );
}

function encodeJson(payload: CallbackPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodePayload(encoded: string): CallbackPayload | undefined {
  try {
    const raw = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8"),
    ) as Partial<CallbackPayload>;
    if (
      typeof raw.r !== "string" ||
      typeof raw.s !== "string" ||
      typeof raw.c !== "string" ||
      typeof raw.o !== "string" ||
      typeof raw.a !== "string" ||
      typeof raw.exp !== "number" ||
      typeof raw.fp !== "string" ||
      typeof raw.n !== "string" ||
      typeof raw.kv !== "number"
    ) {
      return undefined;
    }
    return {
      r: raw.r,
      s: raw.s,
      c: raw.c,
      o: raw.o,
      a: raw.a,
      exp: raw.exp,
      fp: raw.fp,
      n: raw.n,
      kv: raw.kv,
    };
  } catch {
    return undefined;
  }
}

function sign(payload: string, secret: string): string {
  return NodeCrypto.createHmac("sha256", secret).update(payload).digest("base64url");
}

function signatureMatches(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return (
    actualBytes.length === expectedBytes.length &&
    NodeCrypto.timingSafeEqual(actualBytes, expectedBytes)
  );
}
