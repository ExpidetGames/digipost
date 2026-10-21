# src/modules/sign-in

Document type: reference
Lifecycle: active
Owner: src/modules/sign-in
Scope: The `/login` page's non-seam code - the login form, its magic-link Server
Action, sign-out, and open-redirect protection for the post-login target
Canonical responsibility: Everything `src/app/(auth)/login/page.tsx` delegates to
except the page shell itself
Maintenance triggers:
- The magic-link request flow or its error handling changes
- The login form's fields, copy keys, or client-side behavior change
- Better Auth's magic-link callback error codes change
Last verified: 2026-09-14, T3 (auth and mail)

## Purpose

Owns the sign-in UI (the email form, its pending/"check your inbox" states) and the
Server Action that requests a magic link. Per decisions/0005, `requestMagicLinkAction`
calls the rate-limited magic-link endpoint through `getAuth().handler(request)`
(built from the incoming request, forwarding `x-forwarded-for`), never
`getAuth().api.signInMagicLink(...)` directly - a prior project's login form bypassed
the rate limiter exactly that way. `safeNextPath` neutralizes an open-redirect
attempt in the `next=` query parameter carried through sign-in.

## Public interfaces

- `index.ts` (neutral): `safeNextPath` - `src/app/(auth)/login/page.tsx` needs it too
  (to sanitize `next` before redirecting an already-signed-in visitor and before
  handing it to `LoginForm`), not only `actions.ts`.
- `client.ts` (`"use client"`): `LoginForm`.
- `actions.ts` (`"use server"`): `requestMagicLinkAction`, `RequestMagicLinkState`
  (type), `signOutAction`.

## Structure

- `core/schemas.ts` - the email Zod schema (trim, lowercase, `z.email()`).
- `core/safe-next-path.ts` - `safeNextPath`, the open-redirect guard.
- `core/error-codes.ts` - stable `as const` error-code sets for both the request
  action's own errors and Better Auth's magic-link-verify callback errors, plus
  `resolveCallbackErrorCode` (never echoes an unrecognized query value back into
  the page).
- `actions.ts` - `requestMagicLinkAction`, `signOutAction`.
- `ui/login-form.tsx` - the client form component (imports `requestMagicLinkAction`
  from `../actions`, translates error codes via next-intl's `Login` namespace).
- `client.ts` - the public client entrypoint.
- `tests/` - unit tests.

## Dependencies on other owners

`@/platform/auth/server` (`getAuth`, used by `actions.ts` only - never imported by
`ui/login-form.tsx`), `@/platform/env/server` (`serverEnv`, for `APP_URL`),
`@/shared/ui-primitives` (form primitives).

## Consumers

`src/app/(auth)/login/page.tsx` (seam): `safeNextPath` (from `index.ts`) to sanitize
`searchParams.next`, `LoginForm` (from `client.ts`) to render the form, and
`getCurrentUser` (from `@/platform/auth/server`, not this module) to bounce an
already-signed-in visitor straight to `next`. `src/app/(app)/dashboard/page.tsx`:
`signOutAction` (from `actions.ts`).

## Tests

`tests/safe-next-path.test.ts` - every open-redirect shape this guard rejects
(absolute URL, `//`, `/\`, `javascript:`, control characters) plus the paths it
passes through unchanged. `tests/actions.test.ts` - `requestMagicLinkAction`'s
response-code mapping (`invalid_email`/`rate_limited`/`unknown`/`sent`), that it
calls `getAuth().handler(request)` (never `auth.api.signInMagicLink`) with a real
`Request` carrying the normalized email and the forwarded `x-forwarded-for` header,
and that an unsafe `next` value never reaches `callbackURL`; `signOutAction`'s
redirect. The full magic-link flow (a real sign-in mail, its rate limit, and
sign-out) is covered end to end by `tests/e2e/auth.spec.ts`.
