/**
 * Every Plaid failure is mapped, in this one place, onto the small set of
 * outcomes the sync engine and retry policy actually decide on (ADR 0008).
 *
 * Messages never include request or response bodies: they can carry tokens.
 */
export type PlaidFailureKind =
  | "mutation_during_pagination" // restart the whole loop from the start cursor
  | "item_login_required" // stop syncing the item, needs Link update mode
  | "rate_limited" // retry with backoff
  | "transient" // 5xx, timeout, network, institution outage: retry with backoff
  | "fatal"; // retrying cannot help: dead-letter

export class PlaidCallError extends Error {
  readonly kind: PlaidFailureKind;
  readonly errorType: string | null;
  readonly errorCode: string | null;
  readonly httpStatus: number | null;

  constructor(
    kind: PlaidFailureKind,
    info: { errorType?: string | null; errorCode?: string | null; httpStatus?: number | null } = {},
  ) {
    super(`plaid ${kind}${info.errorCode ? ` (${info.errorCode})` : ""}`);
    this.name = "PlaidCallError";
    this.kind = kind;
    this.errorType = info.errorType ?? null;
    this.errorCode = info.errorCode ?? null;
    this.httpStatus = info.httpStatus ?? null;
  }

  get retryable(): boolean {
    return this.kind === "transient" || this.kind === "rate_limited";
  }
}

const TRANSIENT_CODES = new Set([
  "INTERNAL_SERVER_ERROR",
  "PLANNED_MAINTENANCE",
  "INSTITUTION_DOWN",
  "INSTITUTION_NOT_RESPONDING",
  "INSTITUTION_NOT_AVAILABLE",
]);

/**
 * Plaid's docs say to branch on error_type / error_code rather than HTTP
 * status. HTTP status is only the fallback when the body is not a Plaid error.
 */
export function classifyPlaidError(
  httpStatus: number,
  body: { error_type?: unknown; error_code?: unknown } | null,
): PlaidCallError {
  const errorType = typeof body?.error_type === "string" ? body.error_type : null;
  const errorCode = typeof body?.error_code === "string" ? body.error_code : null;
  const info = { errorType, errorCode, httpStatus };

  if (errorCode === "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION") {
    return new PlaidCallError("mutation_during_pagination", info);
  }
  if (errorCode === "ITEM_LOGIN_REQUIRED") return new PlaidCallError("item_login_required", info);
  if (errorType === "RATE_LIMIT_EXCEEDED") return new PlaidCallError("rate_limited", info);
  if (errorType === "API_ERROR" || errorType === "INSTITUTION_ERROR") {
    return new PlaidCallError("transient", info);
  }
  if (errorCode && TRANSIENT_CODES.has(errorCode)) return new PlaidCallError("transient", info);
  if (errorType || errorCode) return new PlaidCallError("fatal", info);

  // Not a Plaid error body (proxy page, empty body): fall back to status.
  if (httpStatus === 429) return new PlaidCallError("rate_limited", info);
  if (httpStatus >= 500) return new PlaidCallError("transient", info);
  return new PlaidCallError("fatal", info);
}
