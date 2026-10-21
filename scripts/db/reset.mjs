#!/usr/bin/env node
// node scripts/db/reset.mjs
//
// Local only (no override flag, same refusal as db:seed): drops and recreates the
// `public` and `auth` schemas, then runs `db:migrate` and `db:seed` as child
// processes (reusing their own scripts, not a copy of their logic) so a developer
// gets back to a known-good, fully migrated and seeded database in one command.
//
// Connection for the drop step: DATABASE_URL_MIGRATE (the owner role).
import { spawn } from "node:child_process";
import { join } from "node:path";

import pg from "pg";

import { describeUrl, hostOf, LOCAL_HOSTS, loadEnvLocal, migrateUrl, pgConnectionString, ROOT } from "./env.mjs";

loadEnvLocal();
const url = migrateUrl();
const host = hostOf(url);
if (!LOCAL_HOSTS.has(host)) {
  console.error(`Refusing to run db:reset against a non-local host (${host}). This is a local/test-stack-only command.`);
  process.exit(2);
}

function run(scriptRelativePath) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(ROOT, scriptRelativePath)], { stdio: "inherit", env: process.env });
    child.on("close", (code) => resolve(code ?? 1));
  });
}

const client = new pg.Client({ connectionString: pgConnectionString(url), application_name: "digipost db:reset" });
await client.connect();

try {
  console.log(`db:reset -> ${describeUrl(url)}`);
  console.log("  dropping schemas public, auth, drizzle ...");
  await client.query("drop schema if exists public cascade");
  await client.query("drop schema if exists auth cascade");
  // The migration-tracking schema too (drizzle-orm's migrator creates it,
  // scripts/db/migrate.mjs's MIGRATIONS_TABLE constant): otherwise migrate.mjs
  // would see every migration already recorded as applied and skip re-running them
  // against the freshly emptied public/auth schemas, leaving reset half-done.
  await client.query("drop schema if exists drizzle cascade");
  await client.query("create schema public");
  console.log("  dropped and recreated public; auth/drizzle are recreated by db:migrate");
} catch (err) {
  console.error(`  FAILED: ${err instanceof Error ? err.message : String(err)}`);
  await client.end();
  process.exit(1);
}
await client.end();

const migrateCode = await run("scripts/db/migrate.mjs");
if (migrateCode !== 0) process.exit(migrateCode);

const seedCode = await run("scripts/db/seed.mjs");
process.exit(seedCode);
