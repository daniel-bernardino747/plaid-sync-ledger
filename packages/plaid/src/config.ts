/**
 * The single place that decides where Plaid calls go and which credentials
 * they carry (ADR 0008).
 *
 *   PLAID_TARGET=fake     (default) the local fake, with the fake's own fixed
 *                         credentials. PLAID_CLIENT_ID / PLAID_SECRET are never
 *                         read, so real credentials cannot reach a non-Plaid host.
 *   PLAID_TARGET=sandbox  https://sandbox.plaid.com with PLAID_CLIENT_ID /
 *                         PLAID_SECRET, which are then required.
 *
 * There is deliberately no production target: this repository is a
 * demonstration, so Sandbox-only endpoints are safe by construction.
 */

export type PlaidTarget = "fake" | "sandbox";

export interface PlaidConfig {
  target: PlaidTarget;
  baseUrl: string;
  clientId: string;
  secret: string;
}

type Env = Record<string, string | undefined>;

const FAKE_CREDENTIALS = { clientId: "fake-client-id", secret: "fake-secret" };
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function plaidConfigFromEnv(env: Env): PlaidConfig {
  const target = env.PLAID_TARGET || "fake";

  if (target === "fake") {
    const baseUrl = env.FAKE_PLAID_URL || "http://127.0.0.1:4010";
    if (!LOCAL_HOSTS.has(new URL(baseUrl).hostname)) throw new Error("FAKE_PLAID_URL must be a local address");
    return { target, baseUrl, ...FAKE_CREDENTIALS };
  }

  if (target === "sandbox") {
    const clientId = env.PLAID_CLIENT_ID;
    const secret = env.PLAID_SECRET;
    if (!clientId || !secret) throw new Error("PLAID_TARGET=sandbox requires PLAID_CLIENT_ID and PLAID_SECRET");
    return { target, baseUrl: "https://sandbox.plaid.com", clientId, secret };
  }

  throw new Error("PLAID_TARGET must be 'fake' or 'sandbox'");
}
