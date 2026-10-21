# Three database roles: app_owner, app_runtime, app_public

Document type: decision
Lifecycle: active
Owner: template maintainer
Scope: Database role model and which connection string each part of the app uses
Canonical responsibility: Active source for the three-role model and what each role may do
Maintenance triggers:
- A role is added, removed, or its privileges change
- Row-level security is turned on for a project built from this template
Last verified: 2026-09-14 against WEBAPP_TEMPLATE_SPEC.md §5.8, §5.9, §9 and T2's
`persistence/sql/grants/grants.sql`, `scripts/db/bootstrap-roles.mjs`,
`docker/test-db-init/00_roles.sql`

## Status
Accepted

## Context

A single database-owning connection string for everything (migrations, authenticated
app code, and any unauthenticated public path) means a bug anywhere in the app can reach
and modify any table, including ones an unauthenticated request should never be able to
touch. Splitting privileges by least-need, without turning on row-level security by
default, keeps the blast radius of an application bug small while keeping the common case
(an authenticated request reading and writing its own data) simple.

## Decision

Three login roles, three connection strings, least privilege per role:

| Role | Env var | Privileges | Used by |
|---|---|---|---|
| `app_owner` | `DATABASE_URL_MIGRATE` | Owns all objects, DDL | `scripts/db/*`, `drizzle.config.ts` only |
| `app_runtime` | `DATABASE_URL` | `usage` on `public`/`auth` schemas, DML on tables, `usage` on sequences, no DDL | The application: dashboard, Server Actions, Better Auth |
| `app_public` | `DATABASE_URL_PUBLIC` | Exactly the privileges unauthenticated public paths need (for example, reading a table served without a session, or a rate-limit table), nothing else | Only `persistence/foundation/**` and the narrow composition seam for those paths |

Row-level security (a fourth layer, `app_user` with `SET TRUE, INHERIT FALSE`, scoped by
`app.current_user_id()`) is an optional recipe, not a default: it is recommended once
several write paths (cron, webhooks, admin) touch the same sensitive, tenant-owned tables,
not from day one, because the repository rule "every scoped method takes and filters by
its scope ID" already gives most of the same protection without a transaction-per-request
cost.

## Consequences

- Positive: an unauthenticated public endpoint's database connection cannot read or write
  anything outside what it was explicitly granted, even if its application code has a bug;
  a compromised or buggy runtime connection still cannot alter schema.
- Negative: three connection strings and three roles to provision per environment (local,
  test stack, every hosted environment) instead of one; `app_public` requires a project to
  identify its unauthenticated public paths up front and grant only what they need.
- Implementation status: **implemented** (T2), the target model directly - no transition
  machinery. `persistence/foundation/client.ts` exposes `getDb()`/`getPublicDb()`;
  `persistence/sql/grants/grants.sql` (-> `persistence/migrations/0001_grants.sql`) grants
  each role exactly the table in the table above, and fails loudly if `app_runtime`/
  `app_public` do not exist yet; `scripts/db/bootstrap-roles.mjs` creates them locally and
  in the Docker test stack; `docker/test-db-init/00_roles.sql` creates a non-superuser
  `app_owner` for the hermetic stack so grant bugs cannot hide behind superuser privileges.
  `persistence/tests/roles.db.test.ts` proves the boundary against real Postgres. Row-level
  security remains the optional recipe described above: not built, not needed yet.
