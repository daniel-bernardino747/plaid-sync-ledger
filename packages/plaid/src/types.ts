/** Domain-shaped view of the Plaid API. Only what this system uses (ADR 0008). */

export interface PlaidTransaction {
  transactionId: string;
  accountId: string;
  /** Exact decimal text as sent by Plaid, never a float (ADR 0009). */
  amount: string;
  isoCurrencyCode: string | null;
  date: string; // YYYY-MM-DD
  authorizedDate: string | null;
  name: string;
  merchantName: string | null;
  pending: boolean;
  pendingTransactionId: string | null;
}

export interface PlaidAccount {
  accountId: string;
  name: string;
  mask: string | null;
  type: string;
  subtype: string | null;
}

export interface RemovedTransaction {
  transactionId: string;
  accountId: string | null;
}

export interface SyncPage {
  added: PlaidTransaction[];
  modified: PlaidTransaction[];
  removed: RemovedTransaction[];
  accounts: PlaidAccount[];
  nextCursor: string;
  hasMore: boolean;
  updateStatus: string | null;
}

export interface ItemStatus {
  itemId: string;
  /** error_code of the Item's current error, or null when healthy. */
  errorCode: string | null;
  consentExpirationTime: string | null;
}

/** EC public key in JWK form. Declared here so the package needs no DOM lib. */
export interface EcJwk {
  kty: string;
  crv: string;
  x: string;
  y: string;
  kid: string;
  alg?: string;
  use?: string;
}

export interface VerificationKey {
  jwk: EcJwk;
  /** Unix seconds, or null if the key has not expired. */
  expiredAt: number | null;
}

export interface PlaidGateway {
  exchangePublicToken(publicToken: string): Promise<{ itemId: string; accessToken: string }>;
  syncTransactions(input: { accessToken: string; cursor: string | null; count: number }): Promise<SyncPage>;
  getItem(accessToken: string): Promise<ItemStatus>;
  /** Resolves null when Plaid does not know the key id. */
  getWebhookVerificationKey(kid: string): Promise<VerificationKey | null>;
  createLinkToken(input: { userId: string; webhook: string | null; accessToken?: string }): Promise<string>;
}

/** Sandbox-only endpoints, used by tests and the chaos harness. */
export interface PlaidSandbox {
  createPublicToken(input: { institutionId: string; webhook: string | null }): Promise<string>;
  resetLogin(accessToken: string): Promise<void>;
  fireWebhook(accessToken: string, webhookCode: string): Promise<void>;
}
