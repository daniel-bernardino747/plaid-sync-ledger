import { describe, expect, it } from "vitest";
import { classifyPlaidError } from "../src/errors.ts";

// The single mapping from Plaid errors to retry decisions (ADR 0008).

describe("classifyPlaidError", () => {
  it.each([
    [429, { error_type: "RATE_LIMIT_EXCEEDED", error_code: "RATE_LIMIT" }, "rate_limited", true],
    [500, { error_type: "API_ERROR", error_code: "INTERNAL_SERVER_ERROR" }, "transient", true],
    [503, { error_type: "API_ERROR", error_code: "PLANNED_MAINTENANCE" }, "transient", true],
    [400, { error_type: "INSTITUTION_ERROR", error_code: "INSTITUTION_DOWN" }, "transient", true],
    [400, { error_type: "ITEM_ERROR", error_code: "ITEM_LOGIN_REQUIRED" }, "item_login_required", false],
    [400, { error_type: "TRANSACTIONS_ERROR", error_code: "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION" }, "mutation_during_pagination", false],
    [400, { error_type: "INVALID_INPUT", error_code: "INVALID_ACCESS_TOKEN" }, "fatal", false],
    [502, null, "transient", true], // proxy error page, not a Plaid body
    [429, null, "rate_limited", true],
    [404, null, "fatal", false],
  ] as const)("HTTP %i %o -> %s", (status, body, kind, retryable) => {
    const e = classifyPlaidError(status, body);
    expect(e.kind).toBe(kind);
    expect(e.retryable).toBe(retryable);
  });

  it("branches on error_code over HTTP status, as Plaid's docs recommend", () => {
    // A Plaid API_ERROR is transient even if it came with a 4xx status.
    expect(classifyPlaidError(400, { error_type: "API_ERROR", error_code: "INTERNAL_SERVER_ERROR" }).kind).toBe("transient");
  });
});
