# Docker test stack is the reference environment for DB, integration, and E2E tests

Document type: decision
Lifecycle: active
Owner: template maintainer
Scope: Which test execution environment is authoritative when a host run and a Docker run
disagree
Canonical responsibility: Active source for "Docker is the reference, host is for
authoring"
Maintenance triggers:
- `compose.test.yml` gains or loses services
- CI's test-running jobs change which script they invoke
Last verified: 2026-09-14 against WEBAPP_TEMPLATE_SPEC.md §10.1, §10.3 and T2's
`compose.test.yml`, `docker/`, `scripts/test/docker.mjs`

## Status
Accepted

## Context

Tests that touch a real Postgres instance, an SMTP server, or a real browser behave
differently depending on the machine: native-module builds differ between macOS and
Linux, a locally installed Postgres may use a different collation than a hosted provider,
and a developer's local environment can drift from what CI actually runs. Without one
environment declared authoritative, "it passes on my machine" and "CI is red" have no
tiebreaker.

## Decision

1. `compose.test.yml` defines a hermetic test stack (Postgres, Mailpit, a migrate/seed job,
   the built app, Playwright), with no host ports, its own Compose project name, and a
   Postgres instance in `tmpfs` that starts fresh on every run.
2. If a test is green when run on the host (`pnpm test:db`, `pnpm test:int`,
   `pnpm test:e2e`) but red inside the Docker stack (`pnpm test:docker`,
   `pnpm test:e2e:docker`), the Docker stack's result is the one that counts. CI runs
   exactly the same Docker-stack-driven commands a developer runs locally, so there is one
   definition of "passing", not two.
3. Host runs remain the normal way to author and debug a test (faster iteration, UI mode,
   breakpoints); they are not a substitute for a green Docker run before relying on a
   change being correct.

## Consequences

- Positive: local and CI results cannot disagree because of environment drift, since the
  reference environment is defined once, versioned, and identical in both places.
- Negative: running the full reference suite requires Docker locally and is slower than a
  host-mode run for iterating on a single test; a developer without Docker available
  cannot produce an authoritative result locally.
- Implementation status: **implemented** (T2). `compose.test.yml` (no host ports, its own
  compose project name derived per-checkout by `scripts/test/docker.mjs`, Postgres in
  `tmpfs`), `docker/app.Dockerfile` (`deps`/`tools`/`build`/`runner` stages),
  `docker/e2e.Dockerfile` (Playwright-version-pinned via a build arg), and
  `docker/test-db-init/00_roles.sql` (a non-superuser `app_owner`, matching a real
  provider's owner role) all exist and pass: `pnpm test:docker` (14 `*.db.test.ts` +
  2 integration tests) and `pnpm test:e2e:docker` (the `home.spec.ts` smoke test) both run
  green end to end, with `down -v` verified to run on completion. `compose.yml` (local dev
  infrastructure) predates this step (T1) and remains unchanged in purpose, only its
  Postgres volume mount path was fixed (postgres:18+ moved its data directory).
