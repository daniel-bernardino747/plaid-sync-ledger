/**
 * The only logger in the repository (ADR 0013).
 *
 * Fields are filtered through an ALLOWLIST: anything not listed is dropped,
 * not masked. A denylist ("redact access_token") always misses the field
 * someone adds next month; an allowlist fails closed. Adding a field here is
 * a reviewed decision.
 *
 * Errors are reduced to classification fields only. Error messages, stacks,
 * causes and request/response bodies are never logged: those are exactly the
 * places tokens and PII hide.
 */

const ALLOWED_FIELDS = new Set([
  // identifiers: internal ids and Plaid item ids are not secrets or PII on their own
  "job_id",
  "job_kind",
  "item_id",
  "plaid_item_id",
  "worker_id",
  "webhook_type",
  "webhook_code",
  "dedup_key",
  // outcome and metrics
  "status",
  "outcome",
  "attempt",
  "max_attempts",
  "delay_ms",
  "duration_ms",
  "pages",
  "added",
  "modified",
  "removed",
  "restarts",
  "count",
  "reaped",
  "enqueued",
  "http_status",
  "reason",
  "scenario",
  "port",
  "url",
  "from_version",
  "to_version",
  // error classification (see serializeError)
  "error_name",
  "error_kind",
  "error_code",
  "plaid_error_type",
  "plaid_error_code",
  "pg_code",
]);

type Primitive = string | number | boolean | null;
export type LogFields = Record<string, unknown>;
type Level = "debug" | "info" | "warn" | "error";

export type Sink = (line: string) => void;

// The logger is the single place allowed to touch the console (no-console is
// an error everywhere else).
// eslint-disable-next-line no-console
let sink: Sink = (line) => console.log(line);

/** Tests capture output through this; production never changes it. */
export function setLogSink(next: Sink): void {
  sink = next;
}

function clean(fields: LogFields): Record<string, Primitive> {
  const out: Record<string, Primitive> = {};
  let dropped = 0;
  for (const [k, v] of Object.entries(fields)) {
    if (!ALLOWED_FIELDS.has(k)) {
      dropped++;
      continue;
    }
    if (v === null || typeof v === "number" || typeof v === "boolean") out[k] = v;
    else if (typeof v === "bigint") out[k] = v.toString();
    else if (typeof v === "string") out[k] = v.length > 200 ? `${v.slice(0, 200)}…` : v;
    else dropped++; // objects and arrays are never logged: they are how bodies leak
  }
  if (dropped > 0) out.dropped_fields = dropped;
  return out;
}

function emit(level: Level, event: string, fields: LogFields): void {
  sink(JSON.stringify({ ts: new Date().toISOString(), level, event, ...clean(fields) }));
}

export const log = {
  debug: (event: string, fields: LogFields = {}) => emit("debug", event, fields),
  info: (event: string, fields: LogFields = {}) => emit("info", event, fields),
  warn: (event: string, fields: LogFields = {}) => emit("warn", event, fields),
  error: (event: string, fields: LogFields = {}) => emit("error", event, fields),
};

/**
 * Classification-only view of an error. Reads a few well-known properties and
 * nothing else: never `message`, `stack`, `cause`, or anything body-shaped.
 */
export function serializeError(e: unknown): LogFields {
  if (typeof e !== "object" || e === null) return { error_name: typeof e };
  const o = e as Record<string, unknown>;
  // Each field must match the exact shape of the thing it classifies. A loose
  // pattern would let a token-shaped string through under an innocent key.
  const pick = (v: unknown, shape: RegExp) => (typeof v === "string" && shape.test(v) ? v : undefined);
  const fields: LogFields = { error_name: pick(o.name, /^[A-Za-z]{1,40}$/) ?? "Error" };
  const kind = pick(o.kind, /^[a-z_]{1,40}$/);
  if (kind) fields.error_kind = kind;
  const plaidType = pick(o.errorType, /^[A-Z_]{1,64}$/);
  if (plaidType) fields.plaid_error_type = plaidType;
  const plaidCode = pick(o.errorCode, /^[A-Z0-9_]{1,64}$/);
  if (plaidCode) fields.plaid_error_code = plaidCode;
  // SQLSTATE codes are exactly five characters (e.g. 23505, 40001)
  const code = pick(o.code, /^[0-9A-Z]{5}$/);
  if (code) fields.pg_code = code;
  return fields;
}
