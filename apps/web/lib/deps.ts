import { Keyring } from "@psl/crypto";
import { createDb, type Db } from "@psl/db";
import { PlaidHttpClient } from "@psl/plaid";

/**
 * Server-side singletons. The web app connects as app_web, which is subject to
 * row-level security (ADR 0007): every user-facing query must go through
 * forUser(), or it sees nothing.
 */
export interface Deps {
  webDb: Db;
  keyring: Keyring;
  plaid: PlaidHttpClient;
  sessionSecret: string;
  webhookUrl: string | null;
  /** True against real Plaid (Sandbox): the Link UI can only run there. */
  realPlaid: boolean;
}

let deps: Promise<Deps> | null = null;

export function getDeps(): Promise<Deps> {
  deps ??= (async () => {
    const need = (name: string) => {
      const v = process.env[name];
      if (!v) throw new Error(`missing env ${name}`);
      return v;
    };
    const baseUrl = need("PLAID_BASE_URL");
    const secret = need("SESSION_SECRET");
    if (secret.length < 32) throw new Error("SESSION_SECRET must be at least 32 characters");
    return {
      webDb: createDb(need("DATABASE_URL_WEB")),
      keyring: await Keyring.fromEnv({ MASTER_KEYS: process.env.MASTER_KEYS, MASTER_KEY_CURRENT: process.env.MASTER_KEY_CURRENT }),
      plaid: new PlaidHttpClient({
        baseUrl,
        clientId: process.env.PLAID_CLIENT_ID || "fake-client-id",
        secret: process.env.PLAID_SECRET || "fake-secret",
      }),
      sessionSecret: secret,
      webhookUrl: process.env.PLAID_WEBHOOK_URL || null,
      realPlaid: /\.plaid\.com$/.test(new URL(baseUrl).hostname),
    };
  })();
  return deps;
}
