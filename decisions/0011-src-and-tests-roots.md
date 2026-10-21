# Application code under `src/`, cross-cutting test suites under `tests/`

Document type: decision
Lifecycle: active
Owner: template maintainer
Scope: Where application code, cross-cutting test suites, and the compose files live
at the repository root, and how older documents' paths map onto that layout
Canonical responsibility: Active source for why the owner roots sit under `src/`, why
`tests/` is a top-level root again, and why the compose files live in `docker/`
Maintenance triggers:
- A new direct child of `src/` or `tests/` is proposed
- `WEBAPP_TEMPLATE_SPEC.md` §3 changes the repository layout again
- Next.js changes its `src/` folder support or its convention-file locations
Last verified: 2026-09-19, against the repository tree after the move

## Status
Accepted

## Context

`WEBAPP_TEMPLATE_SPEC.md` §3 (before its revision 6) and
`decisions/0001-single-app-owner-model.md` place every
owner root (`app/`, `modules/`, `shared/`, `platform/`, `persistence/`, `i18n/`), the
Next.js convention files (`proxy.ts`, `instrumentation*.ts`, the Sentry configs), two
separate test roots (`e2e/`, `integration-tests/`), and both compose files directly at
the repository root. Together with the configuration files that tooling requires at the
root, that is more than forty top-level entries, with application code, tests,
infrastructure, and configuration interleaved in one alphabetical listing. The layout was
correct but hard to read from the outside.

Next.js officially supports a `src/` folder that holds `app/` plus the convention files
(`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/src-folder.md`):
`proxy.ts` and `instrumentation*.ts` move with it, while `public/`, `.env*`, and the
configuration files (`package.json`, `next.config.ts`, `tsconfig.json`, ...) stay at the
root. The configuration files cannot move without breaking editor integrations (the
Vitest and Playwright extensions, the shadcn CLI) that discover them at the root.

## Decision

- **`src/`** holds all application code: `src/app/`, `src/modules/`, `src/shared/`,
  `src/platform/`, `src/persistence/`, `src/i18n/`, plus `src/proxy.ts`,
  `src/instrumentation.ts`, `src/instrumentation-client.ts`, and the two Sentry configs.
  The owner model itself (`decisions/0001`) is unchanged; only its location moves.
  The `@/` alias points at `src/` (`tsconfig.json`, `vitest.config.ts`,
  `scripts/structure/lib/module-graph.ts`), so every `@/modules/...` import is unchanged.
- **`tests/`** holds only suites that cross owners: `tests/e2e/` (Playwright, was `e2e/`),
  `tests/integration/` (was `integration-tests/`), and `tests/config/` for unit tests of
  repository-root configuration files (`tests/config/next.config.test.ts`, was
  `next.config.test.ts` at the root). Owner-level unit and DB tests stay in each owner's
  own `tests/` directory; `tests/` is not a generic test dump.
- **`docker/`** also holds `compose.yml` and `compose.test.yml`. Both are always invoked
  with `--project-directory` set to the repository root (`pnpm infra:up`/`infra:down`,
  `scripts/test/docker.mjs`), so their relative paths, the compose project name (and with
  it the local `postgres-data` volume name), and the `.env` lookup behave exactly as
  before the move.
- The `roots` rule of `pnpm verify:structure` (`STRUCTURE.md` §1) treats `src/` and
  `tests/` as governed roots: each of their direct children must be declared, so a
  generic `src/lib/` or `tests/utils/` fails the check just like a top-level one would.

## Consequences

- Positive: the repository root reads as three groups at a glance: code (`src/`), tests
  (`tests/`), and root-bound tooling (configuration, `public/`, `docker/`, `scripts/`,
  governance documents).
- Positive: the tests layout matches common practice (co-located unit tests, one
  `tests/` root for e2e and integration suites).
- Neutral: `WEBAPP_TEMPLATE_SPEC.md` revision 6 adopts this layout in §3 (its §18 keeps
  the old paths on purpose: it records the Deeplify migration as it happened).
  `STRUCTURE.md` stays the enforced source for this repository's layout.
- Negative: ADRs 0001 to 0010 are immutable (`DOC_RULES.md` §6) and keep their original
  paths. Read them with this mapping: `app/`, `modules/`, `shared/`, `platform/`,
  `persistence/`, `i18n/`, `proxy.ts`, `instrumentation*.ts`, `sentry.*.config.ts` →
  under `src/`; `e2e/` → `tests/e2e/`; `integration-tests/` → `tests/integration/`;
  `next.config.test.ts` → `tests/config/`; `compose.yml`, `compose.test.yml` → `docker/`.
- Negative: a bare `docker compose up` at the root no longer finds the dev stack; use
  `pnpm infra:up`, or pass `-f docker/compose.yml --project-directory .` explicitly.
