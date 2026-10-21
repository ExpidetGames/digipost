# Better Auth, magic link only, via the Drizzle adapter, rate limit through the handler

Document type: decision
Lifecycle: active
Owner: template maintainer
Scope: Identity, session, and sign-in mechanism; how Server Actions call into Better Auth
Canonical responsibility: Active source for the auth framework choice, its adapter, and
why rate-limited Server Actions must route through `getAuth().handler(request)`
Maintenance triggers:
- The auth framework or adapter changes
- A rate-limited Better Auth endpoint is called from a Server Action
Last verified: 2026-09-14 against WEBAPP_TEMPLATE_SPEC.md §6 and T3's
`platform/auth/**`, `platform/mailer/**`, `modules/sign-in/**`

## Status
Accepted

## Context

Self-hosted auth keeps identity, session, and mail entirely inside the app: no external
auth service, no dependency on a provider's user table. Better Auth provides this with a
first-party Drizzle adapter, so auth tables (`user`, `session`, `account`, `verification`,
a rate-limit table) live in the same schema, migration history, and database role as the
rest of the app, instead of a separate connection or ORM just for auth.

Magic link is the only sign-in method: no passwords to hash and no password-reset flow to
build and secure. A real project that used Better Auth's built-in rate limiting found it
only applies inside Better Auth's own HTTP router (`app/api/auth/[...all]`): a Server
Action that calls `auth.api.*` directly bypasses it entirely, and that gap let a login
form send an unlimited number of magic-link emails.

## Decision

1. `better-auth` with `drizzleAdapter(getAuthDb(), { provider: "pg", schema: authSchema })`
   is the only auth mechanism. `emailAndPassword` stays disabled; the `magicLink` plugin is
   the only sign-in method, with hashed token storage and a short expiry.
2. Auth tables live in `persistence/schema/auth.ts` (owner `platform/auth`), generated once
   with the Better Auth CLI and then maintained as a normal Drizzle schema file, merged
   into the same migration history as every other owner's tables.
3. Any Server Action that needs a rate-limited Better Auth endpoint (sign-in, and any
   future rate-limited endpoint) calls it through `getAuth().handler(request)`, built from
   a `Request` object constructed from the incoming request, so Better Auth's own router
   middleware (including its rate limiter) actually runs. Calling `auth.api.*` directly
   from a Server Action is never acceptable for a rate-limited endpoint.
4. Cookies are host-only (no cross-subdomain cookies), `Secure` in production,
   `SameSite=Lax` (a magic-link click is a cross-site navigation). Rate limiting is
   database-backed, not in-memory or Redis-backed, so it survives serverless cold starts
   and works correctly across multiple function instances.

## Consequences

- Positive: one database, one migration history, one role model covers auth and the rest
  of the app; magic-link-only sign-in removes an entire class of password-handling risk;
  routing rate-limited calls through the real handler closes the bypass a prior project
  hit in production.
- Negative: every rate-limited Server Action needs the extra `Request`-object plumbing
  instead of a direct `auth.api.*` call, which is easy to forget without a lint rule or
  test guarding it; magic-link-only sign-in means no offline/no-email sign-in path exists
  without adding a plugin later (see WEBAPP_TEMPLATE_SPEC.md §6.5 for optional extensions).
- Implementation status: **implemented** (T3). T1 installed `better-auth` as a dependency
  and reserved `BETTER_AUTH_SECRET` in `.env.example`. T2 added `persistence/schema/auth.ts`
  (the `user`/`session`/`account`/`verification`/`rateLimit` tables Better Auth's Drizzle
  adapter expects, migrated by `persistence/migrations/0000_faithful_maggott.sql`). T3 added
  `persistence/composition/auth-database.ts` (the narrow entry), `platform/auth` (`getAuth`,
  `getCurrentUser`, `requireUser`, `authRouteHandlers`, `proxy-gate.ts`'s DB-free
  `hasSessionCookie`), `platform/mailer` (the SMTP transport + `Mailer` port the magic-link
  mail is sent through), `modules/sign-in` (the login UI and its Server Actions, routing the
  rate-limited endpoint through `getAuth().handler(request)` per decision 3 above), and the
  seams (`app/(auth)/login/page.tsx`, `app/api/auth/[...all]/route.ts`, `proxy.ts`,
  `app/(app)/layout.tsx`, a minimal `app/(app)/dashboard/page.tsx`). Covered by
  `platform/auth/tests/*`, `modules/sign-in/tests/*` (unit) and `e2e/auth.spec.ts` (the full
  magic-link flow, signed-out redirects, sign-out, single-use links, the open-redirect guard,
  and the rate limit, against the Docker test stack's real Postgres and Mailpit).
