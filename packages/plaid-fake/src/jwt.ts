import { createHash, generateKeyPairSync, sign, type JsonWebKey, type KeyObject } from "node:crypto";

export interface SigningKey {
  kid: string;
  privateKey: KeyObject;
  publicJwk: JsonWebKey;
  createdAt: number;
  expiredAt: number | null;
}

export function newSigningKey(kid: string, nowSeconds: number): SigningKey {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  return {
    kid,
    privateKey,
    publicJwk: { ...jwk, kid, alg: "ES256", use: "sig" } as JsonWebKey,
    createdAt: nowSeconds,
    expiredAt: null,
  };
}

const b64url = (buf: Buffer | string) => Buffer.from(buf).toString("base64url");

/**
 * Builds a Plaid-Verification JWT for a webhook body: ES256, `kid` in the
 * header, `iat` and `request_body_sha256` in the payload (Plaid's documented
 * scheme). The signature is raw r||s (ieee-p1363), as JWS requires.
 */
export function signWebhook(body: string, key: SigningKey, iat: number): string {
  const header = b64url(JSON.stringify({ alg: "ES256", kid: key.kid, typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({ iat, request_body_sha256: createHash("sha256").update(body, "utf8").digest("hex") }),
  );
  const signingInput = `${header}.${payload}`;
  const sig = sign("sha256", Buffer.from(signingInput), { key: key.privateKey, dsaEncoding: "ieee-p1363" });
  return `${signingInput}.${b64url(sig)}`;
}
