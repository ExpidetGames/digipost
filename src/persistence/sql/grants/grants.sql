-- Source for the custom migration granting decisions/0004-three-database-roles.md's
-- two request-time roles exactly the privileges the target model gives them. Turned
-- into a real migration file by `pnpm db:generate:custom grants`
-- (WEBAPP_TEMPLATE_SPEC.md §5.7); never edit the generated migration file directly,
-- edit this source and regenerate instead.
--
-- Runs as the owner connection (DATABASE_URL_MIGRATE): whichever role that is per
-- environment (the `postgres` superuser locally, `app_owner` in the Docker test
-- stack, a provider's owner role hosted) is also the role every `ALTER DEFAULT
-- PRIVILEGES` statement below applies to, since none of them name an explicit
-- `FOR ROLE`: Postgres defaults that clause to "the role running this statement".
-- That is deliberate: it makes this file identical across every environment in
-- decisions/0004's provider matrix (WEBAPP_TEMPLATE_SPEC.md §5.9) without needing to
-- know the owner role's name.
--
-- Fails loudly if the two login roles do not exist yet (WEBAPP_TEMPLATE_SPEC.md
-- §5.8): `scripts/db/bootstrap-roles.mjs` must run before the first `pnpm db:migrate`
-- in any new environment.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'app_runtime') then
    raise exception 'role "app_runtime" does not exist. Run "pnpm db:bootstrap" first (scripts/db/bootstrap-roles.mjs).';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'app_public') then
    raise exception 'role "app_public" does not exist. Run "pnpm db:bootstrap" first (scripts/db/bootstrap-roles.mjs).';
  end if;
end;
$$;

-- app_runtime (DATABASE_URL): usage on public/auth, DML on tables, usage on
-- sequences, no DDL (decisions/0004's table). Existing objects first...
grant usage on schema public to app_runtime;
grant usage on schema auth to app_runtime;
grant select, insert, update, delete on all tables in schema public to app_runtime;
grant select, insert, update, delete on all tables in schema auth to app_runtime;
grant usage on all sequences in schema public to app_runtime;
grant usage on all sequences in schema auth to app_runtime;

-- ...then every table/sequence a future migration creates in either schema, without
-- a follow-up grants migration being needed for the common case.
alter default privileges in schema public grant select, insert, update, delete on tables to app_runtime;
alter default privileges in schema auth grant select, insert, update, delete on tables to app_runtime;
alter default privileges in schema public grant usage on sequences to app_runtime;
alter default privileges in schema auth grant usage on sequences to app_runtime;

-- app_public (DATABASE_URL_PUBLIC): exactly the privileges unauthenticated public
-- paths need, nothing else (decisions/0004). No unauthenticated public path exists
-- in this template yet, so no table or sequence grant follows here: this only
-- prepares the pool and the narrow composition seam
-- (src/persistence/composition/public-services.ts). Schema usage alone lets the role
-- reference objects by name (required to even attempt a query and get a clean
-- "permission denied" instead of "schema does not exist") without granting access
-- to any of their contents. The first unauthenticated public path this template
-- gets adds its own `grant select ... to app_public` (or similar) in its own
-- migration, scoped to exactly the table(s) it needs.
grant usage on schema public to app_public;
