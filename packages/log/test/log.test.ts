import { afterEach, describe, expect, it } from "vitest";
import { log, serializeError, setLogSink } from "../src/index.ts";

const lines: string[] = [];
setLogSink((l) => lines.push(l));
afterEach(() => {
  lines.length = 0;
});

describe("allowlist logger", () => {
  it("drops fields that are not on the allowlist instead of masking them", () => {
    log.info("x", { item_id: "item-1", access_token: "access-sandbox-CANARY-1", name: "Jane Doe" });
    const out = JSON.parse(lines[0]!);
    expect(out).toMatchObject({ event: "x", item_id: "item-1", dropped_fields: 2 });
    expect(lines[0]).not.toContain("CANARY");
    expect(lines[0]).not.toContain("Jane");
  });

  it("never logs objects or arrays, even under an allowed key", () => {
    log.info("x", { reason: { access_token: "access-sandbox-CANARY-2" } as unknown as string });
    expect(lines[0]).not.toContain("CANARY");
  });

  it("reduces errors to classification fields, never the message, stack or cause", () => {
    const e = Object.assign(new Error("failed for access-sandbox-CANARY-3"), {
      kind: "transient",
      errorCode: "INTERNAL_SERVER_ERROR",
      cause: { body: "access-sandbox-CANARY-3" },
    });
    log.error("x", serializeError(e));
    expect(lines[0]).not.toContain("CANARY");
    expect(JSON.parse(lines[0]!)).toMatchObject({ error_name: "Error", error_kind: "transient", plaid_error_code: "INTERNAL_SERVER_ERROR" });
  });

  it("ignores classification fields that do not look like codes", () => {
    log.error("x", serializeError({ name: "Error", code: "access-sandbox-CANARY-4", errorCode: "access-sandbox-CANARY-5", kind: "CANARY-6" }));
    expect(lines[0]).not.toContain("CANARY");
  });
});
