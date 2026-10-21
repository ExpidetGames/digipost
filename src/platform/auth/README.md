# src/platform/auth

Document type: reference
Lifecycle: active
Owner: src/platform/auth
Scope: Better Auth (self-hosted, magic link), session lookup, the proxy's
cookie-presence gate, and the magic-link e-mail template
Canonical responsibility: The one Better Auth instance (`getAuth`) and the one
`getCurrentUser`/`requireUser`
Maintenance triggers:
- Better Auth config changes (plugins, rate limits, cookie/session policy)
- The magic-link e-mail copy changes
- A new rate-limited Better Auth endpoint needs a Server Action caller
  (decisions/0005: it MUST go through `getAuth().handler(request)`, never `auth.api.*`)
- The IP header trust order (`ipAddressHeaders`) or the hosting/proxy setup changes
Last verified: 2026-10-21, decisions/0074-sign-up-by-invitation-only.md: new accounts only for
an invited address or one of `AUTH_BOOTSTRAP_EMAILS` (`server/sign-up-gate.ts`, checked in
`sendMagicLink` and in the user-create database hook). Previously 2026-09-20, P6 review: hardened the IP header trust order (see "IP address
trust" below); decisions/0005-better-auth-magic-link-drizzle-adapter.md is Accepted and
immutable and did not originally specify this detail, so it is recorded here instead

## Purpose

Self-hosted Better Auth, magic-link only (WEBAPP_TEMPLATE_SPEC.md §6,
decisions/0005-better-auth-magic-link-drizzle-adapter.md): the token is stored
hashed, mailed via `src/platform/mailer` and the template in `server/emails/`, never by
a third party. Rate limiting is database-backed (shared across serverless
instances). Cookies stay host-only and `Secure` in production.

Sign-up is by invitation only (decisions/0074-sign-up-by-invitation-only.md): an existing
account gets its link, a new account is created only for an address with a pending,
unexpired invitation or one listed in `AUTH_BOOTSTRAP_EMAILS` (the first admin of a fresh
database). Anyone else gets the usual answer and no mail; the user-create hook throws
`SIGNUP_NOT_ALLOWED` as the hard guarantee.

Identity and session are all this owner manages. Tenants, memberships, roles and
permissions are separate tables and use cases under `src/platform/access` (once a
project needs them, WEBAPP_TEMPLATE_SPEC.md §6.6) - a framework swap stays a change
in `src/platform/auth` + `src/persistence/schema/auth.ts`, not the whole product.

## Public interfaces

`server.ts` (`import "server-only"`, never imported from client-reachable code):
`getAuth`, `MAGIC_LINK_EXPIRES_IN_SECONDS`, `getCurrentUser`, `requireUser`,
`CurrentUser`, `authRouteHandlers`.

`proxy-gate.ts` (no `server-only`, no DB/network) - the one further subpath besides
`server.ts` (WEBAPP_TEMPLATE_SPEC.md §4.2), imported only by the root `src/proxy.ts`:

- `hasSessionCookie(request)` - cookie presence only (`better-auth/cookies`), never
  validity. `src/proxy.ts`'s matcher covers `/dashboard/:path*`; a request without the
  cookie is redirected to `/login?next=…` before anything from `src/platform/auth/server/**`
  (or `src/persistence/**`) loads.
- `CURRENT_PATH_HEADER` - the request header `src/proxy.ts` sets to the current path on
  every request it lets through, so `requireUser()` can rebuild `next=` for the
  rare case where the cookie was present but the session turns out to be invalid.

## Structure

- `server/auth.ts` - the Better Auth instance (`getAuth`, lazy), `sendMagicLink`.
- `server/session.ts` - `getCurrentUser` (`react cache`, `unstable_rethrow`, null on
  error), `requireUser` (redirect-on-signed-out).
- `server/route-handlers.ts` - `authRouteHandlers`, the `toNextJsHandler(getAuth())`
  wrapper `src/app/api/auth/[...all]/route.ts` delegates to.
- `server/emails/magic-link-email.tsx` - the magic-link e-mail (React Email
  component + `renderMagicLinkEmail`, via `src/platform/mailer/server`'s `renderEmail`).
- `proxy-gate.ts` - the DB-free subpath for `src/proxy.ts`.
- `server.ts` - the public, privileged entrypoint.
- `tests/` - unit tests (env-boundary and session-lookup only; see below).

## Why rate-limited calls go through `getAuth().handler(request)`

Better Auth applies its configured rate limits (the magic-link sign-in rule above)
only inside its own HTTP router (`auth.handler(request)`, the code path
`src/app/api/auth/[...all]/route.ts` and `getAuth().handler(...)` both run). A call to
`auth.api.signInMagicLink(...)` directly is an in-process call that never goes
through that router and therefore never hits the rate limiter - a real project hit
exactly this: its login form called `auth.api.*` directly and let unlimited
magic-link mail through (decisions/0005). `src/modules/sign-in/actions.ts`'s
`requestMagicLinkAction` builds a `Request` from the incoming Server Action request
(forwarding `x-forwarded-for` so the limiter's IP key is correct) and calls
`getAuth().handler(request)`, so the real router - and its rate limiter - runs.
Better Auth's `nextCookies()` plugin still sets the resulting session cookie
correctly through this path (it hooks `ctx.context.responseHeaders` after every
request, not only ones made through a literal HTTP round trip), so this is not a
trade-off against normal cookie behavior. `signOutAction` is not rate-limited, so it
calls `getAuth().api.signOut(...)` directly, same as `getCurrentUser` calls
`getAuth().api.getSession(...)` directly.

## IP address trust

The magic-link sign-in rate limit (`MAGIC_LINK_RATE_LIMIT`, decisions/0005) is keyed by
the caller's IP address, resolved by Better Auth's `advanced.ipAddress.ipAddressHeaders`
(`server/auth.ts`): `["x-vercel-forwarded-for", "x-real-ip", "x-forwarded-for"]`, checked
in that order, first present value wins (`@better-auth/core`'s `getIP`). This order is a
trust ranking, not an arbitrary preference:

- `x-vercel-forwarded-for` is set by Vercel's own edge network and cannot be overridden by
  a client request when the app runs on Vercel - the most trustworthy option available.
- `x-real-ip` is a common second header set by other reverse proxies (nginx and similar) in
  front of a non-Vercel deployment.
- `x-forwarded-for` is the least trustworthy of the three: it is set (or passed through
  unchanged) by nearly any proxy, and on a deployment that is ever reachable *without* a
  trusted proxy in front of it, a client can set this header directly on its own request.
  It stays last, as the final fallback, for local development and any deployment target
  that only forwards this header.

**Residual risk**: if this application is ever deployed reachable directly from the
internet with no trusted reverse proxy in front of it at all (no Vercel edge, no nginx/
similar setting `x-real-ip`), a client's `x-forwarded-for` value is taken at face value and
can be forged, letting an attacker split their own magic-link requests across arbitrarily
many rate-limit buckets. This is inherent to header-based IP resolution and is not fully
closeable without deployment-level knowledge (Better Auth's `advanced.ipAddress.trustedProxies`
option exists for exactly this if a project ever needs to state its trusted proxy CIDR
ranges explicitly) - flagged here rather than solved, since this template does not know a
project's final hosting topology in advance.

`src/modules/sign-in/actions.ts`'s `requestMagicLinkAction` builds a brand new `Request` to
call `getAuth().handler(request)` with (see "Why rate-limited calls go through
`getAuth().handler(request)`" above) - it forwards all three headers, in this same order,
from the incoming Server Action request; a header configured here but not forwarded there
would be invisible to the rate limiter no matter how trustworthy it is.

## Consumers

`src/app/api/auth/[...all]/route.ts` (`authRouteHandlers`); `src/app/(app)/layout.tsx`,
`src/app/(app)/dashboard/page.tsx` (`requireUser`); `src/app/(auth)/login/page.tsx`
(`getCurrentUser`, to bounce an already-signed-in visitor to `/dashboard`);
`src/modules/sign-in/actions.ts` (`getAuth`); `src/proxy.ts` (`hasSessionCookie`,
`CURRENT_PATH_HEADER`, via `proxy-gate.ts` only).

## Tests

`tests/auth.test.ts` - `getAuth()`'s env validation throws before any database
connection is attempted (an invalid `BETTER_AUTH_SECRET`/`APP_URL`/`SMTP_URL`).
`tests/session.test.ts` - `getCurrentUser`/`requireUser` against a mocked
`../server/auth` (no real Better Auth instance, no DB). The happy path (a real
magic-link sign-in, session validation, sign-out) is exercised end to end by
`tests/e2e/auth.spec.ts` against the Docker test stack's real Postgres and Mailpit - this
owner's core behavior is fundamentally database code, which
`scripts/test/unit-guard.ts` deliberately keeps out of the unit project
(WEBAPP_TEMPLATE_SPEC.md §10.2).
