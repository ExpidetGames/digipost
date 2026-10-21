# src/platform/api-pipeline

Document type: reference
Lifecycle: active
Owner: src/platform/api-pipeline
Scope: Route-handler composition for `src/app/api/**` JSON API routes: the
`access -> parse -> execute -> respond` step pipeline, Zod request validation, the
`{ errorCode }` JSON error envelope, request-id tagging, and the two access steps
(cron bearer secret, Better Auth session)
Canonical responsibility: The generic step pipeline that turns an access check, a
schema parse, an execution, and a response builder into one App Router route
handler with one error contract
Maintenance triggers:
- The handler step order or its error-mapping semantics change
- The `{ errorCode }` response envelope or the request-id/logging behavior changes
- A route adopts the pipeline, or a documented bypass changes
- The cron bearer-secret or session access step's contract changes
Last verified: 2026-09-19, P2b (processing pipeline): `GET /api/cron/process-jobs` is
`requireCronSecret`'s first real adopter, see "Adoption boundary" below

## Purpose

Almost every JSON API route in an application built from this template does the
same four things in the same order: resolve access, parse the request against a
Zod schema, execute one use case, and build a response. This concern owns that
pipeline plus the two access steps every route picks between (a cron bearer secret
or a Better Auth session). It owns no capability meaning: every access check, use
case, and response body a route supplies belongs to that route's own owner.

## Public interfaces

- `index.ts` (neutral, no `server-only`, no `"use client"`): `createApiHandler`,
  `createApiHandlerFromContract`, `defineApiEndpointContract`,
  `parseJsonRequestWithSchema`, `parseQueryWithSchema`, `mapErrorCode`,
  `mapUseCaseError`, `newRequestId`, `apiErrorResponse`, and the `ApiErrorResponse`
  type. Nothing it reaches is privileged.
- `server.ts` (privileged, `import "server-only"`): `CronAuthError`,
  `requireCronSecret`, `SessionAccessError`, `requireSessionAccess`.

## Structure and responsibilities

- `core/handler-factory.ts`: the step machine. `access`, `parse`, `execute`,
  `respond` run in that order; a step that throws is converted through its own
  `mapError` and falls back to the contract's `unknownError`; a `parse` step
  returning `null` produces the contract's `invalidRequestError` without ever
  running `execute`. `defineApiEndpointContract` names the two fallbacks once per
  endpoint so every handler for that endpoint shares them.
- `core/responses.ts`: `apiErrorResponse` builds the error response, always
  `{ "errorCode": <string> }` at the given status unless the route overrides `body`
  (for a contract that predates the pipeline or needs a different shape) and always
  carries `x-request-id`.
- `core/request-id.ts`: `newRequestId()`, one per handler invocation.
- `core/request-validation.ts`: `parseJsonRequestWithSchema` (JSON body, `null` on
  parse or schema failure) and `parseQueryWithSchema` (flattened `URLSearchParams`).
- `core/error-mapping.ts`: `mapErrorCode` maps a source code through a partial
  table with an explicit fallback; `mapUseCaseError` narrows a thrown
  `UseCaseError` (`src/persistence/use-cases/errors.ts`) and maps its `code`.
- `server/cron-auth.ts`: `requireCronSecret(request)`, a timing-safe
  `Authorization: Bearer $CRON_SECRET` check (SHA-256 both sides,
  `crypto.timingSafeEqual`), throwing `CronAuthError` on any mismatch. Reads the
  secret through `src/platform/env`'s `serverEnv()`, never `process.env` directly
  (`src/platform/env/README.md`'s exclusivity rule) - `CRON_SECRET` is a required field
  in `ServerEnv`, so a genuinely unset secret fails `serverEnv()` itself rather than
  this step silently treating it as "no auth required".
- `server/require-session-access.ts`: `requireSessionAccess()`, the JSON API
  equivalent of `src/platform/auth/server`'s `requireUser()` for pages - resolves the
  signed-in user via `getCurrentUser()` and throws `SessionAccessError` instead of
  redirecting (a route handler has no page to redirect from). No route adopts this
  step yet; it exists so the pipeline supports both access modes it documents.

## No stack traces to clients, with a request id for correlation

Every error response `apiErrorResponse` builds carries an `x-request-id` header
(`core/request-id.ts`, one id per handler invocation, shared by every error
response that same call produces). Whenever a step's raw thrown error is not
claimed by that step's own `mapError` (`mapError` absent, returns nothing, or
itself throws) and the pipeline falls back to the endpoint's `unknownError`, that
raw error is logged server-side (`console.error`) tagged with the same request id,
and only the id and the generic error code ever reach the client - never the raw
error's message or stack. A route's own `mapError` deciding the response (a known,
named error code) is not logged: that is expected, routine behavior, not something
ops needs to be told about.

