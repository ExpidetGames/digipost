# Sentry's root-level config files read `process.env` directly, bypassing `platform/env`

Document type: decision
Lifecycle: active
Owner: platform/observability
Scope: Which files may read `SENTRY_DSN`/`NEXT_PUBLIC_SENTRY_DSN` directly from
`process.env` instead of through `platform/env`'s `serverEnv()`
Canonical responsibility: Active source for this one exception to
WEBAPP_TEMPLATE_SPEC.md §9's "`platform/env` is the only reader of `process.env`
in app code" (`env-access`) rule
Maintenance triggers:
- `WEBAPP_TEMPLATE_SPEC.md` §9's `env-access` exemption list changes
- The Sentry SDK's file-convention requirements change (fewer/more root-level
  config files)
Last verified: 2026-09-14, T5 (API pipeline, health, cron example, observability)

## Status
Accepted

## Context

`WEBAPP_TEMPLATE_SPEC.md` §9 makes `platform/env` the only reader of `process.env`
in application code, with a named exemption list: `next.config.ts`,
`drizzle.config.ts`, `instrumentation*.ts`, `scripts/**`, and test configuration.
`platform/env/server/env.ts`'s `ServerEnv` schema already includes `SENTRY_DSN` as
an optional field, read through `serverEnv()` everywhere else in the app.

`@sentry/nextjs` 10.x requires `Sentry.init()` calls to live in specific root-level
files by Next.js/Sentry file convention: `sentry.server.config.ts`,
`sentry.edge.config.ts` (both dynamically imported from `instrumentation.ts`'s
`register()`), and `instrumentation-client.ts` (the browser entrypoint, which reads
`NEXT_PUBLIC_SENTRY_DSN`, mirrored from `SENTRY_DSN` by `next.config.ts`'s `env`
block since Sentry's browser bundle needs the DSN inlined at build time). None of
these three files is literally named `instrumentation.ts`, so the exemption list's
text does not cover them, even though they exist only because `instrumentation.ts`
delegates to them.

Two options were considered for reading the DSN in these three files:

1. Route through `serverEnv()`, keeping the exemption list unchanged.
2. Read `process.env.SENTRY_DSN`/`process.env.NEXT_PUBLIC_SENTRY_DSN` directly,
   extending the exemption in practice.

Option 1 has a real cost: `serverEnv()` validates the *entire* `ServerEnv` schema
on first call, including fields unrelated to Sentry (`DATABASE_URL`,
`BETTER_AUTH_SECRET`, `SMTP_URL`, `MAIL_FROM`, `CRON_SECRET`). `sentry.edge.config.ts`
runs in the edge runtime, where pulling in the full server env schema (and the
`server-only` import chain that comes with `platform/env/server`) is disproportionate
to "read one optional string" and couples Sentry's own no-op-without-a-DSN
guarantee to every other required variable being valid too - a project with a
misconfigured, unrelated env var would then fail to even no-op Sentry correctly.
`instrumentation-client.ts` runs in the browser, where `platform/env/server` cannot
be imported at all (it is `server-only`); only the public `NEXT_PUBLIC_SENTRY_DSN`,
read the same way `next.config.ts` itself already reads `SENTRY_DSN` and
`SENTRY_AUTH_TOKEN` directly (already exempted), is available there.

## Decision

`sentry.server.config.ts`, `sentry.edge.config.ts`, and `instrumentation-client.ts`
read `process.env.SENTRY_DSN` / `process.env.NEXT_PUBLIC_SENTRY_DSN` directly, the
same way `instrumentation.ts` itself reads `process.env.SENTRY_DSN` in its
`onRequestError`. This extends `WEBAPP_TEMPLATE_SPEC.md` §9's `env-access` exemption
list in practice to cover the whole Next.js/Sentry instrumentation file family, not
only the file literally named `instrumentation.ts`. `SENTRY_DSN` stays a field in
`platform/env`'s `ServerEnv` (documented, validated when the rest of the app reads
it through `serverEnv()`); this decision only concerns these three Sentry-specific,
root-level files that cannot use that path without disproportionate cost.

## Consequences

- Positive: `sentry.edge.config.ts` and `instrumentation-client.ts` stay minimal
  and independently correct - a DSN-related failure there is never masked or
  caused by an unrelated required env var, and the browser file never attempts to
  import server-only code.
- Positive: consistent with how `next.config.ts` (already exempted) mirrors
  `SENTRY_DSN` into `NEXT_PUBLIC_SENTRY_DSN` directly via its `env` block, and with
  how `instrumentation.ts` itself already reads `SENTRY_DSN` for `onRequestError`.
- Negative: `platform/env`'s claim to be "the only reader of `process.env`" is not
  literally true; a future structure checker's `env-access` rule
  (WEBAPP_TEMPLATE_SPEC.md §11.5) must special-case these three files by name, the
  same way it must already special-case `next.config.ts`, `drizzle.config.ts`, and
  `instrumentation*.ts`.
- Implementation status: **already true today** (T5). No structure checker exists
  yet to enforce or special-case this; when one is built, its `env-access` rule's
  exemption list should read this ADR.
