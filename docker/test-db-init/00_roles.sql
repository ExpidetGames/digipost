-- Test-stack only (mounted into /docker-entrypoint-initdb.d, runs once as the
-- bootstrap superuser when the container's data directory is first initialized).
-- Fixed dummy passwords matching docker/compose.test.yml's DATABASE_URL* values - these
-- are not real secrets, this file is the only place they are written (besides
-- docker/compose.test.yml itself), and the whole stack is torn down after every run
-- (scripts/test/docker.mjs's `down -v`).
--
-- app_owner mirrors a hosted provider's non-superuser owner role (Neon's
-- neondb_owner, Supabase's postgres role, ...) for DATABASE_URL_MIGRATE: LOGIN
-- only, deliberately NOT superuser and NOT createrole. A superuser would trivially
-- pass every privilege/grant check in src/persistence/tests/roles.db.test.ts regardless
-- of whether src/persistence/sql/grants/grants.sql's GRANT statements are actually
-- correct, hiding real bugs that only show up under a real provider's restricted
-- owner. `app_runtime`/`app_public` are created directly here too (not by
-- scripts/db/bootstrap-roles.mjs, which needs an existing owner connection to run
-- as) - docker/compose.test.yml's `migrate` job still runs that script afterwards
-- (idempotent: it finds these roles already present and does nothing), so the same
-- code path stays exercised against a plain Postgres URL, not only the local
-- (docker/compose.yml) path where it does real work.
create role app_owner login password 'test-owner-password-only-for-docker-test-stack';

-- The postgres image's bootstrap superuser (POSTGRES_USER, left at its default
-- "postgres" here) owns $POSTGRES_DB by default; hand ownership to app_owner so it
-- can create schemas/tables/extensions in it without extra grants, same as a
-- provider's owner role owning the database. `:"POSTGRES_DB"` psql-variable
-- substitution is not available here (docker-entrypoint.sh runs these files with
-- plain `psql -f`, no `-v`), so target the current database dynamically instead.
do $$
begin
  execute format('alter database %I owner to app_owner', current_database());
end;
$$;

create role app_runtime login password 'test-runtime-password-only-for-docker-test-stack';
create role app_public login password 'test-public-password-only-for-docker-test-stack';
