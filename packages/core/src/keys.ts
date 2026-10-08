import { decryptField, encryptField, generateDek, unwrapDek, wrapDek, type DataKey, type Keyring } from "@psl/crypto";
import type { Tx } from "@psl/db";

export const ACCESS_TOKEN_FIELD = (itemId: string) => ({ table: "items", column: "access_token_ct", rowId: itemId });

/** Loads the user's DEK, creating it on first use. Safe under concurrent first use. */
export async function getOrCreateDataKey(tx: Tx, keyring: Keyring, userId: string): Promise<DataKey> {
  const existing = await tx.userKey.findUnique({ where: { userId } });
  if (existing) return unwrapDek(keyring, userId, existing.wrappedDek);

  const dek = generateDek();
  const wrapped = await wrapDek(keyring, userId, dek);
  dek.fill(0);
  // Two concurrent first connections for the same user both generate a DEK;
  // exactly one wins and both continue with the winner's key.
  await tx.$executeRaw`
    INSERT INTO user_keys (user_id, wrapped_dek, master_key_version)
    VALUES (${userId}::uuid, ${wrapped}, ${keyring.current})
    ON CONFLICT (user_id) DO NOTHING`;
  const winner = await tx.userKey.findUniqueOrThrow({ where: { userId } });
  return unwrapDek(keyring, userId, winner.wrappedDek);
}

export async function loadDataKey(tx: Pick<Tx, "userKey">, keyring: Keyring, userId: string): Promise<DataKey> {
  const row = await tx.userKey.findUniqueOrThrow({ where: { userId } });
  return unwrapDek(keyring, userId, row.wrappedDek);
}

export function encryptAccessToken(dk: DataKey, itemId: string, accessToken: string): Promise<string> {
  return encryptField(dk, ACCESS_TOKEN_FIELD(itemId), accessToken);
}

export function decryptAccessToken(dk: DataKey, itemId: string, ciphertext: string): Promise<string> {
  return decryptField(dk, ACCESS_TOKEN_FIELD(itemId), ciphertext);
}
