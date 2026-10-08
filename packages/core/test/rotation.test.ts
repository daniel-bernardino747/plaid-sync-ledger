import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Keyring, newMasterKey } from "@psl/crypto";
import { decryptAccessToken, getOrCreateDataKey, loadDataKey, encryptAccessToken } from "../src/keys.ts";
import { rotateMasterKey } from "../src/rotation.ts";
import { createHarness, type Harness } from "./harness.ts";

// ADR 0006: rotating the master key re-wraps DEKs only, in batches, while
// readers keep decrypting tokens the whole time.

let h: Harness;
let v1: string;
let v2: string;
let ringV1: Keyring;
let ringBoth: Keyring;
let ringV2: Keyring;

beforeAll(async () => {
  h = await createHarness("psl_test_core_rotation");
  v1 = newMasterKey();
  v2 = newMasterKey();
  ringV1 = await Keyring.fromEnv({ MASTER_KEYS: JSON.stringify({ 1: v1 }), MASTER_KEY_CURRENT: "1" });
  ringBoth = await Keyring.fromEnv({ MASTER_KEYS: JSON.stringify({ 1: v1, 2: v2 }), MASTER_KEY_CURRENT: "2" });
  ringV2 = await Keyring.fromEnv({ MASTER_KEYS: JSON.stringify({ 2: v2 }), MASTER_KEY_CURRENT: "2" });
});
afterAll(() => h.close());
beforeEach(() => h.reset());

const USERS = 40;
const uid = (i: number) => `00000000-0000-4000-9000-${String(i).padStart(12, "0")}`;

async function seed() {
  const tokens = new Map<string, string>();
  for (let i = 0; i < USERS; i++) {
    const userId = uid(i);
    await h.owner.query(`INSERT INTO users (id, name) VALUES ($1, $2)`, [userId, `u${i}`]);
    const itemId = globalThis.crypto.randomUUID();
    const token = `access-sandbox-CANARY-${i}`;
    await h.system.$transaction(async (tx) => {
      const dk = await getOrCreateDataKey(tx, ringV1, userId);
      await tx.item.create({
        data: { id: itemId, userId, plaidItemId: `p-${i}`, accessTokenCt: await encryptAccessToken(dk, itemId, token) },
      });
    });
    tokens.set(itemId, token);
  }
  return tokens;
}

async function readAll(keyring: Keyring, tokens: Map<string, string>) {
  const items = await h.system.item.findMany();
  for (const item of items) {
    const dk = await loadDataKey(h.system, keyring, item.userId);
    expect(await decryptAccessToken(dk, item.id, item.accessTokenCt)).toBe(tokens.get(item.id));
  }
  return items.length;
}

describe("master key rotation", () => {
  it("re-wraps every DEK while concurrent readers keep decrypting, then works without the old key", async () => {
    const tokens = await seed();
    const ctBefore = (await h.system.item.findMany({ orderBy: { id: "asc" } })).map((i) => i.accessTokenCt);

    // Readers run during the whole rotation, as the worker would in production.
    let reads = 0;
    let readerError: unknown = null;
    let rotating = true;
    const reader = (async () => {
      while (rotating) {
        try {
          reads += await readAll(ringBoth, tokens);
        } catch (e) {
          readerError = e;
          return;
        }
      }
    })();

    const r = await rotateMasterKey(h.system, ringBoth, { from: 1, to: 2, batchSize: 7, pauseMs: 5 });
    rotating = false;
    await reader;

    expect(readerError).toBeNull();
    expect(reads).toBeGreaterThan(0);
    expect(r).toEqual({ rewrapped: USERS, remaining: 0 });

    // Field ciphertexts were never touched.
    const ctAfter = (await h.system.item.findMany({ orderBy: { id: "asc" } })).map((i) => i.accessTokenCt);
    expect(ctAfter).toEqual(ctBefore);

    // Step 3: the old version is gone from the ring and everything still opens.
    expect(await readAll(ringV2, tokens)).toBe(USERS);
  });

  it("is safe to re-run and safe to run twice concurrently", async () => {
    await seed();
    const [a, b] = await Promise.all([
      rotateMasterKey(h.system, ringBoth, { from: 1, to: 2, batchSize: 5 }),
      rotateMasterKey(h.system, ringBoth, { from: 1, to: 2, batchSize: 5 }),
    ]);
    expect(a.rewrapped + b.rewrapped).toBe(USERS); // each row re-wrapped exactly once
    expect(await rotateMasterKey(h.system, ringBoth, { from: 1, to: 2 })).toEqual({ rewrapped: 0, remaining: 0 });
  });

  it("refuses to run when a version is missing from the ring", async () => {
    await expect(rotateMasterKey(h.system, ringV1, { from: 1, to: 2 })).rejects.toThrow(/MASTER_KEYS/);
  });
});