## Adoption boundary

`src/app/api/documents/route.ts` (`POST /api/documents`, P2a,
decisions/0015-documents-and-quotas.md) is this pipeline's first real route: its `access`
step is `src/platform/access/server`'s `workspaceAccess`, not one of the two access steps
this owner ships itself. `src/app/api/cron/process-jobs/route.ts` (`GET`, P2b,
decisions/0016-processing-pipeline-and-ai.md, `src/platform/jobs`'s sweeper) is
`requireCronSecret`'s first real adopter: `access: { run: ({ request }) =>
requireCronSecret(request), mapError: ... }`. `requireSessionAccess` remains unexercised by a
real route.

Historical note: the `projects` example module's `src/app/api/cron/purge-archived-projects/route.ts`
was this owner's original reference example for a cron route built on `requireCronSecret`,
removed along with that module in P1 (`decisions/0014-workspaces-and-access.md`,
`src/modules/workspaces/README.md`'s "How the `projects` example module was removed").

Two routes deliberately bypass it, because adopting it would change observable
behavior or the route's contract does not fit a `{ errorCode }`-shaped JSON API:

| Route | Why it bypasses |
|---|---|
| `src/app/api/health/route.ts` | A single trivial check with no request to parse and no session/cron access step; its contract is `{ ok }`, never `{ errorCode }` (`src/app/api/health/route.ts`'s own header comment). |
| `src/app/api/auth/[...all]/route.ts` | Better Auth's own handler (`toNextJsHandler`, a third-party framework adapter with its own request/response contract: magic-link verification, session cookies, redirects). Wrapping it in this pipeline would fight the adapter for no benefit. |

This boundary is descriptive, like `WEBAPP_TEMPLATE_SPEC.md`'s own request-path
table. It is not a backlog: closing either row means changing a status code, a
content type, or an error vocabulary.

## Preserved contracts and invariants

- Step order and short-circuiting: a failing `access` step never runs `parse`; a
  `parse` step returning `null` never runs `execute`.
- A `mapError` that itself throws falls back to the contract's `unknownError`
  rather than propagating.
- The default error body is exactly `{ "errorCode": <string> }`; a route only gets
  a different body/headers by setting them explicitly on its `ApiErrorResponse`
  values.
- `x-request-id` is present on every error response this pipeline builds; the raw
  error behind an `unknownError` fallback is always logged server-side, tagged with
  that same id, and never included in the response itself.

## Tests

- `tests/api-handler-factory.test.ts`: the step machine, the request-id header, and
  the server-side logging behavior (logs on an unmapped/unknown error, does not log
  when a `mapError` claims the error or when `parse` returns a routine `null`).
- `tests/cron-auth.test.ts`: `requireCronSecret` against a stubbed `ServerEnv`
  (correct secret, missing header, wrong secret, missing `Bearer` prefix, a
  secret that is a prefix of the real one).
- `tests/require-session-access.test.ts`: `requireSessionAccess` against a mocked
  `src/platform/auth/server`.
- `POST /api/documents` (P2a) exercises the pipeline end to end: its own unit-level request
  validation is `src/modules/documents/tests/upload-processing.test.ts`, and
  `tests/integration/http/documents-upload.integration.test.ts` runs the real route handler
  against real Postgres and MinIO, proving every step (`access`, `parse`, `execute`,
  `respond`) and their status-code mapping.
- `GET /api/cron/process-jobs` (P2b) exercises `requireCronSecret` as a real `access` step:
  `src/app/api/cron/process-jobs/route.test.ts` (unit, `runDueJobs` mocked) and
  `tests/integration/http/cron-process-jobs.integration.test.ts` (real Postgres, unmocked).

## Tradeoffs and limits

- `index.ts` and `server.ts` are one concern split by runtime, not two pipelines. A
  route that needs only parsing and the error envelope never loads
  `src/platform/auth/server` or `src/platform/env/server`.
- Nothing forces a new route to adopt the pipeline, and nothing here enforces that
  a route's `body`/`headers` override stays consistent with its own documented
  contract; that is a review concern (`AGENTS.md` "Structure").
- `x-request-id` is only attached to error responses this pipeline itself builds; a
  route's own `respond` step returns its `Response` unmodified, so a success
  response carries no request id unless the route adds one itself.
