import { beforeAll, describe, expect, it } from "vitest";
import {
  DecryptionError,
  Keyring,
  decryptField,
  encryptField,
  generateDek,
  keyVersionOf,
  newMasterKey,
  rewrapDek,
  unwrapDek,
  wrapDek,
} from "../src/index.ts";

const ALICE = "00000000-0000-4000-8000-00000000000a";
const BOB = "00000000-0000-4000-8000-00000000000b";
const TOKEN = "access-sandbox-CANARY-0b6e2c1a";
const ctx = (rowId: string, column = "access_token_ct") => ({ table: "items", column, rowId });

let k1: Keyring; // only v1
let k12: Keyring; // v1 + v2, current = 2

beforeAll(async () => {
  const v1 = newMasterKey();
  const v2 = newMasterKey();
  k1 = await Keyring.fromEnv({ MASTER_KEYS: JSON.stringify({ 1: v1 }), MASTER_KEY_CURRENT: "1" });
  k12 = await Keyring.fromEnv({ MASTER_KEYS: JSON.stringify({ 1: v1, 2: v2 }), MASTER_KEY_CURRENT: "2" });
});

async function aliceKey(keyring = k1) {
  const wrapped = await wrapDek(keyring, ALICE, generateDek());
  return { wrapped, dk: await unwrapDek(keyring, ALICE, wrapped) };
}

describe("envelope encryption", () => {
  it("round-trips and never contains the plaintext", async () => {
    const { dk } = await aliceKey();
    const ct = await encryptField(dk, ctx("item-1"), TOKEN);
    expect(ct).toMatch(/^v1\.1\.[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(ct).not.toContain("CANARY");
    expect(await decryptField(dk, ctx("item-1"), ct)).toBe(TOKEN);
  });

  it("uses a fresh IV every time", async () => {
    const { dk } = await aliceKey();
    const a = await encryptField(dk, ctx("item-1"), TOKEN);
    const b = await encryptField(dk, ctx("item-1"), TOKEN);
    expect(a).not.toBe(b);
  });

  it("records the master key version alongside the wrapped DEK", async () => {
    const { wrapped } = await aliceKey(k12);
    expect(keyVersionOf(wrapped)).toBe(2);
  });
});

describe("AAD binding: a ciphertext cannot be moved", () => {
  it("fails when copied to another row", async () => {
    const { dk } = await aliceKey();
    const ct = await encryptField(dk, ctx("item-1"), TOKEN);
    await expect(decryptField(dk, ctx("item-2"), ct)).rejects.toBeInstanceOf(DecryptionError);
  });

  it("fails when copied to another column", async () => {
    const { dk } = await aliceKey();
    const ct = await encryptField(dk, ctx("item-1"), TOKEN);
    await expect(decryptField(dk, ctx("item-1", "other_secret_ct"), ct)).rejects.toBeInstanceOf(DecryptionError);
  });

  it("fails when copied to another user, even if the attacker also copies the wrapped DEK", async () => {
    const { wrapped, dk } = await aliceKey();
    const ct = await encryptField(dk, ctx("item-1"), TOKEN);
    // Copying Alice's wrapped DEK onto Bob's user_keys row does not unwrap.
    await expect(unwrapDek(k1, BOB, wrapped)).rejects.toBeInstanceOf(DecryptionError);
    // Bob's own key cannot open Alice's ciphertext either.
    const bobDk = await unwrapDek(k1, BOB, await wrapDek(k1, BOB, generateDek()));
    await expect(decryptField(bobDk, ctx("item-1"), ct)).rejects.toBeInstanceOf(DecryptionError);
  });

  it("detects tampering with any segment", async () => {
    const { dk } = await aliceKey();
    const ct = await encryptField(dk, ctx("item-1"), TOKEN);
    const parts = ct.split(".");
    for (const i of [2, 3, 4]) {
      const p = [...parts];
      const seg = p[i]!;
      p[i] = (seg[0] === "A" ? "B" : "A") + seg.slice(1);
      await expect(decryptField(dk, ctx("item-1"), p.join("."))).rejects.toBeInstanceOf(DecryptionError);
    }
    await expect(decryptField(dk, ctx("item-1"), `v2.${parts.slice(1).join(".")}`)).rejects.toBeInstanceOf(DecryptionError);
  });
});

describe("master key rotation", () => {
  it("re-wraps the DEK under the new version without touching field ciphertexts", async () => {
    const wrappedV1 = await wrapDek(k12, ALICE, generateDek(), 1);
    const dk = await unwrapDek(k12, ALICE, wrappedV1);
    const ct = await encryptField(dk, ctx("item-1"), TOKEN);

    const wrappedV2 = await rewrapDek(k12, ALICE, wrappedV1, 2);
    expect(keyVersionOf(wrappedV2)).toBe(2);
    const dk2 = await unwrapDek(k12, ALICE, wrappedV2);
    expect(await decryptField(dk2, ctx("item-1"), ct)).toBe(TOKEN);
  });

  it("cannot unwrap once the old version is removed from the ring", async () => {
    const wrappedV2 = await wrapDek(k12, ALICE, generateDek(), 2);
    await expect(unwrapDek(k1, ALICE, wrappedV2)).rejects.toBeInstanceOf(DecryptionError);
  });

  it("rejects a keyring whose current version is missing or whose key is not 256-bit", async () => {
    await expect(Keyring.fromEnv({ MASTER_KEYS: JSON.stringify({ 1: newMasterKey() }), MASTER_KEY_CURRENT: "2" })).rejects.toThrow();
    await expect(Keyring.fromEnv({ MASTER_KEYS: JSON.stringify({ 1: btoa("short") }), MASTER_KEY_CURRENT: "1" })).rejects.toThrow();
  });
});
