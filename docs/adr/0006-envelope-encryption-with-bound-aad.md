# ADR 0006: Envelope encryption with context-bound AAD and DEK-only rotation

- Status: Accepted
- Date: 2026-10-08

## Context

Plaid `access_token`s grant ongoing read access to a user's bank data and must
never be stored in plaintext. The master key comes from an environment
variable, simulating a KMS. Rotating it must not require downtime.

Plain envelope encryption leaves one gap: ciphertext swapping. An attacker
with write access to the database could copy user A's `access_token`
ciphertext onto user B's Item. Decryption would succeed and B would sync A's
bank.

## Decision

**Algorithm.** AES-256-GCM, 96-bit random IV per encryption, via WebCrypto /
`node:crypto`. No third-party crypto library.

**Key hierarchy.**

- Master keyring from the environment: `MASTER_KEYS` (a JSON map from version
  to base64 key) and `MASTER_KEY_CURRENT` (a version). Reads accept any version
  present in the ring. Writes always use the current version.
- One data encryption key (DEK) per user, stored in
  `user_keys(user_id, wrapped_dek, master_key_version)`. The DEK is wrapped
  with AES-GCM under the master key, with AAD `user_keys:<user_id>`.

**Ciphertext format.** A single `text` column:
`v1.<master_key_version>.<iv>.<ciphertext>.<tag>` (base64url segments). The
leading `v1` is the format version.

**AAD binding.** Field ciphertexts use AAD
`<table>.<column>:<row_id>:<user_id>`. A ciphertext copied to another row,
column, or user fails authentication. A test proves this.

**Scope.**

| Data | Treatment |
| --- | --- |
| `access_token` | Encrypted as above. |
| `public_token` | Never persisted. It is exchanged server-side and discarded. |
| Transaction data (amount, name, merchant) | Plaintext, protected by per-user scoping. Encrypting it would defeat indexing and querying. The PII control here is access scope, not cryptography. |
| Logs | No tokens, no PII. Enforced by a redacting logger and a test that greps captured log output for known token and PII values. |

**Master key rotation (no downtime).**

1. Add the new version to `MASTER_KEYS` and make it `MASTER_KEY_CURRENT`.
   Deploy. New DEKs are wrapped with it, and old ones still unwrap.
2. Run `pnpm rotate-master-key`. It re-wraps DEKs in batches with
   `UPDATE user_keys SET wrapped_dek = $new, master_key_version = $to
   WHERE user_id = $id AND master_key_version = $from`. The compare-and-set
   on the version makes it safe against concurrent writers and re-runs.
3. When `count(*) WHERE master_key_version = $from` is 0, remove the old
   version from the ring.

Data ciphertexts are never re-encrypted, because the DEK does not change.

## Consequences

- Rotation cost is one row per user, not per token.
- A leaked database dump without the master keyring is useless. A leaked
  keyring without the dump is useless.
- Out of scope, and documented as such: DEK rotation (needed if a single
  user's DEK is suspected compromised, which requires re-encrypting that
  user's fields), and a real KMS with per-request audit.
