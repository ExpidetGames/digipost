# Provider-independent Postgres via pg + Drizzle ORM

Document type: decision
Lifecycle: active
Owner: template maintainer
Scope: Database driver, ORM, and migration tooling; what "provider-independent" means for
persistence in this template
Canonical responsibility: Active source for why the template uses `pg` + Drizzle instead
of a provider SDK or a provider-specific driver
Maintenance triggers:
- The database driver or ORM choice changes
- A provider-specific SDK (Supabase, Neon serverless, ...) is proposed for the app code
  path (outside `persistence/foundation/`)
Last verified: 2026-09-14 against WEBAPP_TEMPLATE_SPEC.md §2.2, §5.2, §5.9 and T2's
`persistence/foundation/client.ts`, `drizzle.config.ts`

## Status
Accepted

## Context

Two prior real projects this template draws from each picked a provider-coupled path:
one used a provider SDK end to end (Supabase), the other used a provider's HTTP-only
driver on its hot path (`@neondatabase/serverless`) for latency reasons. Both choices tie
the runtime code to one hosting provider's client library.

"Provider-independent" here specifically means *Postgres-provider-independent*, not
*database-independent*: the template deliberately uses Postgres-specific features
(`jsonb`, `for update skip locked`, advisory locks, roles, optional row-level security).
Neon, Supabase-as-Postgres, RDS, a self-hosted server, or a local Docker container must all
be swappable by changing only connection strings.

## Decision

1. `pg` (node-postgres) with a pooled client is the only database driver in application
   code, used for runtime queries, Better Auth's adapter, migrations, and tests alike. It
   works unchanged against Neon, Supabase (via Supavisor), RDS, PgBouncer in transaction
   mode, and a plain local Postgres, with no named-prepared-statement special cases.
2. `drizzle-orm` + `drizzle-kit` is the ORM and migration generator. Migrations are always
   generated from a schema diff (`drizzle-kit generate`), never hand-written or
   AI-authored; `drizzle-kit push` is never used against a shared database.
3. No `@supabase/*` or `@neondatabase/*` package may appear in application code. A
   provider-specific driver remains available strictly as an optional adapter, fully
   encapsulated inside `persistence/foundation/client.ts`, if a future hot path needs it.

## Consequences

- Positive: switching Postgres providers is a configuration change (connection strings),
  never a code change; one driver serves runtime, migrations, and tests, so there is one
  set of connection semantics to reason about.
- Negative: giving up a provider's HTTP-only driver means giving up whatever latency
  advantage it has on serverless cold paths; that tradeoff is accepted in exchange for
  provider independence and driver uniformity.
- Implementation status: **implemented** (T2). `persistence/foundation/client.ts` is the
  only module that imports `pg`/`drizzle-orm/node-postgres`; `persistence/migrations/`
  holds `drizzle-kit generate`'s output (`0000_faithful_maggott.sql`, the schema baseline;
  `0001_grants.sql`, the custom grants migration); `scripts/db/*.mjs` and
  `drizzle.config.ts` are the only files reading `DATABASE_URL_MIGRATE`. No
  `@supabase/*`/`@neondatabase/*` package exists in this repository.
