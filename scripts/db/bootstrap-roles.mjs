#!/usr/bin/env node
// node scripts/db/bootstrap-roles.mjs [--remote [--expect-host=<host>]]
//
// Creates `app_runtime` and `app_public` (if DATABASE_URL_PUBLIC is set) as LOGIN
// roles, idempotently (WEBAPP_TEMPLATE_SPEC.md §5.8): an existing role is left
// completely unchanged, including its password. Passwords come from
// DATABASE_URL/DATABASE_URL_PUBLIC's own credentials - never generated here, never
// printed - so the role this script creates can log in with exactly the connection
// string already configured for it.
//
// Connects as the owner (DATABASE_URL_MIGRATE):
// - Local (docker/compose.yml): the owner is the Postgres superuser: this script is what
//   actually creates app_runtime/app_public for the first time.
// - Docker test stack (docker/compose.test.yml): docker/test-db-init/00_roles.sql already
//   created every role with fixed dummy passwords as part of Postgres' own
//   container bootstrap; this script runs anyway (docker/compose.test.yml's `migrate` job)
//   so the exact same code path stays exercised against a plain Postgres URL, not
//   only the local path - it just finds the roles already there and does nothing.
// - A hosted provider: run once per new project/environment before the first
//   `pnpm db:migrate` (migrations check the roles exist and abort otherwise, see
//   src/persistence/sql/grants/grants.sql).
//
// Refuses a non-local DATABASE_URL_MIGRATE host unless --remote (plus --expect-host
// in CI, or an interactive confirmation) - see scripts/db/env.mjs's `guardHost`.

import pg from "pg";

import { describeUrl, guardHost, loadEnvLocal, migrateUrl, pgConnectionString } from "./env.mjs";

const ROLES = [
  { name: "app_runtime", attrs: "login", urlEnv: "DATABASE_URL" },
  { name: "app_public", attrs: "login", urlEnv: "DATABASE_URL_PUBLIC" },
];

loadEnvLocal();
const url = migrateUrl();
await guardHost(url, { argv: process.argv.slice(2), what: "db:bootstrap" });

/** The role name and password embedded in a connection string's own credentials. */
function credentialsOf(connectionUrl) {
  const u = new URL(connectionUrl);
  if (!u.username || !u.password) {
    throw new Error(`${connectionUrl.replace(/:[^:@]*@/, ":***@")} has no username/password to derive a role from`);
  }
  return { user: decodeURIComponent(u.username), password: decodeURIComponent(u.password) };
}

const client = new pg.Client({ connectionString: pgConnectionString(url), application_name: "digipost db:bootstrap" });
await client.connect();

let exitCode = 0;
try {
  console.log(`db:bootstrap -> ${describeUrl(url)}`);

  for (const role of ROLES) {
    const roleUrl = process.env[role.urlEnv];
    if (!roleUrl) {
      console.log(`  ${role.name}: skipped (${role.urlEnv} is not set - no unauthenticated public path configured yet)`);
      continue;
    }

    const { user, password } = credentialsOf(roleUrl);
    if (user !== role.name) {
      throw new Error(`${role.urlEnv}'s username is "${user}", expected "${role.name}"`);
    }

    const { rowCount } = await client.query("select 1 from pg_roles where rolname = $1", [role.name]);
    if (rowCount > 0) {
      console.log(`  ${role.name}: exists, left unchanged`);
      continue;
    }

    await client.query(`create role ${client.escapeIdentifier(role.name)} ${role.attrs} password ${client.escapeLiteral(password)}`);
    console.log(`  ${role.name}: created (${role.attrs.toUpperCase()})`);
  }

  console.log("\nNext: pnpm db:migrate (grants each role its privileges, see src/persistence/sql/grants/grants.sql).");
} catch (err) {
  console.error(`  FAILED: ${err instanceof Error ? err.message : String(err)}`);
  exitCode = 1;
} finally {
  await client.end();
}
process.exit(exitCode);
