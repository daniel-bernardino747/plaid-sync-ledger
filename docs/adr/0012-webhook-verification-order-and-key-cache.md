# ADR 0012: Webhook verification order and verification-key cache

- Status: Accepted
- Date: 2026-10-08

## Context

Plaid signs webhooks with an ES256 JWT in the `Plaid-Verification` header. The
JWT header carries a `kid`. The public key is fetched with
`POST /webhook_verification_key/get { key_id }`, which returns a JWK and a
nullable `expired_at`. The payload carries `iat` and `request_body_sha256`.
Plaid's docs require rejecting webhooks older than 5 minutes and recommend a
constant-time hash comparison. The hash is computed over the exact body bytes:
Plaid's docs note it is whitespace-sensitive.

Plaid's official Node, Python, and Ruby examples cache a single key without
looking at `kid`, which breaks on key rotation.

If the Worker fetched a key for every unknown `kid` before any other check, an
attacker could send JWTs with random `kid`s and make the Worker call Plaid on
every request: unauthenticated amplification against our API quota.

## Decision

**Verification order: cheap checks first, network last.**

1. `Content-Length` at most 64 KB (`413`). `Plaid-Verification` present (`400`).
2. Decode the JWT header without verifying it: `alg` must be `ES256` and `kid`
   a bounded string (`400`).
3. Decode the payload without verifying it: `iat` within
   `[now - 5 min, now + 30 s]` (`400`). The 30 seconds absorb clock skew.
4. Resolve the key by `kid`: cache first, network second.
5. Verify the ES256 signature with WebCrypto (`401`).
6. Compare `sha256(raw body bytes)` with `request_body_sha256` in constant time
   (`401`). The JSON is parsed only after this step.
7. Persist and enqueue (ADR 0002), then return `200`.

Steps 2 and 3 run on untrusted data and are only cheap filters. The guarantee
comes from steps 5 and 6. `iat` is re-checked against the verified payload.

**Key cache.**

- An in-isolate `Map` keyed by `kid`. Isolates are reused, so the cost is one
  fetch per cold isolate per key.
- Negative caching: a `kid` that Plaid reports as unknown is cached as missing
  for 5 minutes. That closes the amplification path.
- `expired_at`: if it is non-null and the token's `iat` is later than
  `expired_at`, the webhook is rejected. Webhooks signed before expiry and
  delivered on retry remain valid. Plaid's docs do not specify this behavior.
  This rule is our interpretation and is labeled as such in the README.

## Consequences

- An attacker without a valid signature costs us at most one key fetch per
  distinct `kid` per 5 minutes per isolate.
- Every rejection path has a test: wrong `alg`, stale `iat`, future `iat`,
  unknown `kid` (fetched once, then served from the negative cache), bad
  signature, body altered by a single whitespace byte, and a key used after
  `expired_at`.
