/**
 * JSON.parse that keeps the exact source text of every `amount` field.
 *
 * Plaid sends amounts as JSON numbers. Parsing them as doubles and printing
 * them back is how 0.1 + 0.2 bugs reach a ledger. With JSON.parse source-text
 * access (Node >= 21, Workers) we read the digits Plaid actually sent and hand
 * that string straight to NUMERIC(19,4). No float is ever involved.
 */
const AMOUNT_TEXT = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;

type Reviver = (this: unknown, key: string, value: unknown, ctx?: { source?: string }) => unknown;

const keepAmountText: Reviver = (key, value, ctx) => {
  if (key === "amount" && typeof value === "number") {
    const source = ctx?.source;
    if (source === undefined) {
      throw new Error("JSON.parse source text access is required to read amounts exactly");
    }
    if (!AMOUNT_TEXT.test(source)) throw new Error("malformed amount");
    return source;
  }
  return value;
};

export function parsePlaidJson(text: string): unknown {
  return JSON.parse(text, keepAmountText as Parameters<typeof JSON.parse>[1]);
}
