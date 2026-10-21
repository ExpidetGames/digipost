# src/platform/observability

Document type: reference
Lifecycle: active
Owner: src/platform/observability
Scope: Sentry (`@sentry/nextjs`) error and performance monitoring - server, edge,
and browser
Canonical responsibility: The one place that decides what `Sentry.init()` runs
with, and the proof that Sentry adds zero instrumentation when no DSN is
configured
Maintenance triggers:
- The Sentry SDK major version changes (its file conventions have changed before,
  see `sentry.*.config.ts`'s docstrings)
- The sample rate, PII policy, or which runtimes report to Sentry changes
- `SENTRY_DSN`/`SENTRY_AUTH_TOKEN`/`NEXT_PUBLIC_SENTRY_DSN` naming changes
- A new URL path carries a secret/token (like `/invite/<token>`) and needs the same
  redaction treatment
Last verified: 2026-09-20, P7 (D3, real-API defect fixes): added `server.ts`/`server/capture-error.ts`'s
`captureError` - a background job failure (`src/persistence/use-cases/jobs-use-cases.ts`)
never crosses a Next.js request boundary, so `src/instrumentation.ts`'s `onRequestError`
never sees it; without an explicit call like this one it would never reach Sentry no matter
how `SENTRY_DSN` is configured. P6 review: added `beforeSend`/`beforeBreadcrumb` invite-token
redaction (decisions/0018-invite-token-sentry-scrubbing.md)

## Purpose

Sentry via `@sentry/nextjs` (WEBAPP_TEMPLATE_SPEC.md §2.6: "Template, abschaltbar
per Env"). Off everywhere by default: no `SENTRY_DSN` in `.env.example`, CI, the
Docker test stack, or local dev; on only where an operator sets `SENTRY_DSN` (a
real deployment's environment variables).

`@sentry/nextjs` 10.x still needs its `Sentry.init()` calls to live in specific,
Next.js-convention file *locations* that cannot move into
`src/platform/observability/**`: `src/instrumentation.ts` and `src/instrumentation-client.ts`
directly under `src/` (Next's own file conventions), plus `src/sentry.server.config.ts` /
`src/sentry.edge.config.ts` beside them (dynamically imported from
`src/instrumentation.ts`'s `register()` - the SDK has not consolidated these into
`src/instrumentation.ts` itself as of 10.x). `src/platform/observability` owns everything
those files delegate to: what options `Sentry.init()` gets, and the logic that
makes "no DSN" a true no-op.

## Public interfaces

- `index.ts` (neutral, no `server-only`, no `"use client"`): `sentryInitOptions`,
  `SentryInitOptions`, `redactInviteTokenFromUrl` (from `core/init-options.ts`).
- `server.ts` (privileged, `import "server-only"`): `captureError(error, context?)` - reports
  an error to Sentry via `Sentry.captureException`, a no-op without `SENTRY_DSN` configured
  (same gate as `sentry.*.config.ts`). For server-side code with no Next.js request boundary
  of its own to let `instrumentation.ts`'s `onRequestError` pick up automatically - today,
  only `src/persistence/use-cases/jobs-use-cases.ts`'s terminal job failures (D3). `context`
  becomes the Sentry event's `extra` data: callers pass only small, already-stable
  identifiers/codes, never document content, personal data, or a credential.

## Structure

- `core/init-options.ts` - pure functions, no SDK import: `sentryInitOptions(dsn)`
  returns `undefined` for an unset/blank DSN (every caller must then skip
  `Sentry.init` entirely, not just pass an empty `dsn` - Sentry's own guidance for a
  true no-op with zero instrumentation overhead, not just zero network traffic), or
  the shared options object (`sendDefaultPii: false`, `tracesSampleRate: 0.2`, plus
  `beforeSend`/`beforeBreadcrumb`) otherwise. `redactInviteTokenFromUrl` (decisions/0018-invite-token-sentry-scrubbing.md):
  replaces any `/invite/<token>` path segment in a URL string with a redacted
  placeholder before `beforeSend`/`beforeBreadcrumb` ever hand an event/breadcrumb to
  Sentry - `src/modules/workspaces`'s invitation token (decisions/0014) travels in the
  URL path, which Sentry's default instrumentation would otherwise capture verbatim.
  This redaction only covers what this application's own Sentry instrumentation
  reports - it does not (and cannot) redact hosting/CDN/reverse-proxy access logs,
  which see the raw request line before this code ever runs (decisions/0018's
  documented residual risk).
- `tests/init-options.test.ts` - the "no-op without DSN" proof for `sentryInitOptions`,
  plus `redactInviteTokenFromUrl`'s own unit tests and a check that
  `beforeSend`/`beforeBreadcrumb` actually redact a token in a representative
  event/breadcrumb shape.
- `tests/sentry-config-no-op.test.ts` - the same "no-op without DSN" proof for the actual
  `src/sentry.server.config.ts`/`src/sentry.edge.config.ts` files, with `@sentry/nextjs`
  mocked.
- `server/capture-error.ts` (published through `server.ts`) - `captureError`: gates on
  `serverEnv().SENTRY_DSN`, calls `Sentry.captureException(error, { extra: context })`, never
  throws itself (a failure to report to Sentry is logged with `console.error` and swallowed -
  a monitoring failure must never crash the caller). Covered indirectly by
  `src/persistence/tests/jobs-use-cases.test.ts` (this module mocked there, so those tests
  never need a full valid `serverEnv()`).

## Consumers (outside this folder, by Next.js/Sentry file convention)

- `src/sentry.server.config.ts` (directly under `src/`): Node runtime, `SENTRY_DSN`.
- `src/sentry.edge.config.ts` (directly under `src/`): edge runtime, `SENTRY_DSN` (this app has no
  edge routes today, `src/proxy.ts` always runs in Node.js, but Next still loads an
  edge instrumentation bundle, so the file must exist and stay side-effect-free
  without a DSN).
- `src/instrumentation.ts` (directly under `src/`): `register()` dynamically imports whichever of
  the two config files above matches `NEXT_RUNTIME`; `onRequestError` calls
  `Sentry.captureRequestError`, gated on `SENTRY_DSN`.
- `src/instrumentation-client.ts` (directly under `src/`): browser runtime, `NEXT_PUBLIC_SENTRY_DSN`
  (mirrored from `SENTRY_DSN` by `next.config.ts`'s `env` block, so `.env.example`
  only names the one, server-style variable - Sentry's browser bundle needs the DSN
  inlined at build time like any `NEXT_PUBLIC_*` value).
- `next.config.ts`: `env.NEXT_PUBLIC_SENTRY_DSN` (see above), and wraps the
  exported config with `withSentryConfig` (from `@sentry/nextjs/config` - the
  un-prefixed `@sentry/nextjs` export is deprecated in 10.x, removed in 11) **only
  when `SENTRY_AUTH_TOKEN` is set**, so `next build` never even loads the Sentry
  build plugin (source map upload, `@sentry/cli`) when it isn't explicitly opted
  into - CI, the Docker test stack, and local dev all build with the plain,
  unwrapped config.

- `src/persistence/use-cases/jobs-use-cases.ts` (not a Next.js file-convention consumer, an
  ordinary `server.ts` import): calls `captureError` on a job's terminal failure (D3) - the
  one place in this codebase that reports an error to Sentry from outside a Next.js request
  boundary.

`src/sentry.server.config.ts`, `src/sentry.edge.config.ts`, and `src/instrumentation-client.ts`
read `process.env.SENTRY_DSN`/`NEXT_PUBLIC_SENTRY_DSN` directly rather than through
`src/platform/env`'s `serverEnv()`: they are part of the same Next.js/Sentry
file-convention family as `src/instrumentation.ts` itself, which
`WEBAPP_TEMPLATE_SPEC.md` §9 already exempts from the "`src/platform/env` is the only
reader of `process.env`" rule. See
`decisions/0009-sentry-config-files-read-process-env-directly.md`.

## When you first deploy a project built from this template

`@sentry/nextjs` is installed but not configured with a project/org: run the
Sentry setup wizard (`npx @sentry/wizard@latest -i nextjs`) or configure `SENTRY_DSN`
(and, for source maps, `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT`) by hand
in your hosting provider's environment variables. Until then, Sentry stays
completely inert (see "Preserved contracts and invariants" below); nothing here
needs to change to enable it later.

## Preserved contracts and invariants

- No Sentry env var, no Sentry instrumentation: no `Sentry.init()` call in any of
  the three runtimes, no `withSentryConfig` wrapping of `next.config.ts`. Proven by
  `tests/init-options.test.ts` and `tests/sentry-config-no-op.test.ts`; `next build`
  itself without any Sentry env is the build-level proof (see this task's
  verification results).
- No PII: `sendDefaultPii: false` on every `Sentry.init()` call (Sentry's own
  default is already `false`; set explicitly so it survives an SDK default
  change) - this also disables IP address collection. No user id, cookies, or
  request headers are attached anywhere in this codebase's own Sentry calls.

## Tests

- `tests/init-options.test.ts`: the no-op-without-DSN proof plus the shared-options
  shape, all in a pure unit test (no SDK, no DB, no network,
  WEBAPP_TEMPLATE_SPEC.md §10.2).
- `tests/sentry-config-no-op.test.ts`: the same proof against the real
  `src/sentry.server.config.ts`/`src/sentry.edge.config.ts` files, `@sentry/nextjs` mocked.

## Tradeoffs and limits

- The four `src/`-root files this concern feeds are unavoidable Next.js/Sentry file
  conventions, not a structure violation, same situation as `src/proxy.ts`, or
  `next.config.ts` and `drizzle.config.ts` at the repository root (all placed by
  framework convention).
- `tracesSampleRate` is a fixed constant (0.2) rather than env-driven; revisit if
  Sentry quota or the need for finer sampling control ever becomes a real
  constraint for a project built from this template.
