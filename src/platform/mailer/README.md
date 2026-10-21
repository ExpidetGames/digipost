# src/platform/mailer

Document type: reference
Lifecycle: active
Owner: src/platform/mailer
Scope: SMTP transport, the `Mailer` port, and the React Email render helper
Canonical responsibility: The one nodemailer transport (`nodemailer` must not be
imported anywhere else) and the one `Mailer` interface use cases and `src/platform/auth`
depend on
Maintenance triggers:
- `SMTP_URL`/`MAIL_FROM` validation changes (`src/platform/env/server/env.ts`)
- The `Mailer` port's shape changes
Last verified: 2026-09-14, T3 (auth and mail)

## Purpose

Provider-neutral mail sending (WEBAPP_TEMPLATE_SPEC.md §2.6): `nodemailer` talks SMTP,
so Resend, Postmark, SES, Mailgun or a local Mailpit container are all interchangeable
by changing `SMTP_URL`. Templates are React Email components, rendered to both an HTML
and a plain-text part.

## Public interfaces

`server.ts` (`import "server-only"`, never imported from client-reachable code):

- `createSmtpMailer(): Mailer` - the real, SMTP-backed implementation.
- `Mailer` - the port interface (`send(message): Promise<void>`) callers depend on.
  `src/platform/auth/server/emails/magic-link-email.tsx` takes a `Mailer` as a parameter
  rather than importing `createSmtpMailer` itself, so a future use case's test can
  inject `src/platform/mailer/tests/support/fake-mailer.ts` instead of mocking
  nodemailer.
- `renderEmail(element: ReactElement): Promise<{ html: string; text: string }>` -
  renders a React Email component to both parts (`@react-email/render`).
- `getMailTransport()` / `resetMailTransportForTests()` - the memoized nodemailer
  transport (`globalThis`-cached like `src/persistence/foundation/client.ts`, so Next's
  dev-server HMR does not leak sockets) and its test hook.

## Structure

- `server/transport.ts` - the one `nodemailer.createTransport(serverEnv().SMTP_URL)`
  call in the codebase.
- `server/mailer.ts` - the `Mailer` port and `createSmtpMailer`.
- `server/render-email.ts` - the React Email render helper.
- `server.ts` - the public, privileged entrypoint.
- `tests/` - unit tests; `tests/support/fake-mailer.ts` - the typed fake other
  owners' unit tests use instead of mocking this module.

## Consumers

`src/platform/auth/server/auth.ts`'s `sendMagicLink` (`createSmtpMailer`, via
`src/platform/auth/server/emails/magic-link-email.tsx`'s `renderMagicLinkEmail`, which
calls `renderEmail`).

## Tests

`tests/render-email.test.tsx` (a real React Email element renders to both parts),
`tests/fake-mailer.test.ts` (the fake collects sent messages in order). No dedicated
unit test for `server/transport.ts`/`createSmtpMailer`'s SMTP call itself: it is
exercised end to end by `tests/e2e/auth.spec.ts`'s magic-link flow against the local
Mailpit container.
