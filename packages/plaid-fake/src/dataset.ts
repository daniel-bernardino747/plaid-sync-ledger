/**
 * Deterministic transaction history for fake Items (ADR 0008, ADR 0010).
 *
 * An Item's history is a list of events split into batches. A batch is
 * "released" when the fake simulates Plaid receiving new data from the bank;
 * only released events are visible to /transactions/sync. Nothing depends on
 * the wall clock: the same seed always yields the same ledger.
 */

export interface FakeTransaction {
  transaction_id: string;
  account_id: string;
  /** Integer cents. Rendered as a JSON number the way Plaid does. */
  cents: number;
  iso_currency_code: string;
  date: string;
  authorized_date: string | null;
  name: string;
  merchant_name: string | null;
  pending: boolean;
  pending_transaction_id: string | null;
}

export type FakeEvent =
  | { op: "upsert"; tx: FakeTransaction }
  | { op: "remove"; transaction_id: string; account_id: string };

export interface FakeAccount {
  account_id: string;
  name: string;
  mask: string;
  type: string;
  subtype: string;
}

export interface ItemDataset {
  accounts: FakeAccount[];
  batches: FakeEvent[][];
}

/** mulberry32: tiny, seedable, good enough for test data. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BASE_DATE = Date.UTC(2026, 5, 30); // fixed, never "today"
const MERCHANTS = [
  "Blue Bottle Coffee",
  "Whole Foods Market",
  "Uber",
  "Shell",
  "Netflix",
  "Delta Air Lines",
  "Trader Joe's",
  // Values that break naive encodings (ADR 0009) and leak detection (ADR 0013).
  "Bar | Grill",
  "CANARY_MERCHANT_JANE_DOE",
  "Café Ünïcode",
];
// Amounts that are not exactly representable as doubles, or are large.
const TRICKY_CENTS = [10, 20, 30, 70, 110, 1999, 123456789, -4560, 1, 100000];

function day(offsetDays: number): string {
  return new Date(BASE_DATE - offsetDays * 86_400_000).toISOString().slice(0, 10);
}

export function buildDataset(itemKey: string, seed: number, opts: { initialSize?: number; batches?: number } = {}): ItemDataset {
  const rand = prng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
  const accounts: FakeAccount[] = [
    { account_id: `${itemKey}-acc-chk`, name: "Plaid Checking", mask: "0000", type: "depository", subtype: "checking" },
    { account_id: `${itemKey}-acc-sav`, name: "Plaid Saving", mask: "1111", type: "depository", subtype: "savings" },
  ];

  let seq = 0;
  const live = new Map<string, FakeTransaction>();
  const pendingIds: string[] = [];

  const newTx = (dayOffset: number, pending: boolean): FakeTransaction => {
    seq += 1;
    const merchant = pick(MERCHANTS);
    const tricky = rand() < 0.08;
    const cents = tricky ? pick(TRICKY_CENTS) : Math.round((rand() * 300 + 1) * 100) * (rand() < 0.1 ? -1 : 1);
    return {
      transaction_id: `${itemKey}-tx-${String(seq).padStart(5, "0")}`,
      account_id: pick(accounts).account_id,
      cents,
      iso_currency_code: "USD",
      date: day(dayOffset),
      authorized_date: rand() < 0.7 ? day(dayOffset + 1) : null,
      name: merchant.toUpperCase(),
      merchant_name: rand() < 0.85 ? merchant : null,
      pending,
      pending_transaction_id: null,
    };
  };

  const batches: FakeEvent[][] = [];

  // Batch 0: the initial pull.
  const initial: FakeEvent[] = [];
  const initialSize = opts.initialSize ?? 230;
  for (let i = 0; i < initialSize; i++) {
    const pending = i >= initialSize - 8;
    const tx = newTx(Math.floor((initialSize - i) / 2) + 2, pending);
    live.set(tx.transaction_id, tx);
    if (pending) pendingIds.push(tx.transaction_id);
    initial.push({ op: "upsert", tx });
  }
  batches.push(initial);

  // Later batches: new activity, pending -> posted, edits, removals.
  const batchCount = opts.batches ?? 4;
  for (let b = 1; b <= batchCount; b++) {
    const events: FakeEvent[] = [];

    // Pending transactions settle: Plaid removes the pending one and adds a
    // posted one that points back to it via pending_transaction_id.
    for (const pid of pendingIds.splice(0, 4)) {
      const pend = live.get(pid);
      if (!pend) continue;
      live.delete(pid);
      events.push({ op: "remove", transaction_id: pid, account_id: pend.account_id });
      seq += 1;
      const posted: FakeTransaction = {
        ...pend,
        transaction_id: `${itemKey}-tx-${String(seq).padStart(5, "0")}`,
        pending: false,
        pending_transaction_id: pid,
        cents: rand() < 0.3 ? pend.cents + 150 : pend.cents, // tips settle later
      };
      live.set(posted.transaction_id, posted);
      events.push({ op: "upsert", tx: posted });
    }

    for (let i = 0; i < 15; i++) {
      const pending = i % 5 === 0;
      const tx = newTx(1 - b, pending);
      tx.date = day(-b);
      live.set(tx.transaction_id, tx);
      if (pending) pendingIds.push(tx.transaction_id);
      events.push({ op: "upsert", tx });
    }

    const posted = [...live.values()].filter((t) => !t.pending);
    for (let i = 0; i < 3; i++) {
      const t = pick(posted);
      const edited = { ...t, merchant_name: `${t.merchant_name ?? "Unknown"} (edited ${b})` };
      live.set(t.transaction_id, edited);
      events.push({ op: "upsert", tx: edited });
    }
    for (let i = 0; i < 2; i++) {
      const t = pick([...live.values()].filter((x) => !x.pending));
      live.delete(t.transaction_id);
      events.push({ op: "remove", transaction_id: t.transaction_id, account_id: t.account_id });
    }
    batches.push(events);
  }

  return { accounts, batches };
}

/** Renders cents as the JSON number text Plaid would send, e.g. 1999 -> 19.99. */
export function centsToJsonNumber(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const frac = abs % 100;
  if (frac === 0) return `${sign}${whole}`;
  return `${sign}${whole}.${String(frac).padStart(2, "0").replace(/0$/, "")}`;
}
