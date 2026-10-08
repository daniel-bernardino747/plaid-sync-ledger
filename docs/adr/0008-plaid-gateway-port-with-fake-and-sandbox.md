# ADR 0008: A Plaid gateway port, with a deterministic fake and the real Sandbox

- Status: Accepted
- Date: 2026-10-08

## Context

The chaos suite must prove that the final ledger is identical to a clean run
under injected failures. Plaid Sandbox cannot serve as the only backend:

- It cannot inject `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION` on a chosen
  page, a `500`, or a timeout.
- It is not deterministic (dates are relative to today), so a reference ledger
  hash would drift between runs.
- `/sandbox/transactions/create` adds at most 10 transactions per call, which
  makes multi-page scenarios awkward.

Sandbox is still the only real evidence that the code matches Plaid's
contract, and the only way to exercise Link, the token exchange, and
`/sandbox/item/reset_login` end to end.

## Decision

**A port in `packages/plaid`.** The rest of the system depends only on a
domain-shaped interface:

```ts
interface PlaidGateway {
  exchangePublicToken(publicToken: string): Promise<{ itemId: string; accessToken: string }>;
  syncTransactions(input: { accessToken: string; cursor: string | null; count: number }): Promise<SyncPage>;
  getItem(accessToken: string): Promise<ItemStatus>;
  getWebhookVerificationKey(kid: string): Promise<JsonWebKey & { expiredAt: number | null }>;
}
```

Failures are a typed union rather than raw HTTP errors:
`MutationDuringPagination | ItemLoginRequired | RateLimited | Transient (5xx,
timeout, network) | Fatal`. The sync engine and the retry policy make
decisions only on this union. This is where Plaid's error codes are mapped,
in a single place.

**One HTTP adapter, two backends.** The adapter is a small hand-written
`fetch` client (it runs in Node and in the Workers runtime), with response
validation and an explicit per-request timeout via `AbortSignal.timeout`.
Switching backends is configuration only:

- `PLAID_BASE_URL=https://sandbox.plaid.com` for the real Sandbox;
- `PLAID_BASE_URL=http://localhost:<port>` for `packages/plaid-fake`.

The official `plaid` SDK is not used. It would hide the error classification
and timeout behavior this project exists to demonstrate.

An in-memory implementation of `PlaidGateway` is not added. Unit tests use the
fake over HTTP, so the adapter is always exercised.

**`packages/plaid-fake`.** An HTTP server implementing the endpoints above
with Plaid's request and response shapes:

- a seeded, deterministic dataset spanning several pages, including pending to
  posted transitions (`pending_transaction_id`), `modified`, and `removed`;
- webhooks signed with a real ES256 key and a `request_body_sha256` claim, so
  the Worker's verification runs unmodified;
- fault injection through a control endpoint, for example
  `POST /__chaos { "mutationOnPage": 2, "fail500Rate": 0.3, "timeoutMs": 15000 }`.

**One contract suite, two targets.** The same tests (response shape,
pagination until `has_more = false`, cursor semantics, error codes) run
against both backends:

- `pnpm test:contract` runs against the fake, in the default `pnpm test`;
- `pnpm test:contract:sandbox` runs against Plaid Sandbox. It needs
  `PLAID_CLIENT_ID` and `PLAID_SECRET` plus network access, and is excluded
  from the default run.

## Consequences

- `pnpm chaos` runs against the fake. That is deterministic and supports
  fault injection. The contract suite keeps the fake honest.
- Any divergence found between Sandbox and the fake is fixed in the fake and
  recorded in the README's "Where the AI got it wrong" log if the assistant
  introduced it.
- Plaid features we do not use (accounts beyond sync, other products) are not
  faked.
