# src/platform/env

Document type: reference
Lifecycle: active
Owner: src/platform/env
Scope: Environment variable access and validation for this application
Canonical responsibility: The only owner allowed to read `process.env` at request time
(outside `next.config.ts`, `drizzle.config.ts`, `instrumentation*.ts`, `scripts/**`, and
test configuration, per WEBAPP_TEMPLATE_SPEC.md §9's `env-access` rule)
Maintenance triggers:
- An environment variable is added, removed, or its validation changes
- A new public (`NEXT_PUBLIC_*`) variable is introduced
Last verified: 2026-10-22, decisions/0075-email-intake.md added the four optional
E-Mail-Eingang variables. Previously 2026-09-20, P7 (D4, real-API defect fixes): `serverEnv()` now blanks every
empty-string env value to `undefined` before validation (`blankStringsToUndefined`) - `cp
.env.example .env.local` used to 500 every request, because Next.js loads an optional
variable shipped as a blank line (`MISTRAL_OCR_MODEL=`, `SENTRY_DSN=`, ...) as `""`, which
`.min(1)`/`.url()`/an optional enum all reject as an invalid (not absent) value. P2b
(processing pipeline): added the Mistral AI variables
(decisions/0016-processing-pipeline-and-ai.md), against WEBAPP_TEMPLATE_SPEC.md §9 and
.env.example

## Purpose

`src/platform/env` is the single place that reads and validates `process.env`. No other
owner reads `process.env` directly; a new server-only variable is added to
`server/env.ts`'s Zod schema, a new public variable is added to `index.ts`, and both are
documented in `.env.example`.

## Public interfaces

- `index.ts` (neutral): `publicEnv`, the validated `NEXT_PUBLIC_*` values. Safe to import
  from client-reachable code. Each field references `process.env.NEXT_PUBLIC_*`
  statically (never through a computed key or a loop), which is required for Next.js to
  inline it into client bundles at build time.
- `server.ts` (privileged, `import "server-only"`): `serverEnv()`, a lazily validated,
  cached read of every server-only environment variable. Throws (via Zod) on first access
  if a required variable is missing or malformed, not at module load time, so `next build`
  and any test that never calls `serverEnv()` can run without every runtime secret set.
  `resetServerEnvCacheForTests()` clears the cache; only meant for tests.

## Structure

- `server/env.ts`: the Zod schema and the lazy, cached `serverEnv()` implementation.
- `server.ts`: re-exports `server/env.ts`'s public surface; the actual privileged
  entrypoint other owners import.
- `index.ts`: the neutral, public-env entrypoint.
- `tests/env.test.ts`: unit tests: valid environment, optional fields, caching, and one
  failure case per required field.

## Invariants

- `serverEnv()` validates lazily. Importing `src/platform/env/server` must never throw by
  itself; only calling `serverEnv()` can throw.
- An empty string (`KEY=` with nothing after the `=`, `.env.example`'s own convention for
  every optional variable) is treated identically to the key being entirely absent, for
  every field: `blankStringsToUndefined` converts every `""` value to `undefined` before
  `ServerEnv.parse` ever sees it (D4, P7). A REQUIRED field is unaffected in the only way
  that matters - its Zod error just becomes "required" instead of "invalid format"; it still
  throws either way (`tests/env.test.ts` proves both an absent and an empty-string REQUIRED
  field throw, and every optional field accepts an empty string without throwing).
- Every server-only variable this module validates is documented in `.env.example` with a
  comment explaining what reads it and why.
- `DATABASE_URL_MIGRATE` is deliberately **not** part of `ServerEnv`: per
  WEBAPP_TEMPLATE_SPEC.md §9's table, it is read only by `scripts/db/*` and
  `drizzle.config.ts`, never by application code, so it does not belong in the runtime
  schema this owner validates.
- `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` are required;
  `S3_ENDPOINT` (optional URL, unset means the AWS default endpoint for `S3_REGION`) and
  `S3_FORCE_PATH_STYLE` (optional boolean, default `false`, `true` for MinIO) are
  optional. Only `src/platform/object-storage` reads these through `serverEnv()`
  (`decisions/0012-object-storage.md`, `STRUCTURE.md`'s `env-access` rule).
- `MISTRAL_API_KEY` (optional), `AI_PROVIDER` (optional enum `"mistral" | "fake"`),
  `MISTRAL_OCR_MODEL`/`MISTRAL_CHAT_MODEL` (optional strings, default to Mistral's own
  model names when unset) are only read through `serverEnv()` by `src/platform/mistral`
  (decisions/0016-processing-pipeline-and-ai.md, `STRUCTURE.md`'s `env-access` rule). This
  schema stays permissive on purpose (all four optional): the provider-selection logic
  that decides between the real Mistral adapter, the fake adapter, and the
  `ai_not_configured` production failure lives in `src/platform/mistral/server`, not here.
- `INBOUND_EMAIL_DOMAIN` (optional bare domain), `RESEND_WEBHOOK_SECRET`, `RESEND_API_KEY`
  (optional strings), `INBOUND_MAIL_PROVIDER` (optional enum `"resend" | "fake"`) are only read
  through `serverEnv()` by `src/platform/inbound-mail` (decisions/0075-email-intake.md,
  `STRUCTURE.md`'s `env-access` rule for the two secrets). All optional: without the domain
  and the secret the E-Mail-Eingang is simply off; the adapter selection lives in
  `src/platform/inbound-mail/server`, not here.

## Tests

`src/platform/env/tests/env.test.ts` (Vitest, `pnpm test`): valid environment parses, optional
fields (`DATABASE_URL_PUBLIC`, `SENTRY_DSN`) are accepted when present and absent
otherwise, the parsed result is cached across calls, and each required field's absence or
an invalid `APP_URL`/`BETTER_AUTH_SECRET` throws. D4 (P7): every optional field (string,
boolean-as-enum, and plain enum) accepts an empty string the same as an absent one, a
REQUIRED field still throws on an empty string (not only when absent), and the
`.env.example`-copy scenario (one real value set, several optional fields left blank)
parses cleanly end to end.
