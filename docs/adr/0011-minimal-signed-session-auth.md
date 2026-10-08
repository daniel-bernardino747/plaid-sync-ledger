# ADR 0011: Minimal signed-cookie session instead of an auth library

- Status: Accepted
- Date: 2026-10-08

## Context

Row-level security (ADR 0007) needs a trustworthy `user_id` on every web
request. Authentication itself is not what this project demonstrates. Spending
the weekend on an identity provider would buy nothing the reviewer is looking
for, and an auth library would hide the trust boundary.

## Decision

- **Users.** Two seeded demo users (Alice and Bob). "Log in" picks one from a
  list, with no password. Two users make RLS demonstrable live: as Alice, Bob's
  data is invisible even with application filters removed.
- **Session cookie.** It holds `user_id` and `exp`, signed with HMAC-SHA256
  under `SESSION_SECRET`. Attributes: `HttpOnly`, `Secure` (except on
  localhost), `SameSite=Lax`, `Path=/`. The signature is compared in constant
  time. An expired or tampered cookie is treated as logged out.
- **Single entry point.** `requireUser()` validates the cookie and is the only
  way to obtain `db.forUser(userId)` (ADR 0007). Route handlers cannot reach
  the user-scoped client without passing through it.
- **CSRF.** Every state-changing route (public token exchange, update-mode
  completion, logout) requires `POST` and rejects requests whose `Origin`
  header does not match the app's origin.

## Consequences

- About 60 lines of code with no dependency, and the trust boundary is
  explicit and reviewable.
- Tests: a tampered cookie, an expired cookie, and a cross-origin `POST` are
  all rejected.
- Out of scope, as stated in the README: real identity (passwords, OAuth,
  passkeys), session revocation lists, and multi-device session management.
