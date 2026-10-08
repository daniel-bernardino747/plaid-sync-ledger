import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakePlaid } from "@psl/plaid-fake";
import { PlaidHttpClient } from "@psl/plaid";
import { KeyCache, constantTimeEqual, verifyPlaidWebhook } from "../src/verify.ts";

// Every rejection path of ADR 0012, with JWTs signed by the fake's real ES256 key.

let fake: FakePlaid;
let plaid: PlaidHttpClient;
let cache: KeyCache;
const now = () => Math.floor(Date.now() / 1000);

// Plaid pretty-prints webhook bodies with 2-space indentation; the hash is over those bytes.
const BODY = JSON.stringify(
  { webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE", item_id: "item-1", environment: "sandbox" },
  null,
  2,
);

beforeAll(async () => {
  fake = new FakePlaid();
  plaid = new PlaidHttpClient({ baseUrl: await fake.listen(), clientId: "fake-client-id", secret: "fake-secret" });
});
afterAll(() => fake.close());
beforeEach(() => {
  cache = new KeyCache();
});

function request(body: string, jwt: string | null, extraHeaders: Record<string, string> = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", ...extraHeaders };
  if (jwt) headers["plaid-verification"] = jwt;
  return new Request("http://worker/plaid/webhook", { method: "POST", body, headers });
}

const verify = (req: Request) => verifyPlaidWebhook(req, { plaid, cache });

function reSign(jwt: string, mutate: (header: Record<string, unknown>) => void): string {
  const [h, p, s] = jwt.split(".");
  const header = JSON.parse(Buffer.from(h!, "base64url").toString());
  mutate(header);
  return `${Buffer.from(JSON.stringify(header)).toString("base64url")}.${p}.${s}`;
}

describe("Plaid-Verification", () => {
  it("accepts a correctly signed, fresh webhook and returns the exact body bytes", async () => {
    const r = await verify(request(BODY, fake.signForTest(BODY)));
    expect(r.ok).toBe(true);
    if (r.ok) expect(new TextDecoder().decode(r.body)).toBe(BODY);
  });

  it("rejects a missing header", async () => {
    expect(await verify(request(BODY, null))).toMatchObject({ ok: false, status: 400, reason: "missing_header" });
  });

  it("rejects an oversized body before doing anything else", async () => {
    const big = "x".repeat(70 * 1024);
    expect(await verify(request(big, fake.signForTest(big)))).toMatchObject({ ok: false, status: 413 });
    expect(cache.fetches).toBe(0);
  });

  it("rejects any alg other than ES256 (including none and HS256)", async () => {
    for (const alg of ["none", "HS256", "RS256", "ES384"]) {
      const jwt = reSign(fake.signForTest(BODY), (h) => (h.alg = alg));
      expect(await verify(request(BODY, jwt))).toMatchObject({ ok: false, status: 400, reason: "bad_alg" });
    }
    expect(cache.fetches).toBe(0);
  });

  it("rejects iat older than 5 minutes, without fetching a key", async () => {
    const jwt = fake.signForTest(BODY, { iat: now() - 301 });
    expect(await verify(request(BODY, jwt))).toMatchObject({ ok: false, status: 400, reason: "stale_or_future_iat" });
    expect(cache.fetches).toBe(0);
  });

  it("accepts iat just inside the 5 minute window", async () => {
    expect((await verify(request(BODY, fake.signForTest(BODY, { iat: now() - 290 })))).ok).toBe(true);
  });

  it("rejects iat in the future beyond clock skew", async () => {
    const jwt = fake.signForTest(BODY, { iat: now() + 120 });
    expect(await verify(request(BODY, jwt))).toMatchObject({ ok: false, reason: "stale_or_future_iat" });
  });

  it("rejects a body changed by a single whitespace byte", async () => {
    const jwt = fake.signForTest(BODY);
    const tampered = BODY.replace("\n", "\n ");
    expect(await verify(request(tampered, jwt))).toMatchObject({ ok: false, status: 401, reason: "body_hash_mismatch" });
  });

  it("rejects a re-serialized body even though it is the same JSON", async () => {
    const jwt = fake.signForTest(BODY);
    const compact = JSON.stringify(JSON.parse(BODY));
    expect(await verify(request(compact, jwt))).toMatchObject({ ok: false, reason: "body_hash_mismatch" });
  });

  it("rejects a forged signature", async () => {
    const jwt = fake.signForTest(BODY);
    const [h, p, s] = jwt.split(".");
    const sig = Buffer.from(s!, "base64url");
    sig[10] = sig[10]! ^ 0xff;
    expect(await verify(request(BODY, `${h}.${p}.${sig.toString("base64url")}`))).toMatchObject({
      ok: false,
      status: 401,
      reason: "bad_signature",
    });
  });

  it("rejects a payload swapped from another valid webhook", async () => {
    const other = BODY.replace("item-1", "item-2");
    const [h, , s] = fake.signForTest(BODY).split(".");
    const [, p2] = fake.signForTest(other).split(".");
    expect(await verify(request(other, `${h}.${p2}.${s}`))).toMatchObject({ ok: false, reason: "bad_signature" });
  });

  it("negative-caches unknown kids: random kids cannot amplify into calls to Plaid", async () => {
    for (let i = 0; i < 5; i++) {
      const jwt = reSign(fake.signForTest(BODY), (h) => (h.kid = "attacker-kid"));
      expect(await verify(request(BODY, jwt))).toMatchObject({ ok: false, status: 401, reason: "unknown_kid" });
    }
    expect(cache.fetches).toBe(1);
  });

  it("caches keys by kid and picks up a rotated key", async () => {
    await verify(request(BODY, fake.signForTest(BODY)));
    await verify(request(BODY, fake.signForTest(BODY)));
    expect(cache.fetches).toBe(1);
    fake.rotateKey();
    expect((await verify(request(BODY, fake.signForTest(BODY)))).ok).toBe(true);
    expect(cache.fetches).toBe(2);
  });

  it("rejects a token signed with a key after that key's expired_at", async () => {
    fake.rotateKey(); // expires the current key, adds a new one
    const state = fake.state();
    expect(state).toBeDefined();
    const expiredKid = "fake-key-1";
    const jwt = fake.signForTest(BODY, { kid: expiredKid, iat: now() + 5 });
    expect(await verify(request(BODY, jwt))).toMatchObject({ ok: false, status: 401, reason: "expired_key" });
    // A retry of a webhook signed before expiry is still valid.
    const old = fake.signForTest(BODY, { kid: expiredKid, iat: now() - 60 });
    expect((await verify(request(BODY, old))).ok).toBe(true);
  });

  it("answers 503 when the key cannot be fetched, so Plaid retries", async () => {
    const down = new PlaidHttpClient({ baseUrl: "http://127.0.0.1:1", clientId: "x", secret: "y", timeoutMs: 200 });
    const r = await verifyPlaidWebhook(request(BODY, fake.signForTest(BODY)), { plaid: down, cache });
    expect(r).toMatchObject({ ok: false, status: 503 });
  });
});

describe("constantTimeEqual", () => {
  it("compares equal and unequal strings", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
  });
});
