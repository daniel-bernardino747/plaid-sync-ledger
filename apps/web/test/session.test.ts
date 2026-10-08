import { describe, expect, it } from "vitest";
import { assertSameOrigin, HttpError, signSession, SESSION_TTL_SECONDS, verifySession } from "../lib/session.ts";

// ADR 0011: the session is the trust boundary in front of RLS.

const SECRET = "x".repeat(64);
const USER = "00000000-0000-4000-8000-00000000000a";
const NOW = 1_800_000_000;

describe("session cookie", () => {
  it("round-trips a user id", () => {
    expect(verifySession(SECRET, signSession(SECRET, USER, NOW), NOW + 10)).toBe(USER);
  });

  it("rejects a tampered payload (switching to another user)", () => {
    const [, sig] = signSession(SECRET, USER, NOW).split(".");
    const forged = Buffer.from(JSON.stringify({ u: "00000000-0000-4000-8000-00000000000b", exp: NOW + 999 })).toString("base64url");
    expect(verifySession(SECRET, `${forged}.${sig}`, NOW)).toBeNull();
  });

  it("rejects a cookie signed with another secret", () => {
    expect(verifySession(SECRET, signSession("y".repeat(64), USER, NOW), NOW)).toBeNull();
  });

  it("rejects an expired cookie", () => {
    expect(verifySession(SECRET, signSession(SECRET, USER, NOW), NOW + SESSION_TTL_SECONDS + 1)).toBeNull();
  });

  it("rejects malformed values", () => {
    for (const v of [undefined, "", "abc", "a.b.c", "!!.??"]) expect(verifySession(SECRET, v, NOW)).toBeNull();
  });
});

describe("same-origin check on mutations", () => {
  const req = (method: string, origin: string | null) =>
    new Request("http://localhost:3000/api/plaid/exchange", {
      method,
      headers: origin ? { origin } : {},
      ...(method === "POST" ? { body: "{}" } : {}),
    });

  it("accepts a same-origin POST", () => {
    expect(() => assertSameOrigin(req("POST", "http://localhost:3000"))).not.toThrow();
  });

  it("rejects a cross-origin POST", () => {
    expect(() => assertSameOrigin(req("POST", "https://evil.example"))).toThrow(HttpError);
  });

  it("rejects a POST without Origin", () => {
    expect(() => assertSameOrigin(req("POST", null))).toThrow(/cross-origin/);
  });

  it("rejects state changes over GET", () => {
    expect(() => assertSameOrigin(req("GET", "http://localhost:3000"))).toThrow(/method/);
  });
});
