#!/usr/bin/env node
// node scripts/db/migrate.mjs [--status] [--remote [--expect-host=<host>]]
//
// Applies src/persistence/migrations/*.sql (drizzle-kit generated, never hand-written -
// WEBAPP_TEMPLATE_SPEC.md §5.7) via drizzle-orm's own migrator. Connection:
// DATABASE_URL_MIGRATE (the owner role, a direct connection, not a pooler).
//
//   --status          list applied/pending migrations, change nothing
//   --remote          allow a non-local host (see scripts/db/env.mjs's guardHost);
//                      combine with --expect-host=<host> for a non-interactive
//                      (CI) run - aborts unless the connection string's host
//                      matches exactly, so a swapped secret never migrates the
//                      wrong database
//
// A single `pg.Client` (one session, not a Pool) holds `pg_advisory_lock` for the
// whole run, so only one migrator runs against a given database at a time; the
// lock releases automatically when this script's connection closes.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { migrate } from "drizzle-orm/node-postgres/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

import { describeUrl, guardHost, loadEnvLocal, migrateUrl, pgConnectionString, ROOT } from "./env.mjs";

const MIGRATIONS_FOLDER = join(ROOT, "src", "persistence", "migrations");
const JOURNAL_FILE = join(MIGRATIONS_FOLDER, "meta", "_journal.json");
const LOCK_KEY = "digipost.db-migrate";
const MIGRATIONS_TABLE = "__drizzle_migrations";

loadEnvLocal();
const statusOnly = process.argv.includes("--status");
const url = migrateUrl();
await guardHost(url, { argv: process.argv.slice(2), what: "db:migrate" });

const client = new pg.Client({ connectionString: pgConnectionString(url), application_name: "digipost db:migrate" });
await client.connect();

let exitCode = 0;
try {
  const { rows: who } = await client.query("select current_user as u, current_database() as d");
  console.log(`db:migrate -> ${describeUrl(url)} (role ${who[0].u}, db ${who[0].d})`);

  await client.query("select pg_advisory_lock(hashtextextended($1, 0))", [LOCK_KEY]);

  // drizzle-orm's migrator (below) tracks progress with a single row per applied
  // migration in drizzle.__drizzle_migrations, gated by comparing each migration
  // folder's timestamp (`meta/_journal.json`'s `when`) against the LATEST applied
  // row's `created_at` - not a per-file "is this one applied" set. Mirror that same
  // comparison here for `--status` instead of reimplementing drizzle's own logic.
  const journal = JSON.parse(readFileSync(JOURNAL_FILE, "utf8"));
  const { rows: exists } = await client.query("select to_regclass($1) as reg", [`drizzle.${MIGRATIONS_TABLE}`]);
  let lastAppliedAt = -1;
  if (exists[0]?.reg) {
    const { rows } = await client.query(`select max(created_at) as latest from drizzle.${MIGRATIONS_TABLE}`);
    lastAppliedAt = rows[0]?.latest === null ? -1 : Number(rows[0].latest);
  }

  if (statusOnly) {
    for (const entry of journal.entries) {
      console.log(`  ${entry.when <= lastAppliedAt ? "applied" : "pending"}  ${entry.tag}.sql`);
    }
  } else {
    const pending = journal.entries.filter((entry) => entry.when > lastAppliedAt).length;
    const db = drizzle({ client });
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER, migrationsTable: MIGRATIONS_TABLE, migrationsSchema: "drizzle" });
    console.log(pending === 0 ? "  up to date, nothing to apply" : `  applied ${pending} migration file(s)`);
  }
} catch (err) {
  console.error(`  FAILED: ${err instanceof Error ? err.message : String(err)}`);
  exitCode = 1;
} finally {
  await client.end();
}
process.exit(exitCode);
