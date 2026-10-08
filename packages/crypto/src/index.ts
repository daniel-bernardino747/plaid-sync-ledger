/**
 * Envelope encryption with AES-256-GCM (ADR 0006).
 *
 *   master key (env, versioned)  --wraps-->  per-user DEK  --encrypts-->  field
 *
 * Ciphertext format, one text column: v1.<keyVersion>.<iv>.<ciphertext>.<tag>
 * (base64url segments). For a wrapped DEK, keyVersion is the master key
 * version. For a field, it is the DEK version (always 1 until DEK rotation,
 * which is out of scope, exists).
 *
 * Every ciphertext is bound to its context through AES-GCM additional
 * authenticated data, so a ciphertext copied to another row, column or user
 * fails to decrypt instead of silently decrypting under the wrong owner.
 *
 * Uses WebCrypto only, so the same code runs in Node and in Workers.
 */

// Derived from the runtime's own WebCrypto so the same file typechecks under
// Node types, DOM types (Next.js) and Workers types.
type CryptoKey = Awaited<ReturnType<typeof globalThis.crypto.subtle.importKey>>;
/** ArrayBuffer-backed bytes, which is what WebCrypto accepts. */
type Bytes = Uint8Array<ArrayBuffer>;

const FORMAT = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const subtle = globalThis.crypto.subtle;
const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder("utf-8", { fatal: true });

/** Deliberately carries no detail: callers must not learn why decryption failed. */
export class DecryptionError extends Error {
  constructor() {
    super("decryption failed");
    this.name = "DecryptionError";
  }
}

export class Keyring {
  readonly current: number;
  readonly #keys: Map<number, CryptoKey>;

  private constructor(current: number, keys: Map<number, CryptoKey>) {
    this.current = current;
    this.#keys = keys;
  }

  /**
   * MASTER_KEYS='{"1":"<base64 32 bytes>","2":"..."}', MASTER_KEY_CURRENT=2.
   * Reads accept every version present. Writes always use the current one.
   */
  static async fromEnv(env: { MASTER_KEYS?: string | undefined; MASTER_KEY_CURRENT?: string | undefined }): Promise<Keyring> {
    if (!env.MASTER_KEYS || !env.MASTER_KEY_CURRENT) throw new Error("MASTER_KEYS and MASTER_KEY_CURRENT are required");
    const raw = JSON.parse(env.MASTER_KEYS) as Record<string, string>;
    const keys = new Map<number, CryptoKey>();
    for (const [version, b64] of Object.entries(raw)) {
      const bytes = fromBase64(b64);
      if (bytes.length !== 32) throw new Error(`master key version ${version} must be 32 bytes`);
      keys.set(Number(version), await importAesKey(bytes));
    }
    const current = Number(env.MASTER_KEY_CURRENT);
    if (!keys.has(current)) throw new Error("MASTER_KEY_CURRENT is not in MASTER_KEYS");
    return new Keyring(current, keys);
  }

  has(version: number): boolean {
    return this.#keys.has(version);
  }

  get(version: number): CryptoKey {
    const k = this.#keys.get(version);
    if (!k) throw new DecryptionError();
    return k;
  }
}

export interface Envelope {
  keyVersion: number;
  iv: Bytes;
  ciphertext: Bytes;
  tag: Bytes;
}

export function parseEnvelope(value: string): Envelope {
  const parts = value.split(".");
  if (parts.length !== 5 || parts[0] !== FORMAT) throw new DecryptionError();
  const keyVersion = Number(parts[1]);
  if (!Number.isInteger(keyVersion) || keyVersion < 1) throw new DecryptionError();
  return {
    keyVersion,
    iv: fromBase64Url(parts[2]!),
    ciphertext: fromBase64Url(parts[3]!),
    tag: fromBase64Url(parts[4]!),
  };
}

/** Version of the key that produced this ciphertext, without decrypting it. */
export function keyVersionOf(value: string): number {
  return parseEnvelope(value).keyVersion;
}

