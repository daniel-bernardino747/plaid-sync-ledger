import { describe, expect, it } from "vitest";
import { plaidConfigFromEnv } from "../src/config.ts";

// One place decides where Plaid calls go and which credentials they carry.

const REAL = { PLAID_CLIENT_ID: "real-client-id-123", PLAID_SECRET: "real-sandbox-secret-456" };

describe("plaidConfigFromEnv", () => {
  it("targets the fake by default, with the fake's own credentials", () => {
    expect(plaidConfigFromEnv({})).toEqual({
      target: "fake",
      baseUrl: "http://127.0.0.1:4010",
      clientId: "fake-client-id",
      secret: "fake-secret",
    });
  });

  it("never sends real credentials to the fake, even when they are configured", () => {
    const cfg = plaidConfigFromEnv({ PLAID_TARGET: "fake", ...REAL });
    expect(JSON.stringify(cfg)).not.toContain(REAL.PLAID_CLIENT_ID);
    expect(JSON.stringify(cfg)).not.toContain(REAL.PLAID_SECRET);
  });

  it("lets the fake's URL be moved, but only to a local address", () => {
    expect(plaidConfigFromEnv({ FAKE_PLAID_URL: "http://localhost:5010" }).baseUrl).toBe("http://localhost:5010");
    expect(() => plaidConfigFromEnv({ FAKE_PLAID_URL: "https://evil.example" })).toThrow(/local/);
  });

  it("targets real Sandbox with the configured credentials", () => {
    expect(plaidConfigFromEnv({ PLAID_TARGET: "sandbox", ...REAL })).toEqual({
      target: "sandbox",
      baseUrl: "https://sandbox.plaid.com",
      clientId: REAL.PLAID_CLIENT_ID,
      secret: REAL.PLAID_SECRET,
    });
  });

  it("refuses to start against Sandbox without credentials", () => {
    expect(() => plaidConfigFromEnv({ PLAID_TARGET: "sandbox" })).toThrow(/PLAID_CLIENT_ID/);
  });

  it("rejects any other target, including production", () => {
    expect(() => plaidConfigFromEnv({ PLAID_TARGET: "production", ...REAL })).toThrow(/PLAID_TARGET/);
  });
});
