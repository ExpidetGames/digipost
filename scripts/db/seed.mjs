#!/usr/bin/env node
// node scripts/db/seed.mjs
//
// Applies src/persistence/seed.sql (reference data only - never data a test mutates,
// WEBAPP_TEMPLATE_SPEC.md §5.7) in one transaction. Local/test-stack only: refuses
// any host outside scripts/db/env.mjs's LOCAL_HOSTS allowlist, with no override
// flag (unlike db:migrate's --remote) - a project's real seed data for a hosted
// environment goes through ops SQL or a dedicated migration, never this script.
//
// Connection: DATABASE_URL_MIGRATE (the owner role).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import pg from "pg";

import { describeUrl, formatPgError, hostOf, LOCAL_HOSTS, loadEnvLocal, migrateUrl, pgConnectionString, ROOT } from "./env.mjs";

const SEED_FILE = join(ROOT, "src", "persistence", "seed.sql");

loadEnvLocal();
const url = migrateUrl();
const host = hostOf(url);
if (!LOCAL_HOSTS.has(host)) {
  console.error(`Refusing to run db:seed against a non-local host (${host}). Seed data is for local/test-stack use only.`);
  process.exit(2);
}

if (!existsSync(SEED_FILE)) {
  console.log(`db:seed -> ${describeUrl(url)}`);
  console.log("  no src/persistence/seed.sql yet (template placeholder: nothing to seed)");
  process.exit(0);
}

const sql = readFileSync(SEED_FILE, "utf8");
const client = new pg.Client({ connectionString: pgConnectionString(url), application_name: "digipost db:seed" });
await client.connect();

let exitCode = 0;
try {
  console.log(`db:seed -> ${describeUrl(url)}`);
  await client.query("begin");
  await client.query(sql);
  await client.query("commit");
  console.log("  applied src/persistence/seed.sql");
} catch (err) {
  await client.query("rollback").catch(() => {});
  console.error(`  FAILED: ${formatPgError(err, sql)}`);
  exitCode = 1;
} finally {
  await client.end();
}
process.exit(exitCode);