async function seal(key: CryptoKey, keyVersion: number, aad: string, plaintext: Bytes): Promise<string> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const out = new Uint8Array(
    await subtle.encrypt({ name: "AES-GCM", iv, additionalData: utf8.encode(aad), tagLength: 128 }, key, plaintext),
  );
  const ct = out.subarray(0, out.length - TAG_BYTES);
  const tag = out.subarray(out.length - TAG_BYTES);
  return [FORMAT, String(keyVersion), toBase64Url(iv), toBase64Url(ct), toBase64Url(tag)].join(".");
}

async function open(key: CryptoKey, aad: string, env: Envelope): Promise<Bytes> {
  const joined = new Uint8Array(env.ciphertext.length + env.tag.length);
  joined.set(env.ciphertext);
  joined.set(env.tag, env.ciphertext.length);
  try {
    return new Uint8Array(
      await subtle.decrypt({ name: "AES-GCM", iv: env.iv, additionalData: utf8.encode(aad), tagLength: 128 }, key, joined),
    );
  } catch {
    throw new DecryptionError();
  }
}

// ------------------------------------------------------------------ DEKs

const DEK_VERSION = 1;
const dekAad = (userId: string) => `user_keys:${userId}`;

export function generateDek(): Bytes {
  return globalThis.crypto.getRandomValues(new Uint8Array(32));
}

export async function wrapDek(keyring: Keyring, userId: string, dek: Bytes, version = keyring.current): Promise<string> {
  return seal(keyring.get(version), version, dekAad(userId), dek);
}

export async function unwrapDek(keyring: Keyring, userId: string, wrapped: string): Promise<DataKey> {
  const env = parseEnvelope(wrapped);
  const raw = await open(keyring.get(env.keyVersion), dekAad(userId), env);
  return { userId, key: await importAesKey(raw) };
}

/**
 * Re-wraps a DEK under another master key version. The DEK itself does not
 * change, so no field ciphertext has to be touched (ADR 0006).
 */
export async function rewrapDek(keyring: Keyring, userId: string, wrapped: string, toVersion: number): Promise<string> {
  const env = parseEnvelope(wrapped);
  const raw = await open(keyring.get(env.keyVersion), dekAad(userId), env);
  try {
    return await wrapDek(keyring, userId, raw, toVersion);
  } finally {
    raw.fill(0);
  }
}

// ------------------------------------------------------------------ fields

/** An unwrapped DEK. Bound to the user it belongs to, so AAD cannot drift. */
export interface DataKey {
  readonly userId: string;
  readonly key: CryptoKey;
}

export interface FieldContext {
  table: string;
  column: string;
  rowId: string;
}

const fieldAad = (dk: DataKey, ctx: FieldContext) => `${ctx.table}.${ctx.column}:${ctx.rowId}:${dk.userId}`;

export async function encryptField(dk: DataKey, ctx: FieldContext, plaintext: string): Promise<string> {
  return seal(dk.key, DEK_VERSION, fieldAad(dk, ctx), utf8.encode(plaintext));
}

export async function decryptField(dk: DataKey, ctx: FieldContext, value: string): Promise<string> {
  const env = parseEnvelope(value);
  if (env.keyVersion !== DEK_VERSION) throw new DecryptionError();
  const bytes = await open(dk.key, fieldAad(dk, ctx), env);
  try {
    return fromUtf8.decode(bytes);
  } catch {
    throw new DecryptionError();
  }
}

// ------------------------------------------------------------------ utils

async function importAesKey(raw: Bytes): Promise<CryptoKey> {
  return subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

function toBase64Url(bytes: Bytes): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): Bytes {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new DecryptionError();
  return fromBase64(s.replace(/-/g, "+").replace(/_/g, "/"));
}

function fromBase64(s: string): Bytes {
  const bin = atob(s.padEnd(Math.ceil(s.length / 4) * 4, "="));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 32 random bytes, base64, for a new MASTER_KEYS entry. */
export function newMasterKey(): string {
  let s = "";
  for (const b of globalThis.crypto.getRandomValues(new Uint8Array(32))) s += String.fromCharCode(b);
  return btoa(s);
}
