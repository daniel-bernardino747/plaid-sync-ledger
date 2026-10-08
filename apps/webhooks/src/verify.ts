import type { PlaidGateway, VerificationKey } from "@psl/plaid";

/**
 * Plaid webhook verification (ADR 0012). Order matters: cheap checks on
 * untrusted data first, the network last, so a flood of forged JWTs with
 * random `kid`s cannot turn into a flood of calls to Plaid.
 *
 *   1. body size, header present        (no crypto, no network)
 *   2. JWT header: alg = ES256, kid     (decode only)
 *   3. JWT payload: iat window          (decode only)
 *   4. key by kid: cache, then Plaid    (network, negative-cached)
 *   5. ES256 signature                  (crypto)
 *   6. sha256(raw body) = claim         (constant time)
 *
 * Steps 2-3 read unverified data and are only filters. Nothing is trusted
 * until step 5 passes; claims are re-read from the verified payload.
 */

export const MAX_BODY_BYTES = 64 * 1024;
const MAX_AGE_SECONDS = 5 * 60; // Plaid: reject webhooks older than 5 minutes
const FUTURE_SKEW_SECONDS = 30;
const NEGATIVE_CACHE_MS = 5 * 60_000;
const MAX_CACHE_ENTRIES = 256;

export type VerifyResult =
  | { ok: true; body: Uint8Array; bodySha256: string }
  | { ok: false; status: 400 | 401 | 413 | 503; reason: string };

// Derived so the same file typechecks under Workers types and Node types.
type VerifyKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

type CacheEntry = { kind: "key"; key: VerifyKey; expiredAt: number | null } | { kind: "missing"; until: number };

/** Per-isolate cache keyed by kid. Plaid's own examples cache one key and ignore kid. */
export class KeyCache {
  readonly #entries = new Map<string, CacheEntry>();
  readonly #now: () => number;
  fetches = 0;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  async resolve(kid: string, plaid: Pick<PlaidGateway, "getWebhookVerificationKey">): Promise<CacheEntry> {
    const hit = this.#entries.get(kid);
    if (hit && (hit.kind === "key" || hit.until > this.#now())) return hit;

    this.fetches++;
    const vk = await plaid.getWebhookVerificationKey(kid); // transient errors propagate -> 503
    const entry: CacheEntry = vk
      ? { kind: "key", key: await importKey(vk), expiredAt: vk.expiredAt }
      : { kind: "missing", until: this.#now() + NEGATIVE_CACHE_MS };
    if (this.#entries.size >= MAX_CACHE_ENTRIES) {
      // Bounded: random kids cannot grow memory. Oldest entry goes first.
      this.#entries.delete(this.#entries.keys().next().value!);
    }
    this.#entries.set(kid, entry);
    return entry;
  }
}

async function importKey(vk: VerificationKey): Promise<VerifyKey> {
  const { kty, crv, x, y } = vk.jwk;
  return crypto.subtle.importKey("jwk", { kty, crv, x, y }, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
}

export async function verifyPlaidWebhook(
  request: Request,
  deps: { plaid: Pick<PlaidGateway, "getWebhookVerificationKey">; cache: KeyCache; nowSeconds?: () => number },
): Promise<VerifyResult> {
  const now = deps.nowSeconds ?? (() => Math.floor(Date.now() / 1000));

  // 1. Size and presence.
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return fail(413, "body_too_large");
  const jwt = request.headers.get("plaid-verification");
  if (!jwt) return fail(400, "missing_header");
  const body = new Uint8Array(await request.arrayBuffer());
  if (body.byteLength > MAX_BODY_BYTES) return fail(413, "body_too_large");

  const parts = jwt.split(".");
  if (parts.length !== 3) return fail(400, "malformed_jwt");
  const [h64, p64, s64] = parts as [string, string, string];

  // 2. Header (unverified).
  const header = decodeJson(h64);
  if (!header || header.alg !== "ES256") return fail(400, "bad_alg");
  const kid = header.kid;
  if (typeof kid !== "string" || kid.length === 0 || kid.length > 128) return fail(400, "bad_kid");

  // 3. Payload (unverified): cheap freshness filter before any network call.
  const unverified = decodeJson(p64);
  if (!unverified || !freshIat(unverified.iat, now())) return fail(400, "stale_or_future_iat");

  // 4. Key.
  let entry: CacheEntry;
  try {
    entry = await deps.cache.resolve(kid, deps.plaid);
  } catch {
    return fail(503, "key_fetch_failed"); // Plaid will retry the webhook
  }
  if (entry.kind === "missing") return fail(401, "unknown_kid");

  // 5. Signature over "<header>.<payload>" (raw r||s, as JWS ES256 specifies).
  const sig = b64urlBytes(s64);
  if (!sig || sig.byteLength !== 64) return fail(401, "bad_signature");
  const valid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    entry.key,
    sig,
    new TextEncoder().encode(`${h64}.${p64}`),
  );
  if (!valid) return fail(401, "bad_signature");

  // Claims, now from the verified payload.
  const claims = decodeJson(p64)!;
  const iat = claims.iat as number;
  if (!freshIat(iat, now())) return fail(400, "stale_or_future_iat");
  // Key used after it expired (our interpretation, see ADR 0012).
  if (entry.expiredAt !== null && iat > entry.expiredAt) return fail(401, "expired_key");

  // 6. Body hash over the exact bytes received.
  const bodySha256 = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", body)));
  if (typeof claims.request_body_sha256 !== "string" || !constantTimeEqual(bodySha256, claims.request_body_sha256)) {
    return fail(401, "body_hash_mismatch");
  }
  return { ok: true, body, bodySha256 };
}

function freshIat(iat: unknown, now: number): boolean {
  return typeof iat === "number" && Number.isFinite(iat) && iat >= now - MAX_AGE_SECONDS && iat <= now + FUTURE_SKEW_SECONDS;
}

function fail(status: 400 | 401 | 413 | 503, reason: string): VerifyResult {
  return { ok: false, status, reason };
}

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function decodeJson(segment: string): Record<string, unknown> | null {
  const bytes = b64urlBytes(segment);
  if (!bytes) return null;
  try {
    const v: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function b64urlBytes(s: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "="));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export function hex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}
