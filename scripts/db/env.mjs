#!/usr/bin/env node
// Shared helpers for scripts/db/*.mjs (plain Node, only `pg` as a real dependency).
//
// - loadEnvLocal(): reads `.env.local` (never `.env.production*` - see
//   WEBAPP_TEMPLATE_SPEC.md §9 and decisions/0008's sibling ADRs for why that file
//   must never exist) and sets every variable that is not already present in
//   process.env (CI / the Docker test stack set the environment directly).
// - migrateUrl(): DATABASE_URL_MIGRATE, or throws.
// - describeUrl(url) / pgConnectionString(url): logging and a verified-TLS
//   connection string, never printing a password.
// - LOCAL_HOSTS / isLocalHost(url): the allowlist a migration host is checked
//   against (WEBAPP_TEMPLATE_SPEC.md §5.7 "refuse non-local host").
// - confirmRemoteHost(url, opts): the "--remote plus confirmation, or
//   --expect-host=<host> in CI" guard scripts/db/migrate.mjs uses; also used
//   (host-only, no override) by seed.mjs/reset.mjs, which never runs remote.

import { existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Hosts a migration/seed/reset may run against without any extra confirmation. */
export const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "postgres"]);

/** Minimal dotenv parser: KEY=VALUE, optional `export `, quotes, `#` comments. */
export function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2];
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.lastIndexOf(quote) > 0) {
      value = value.slice(1, value.lastIndexOf(quote));
      if (quote === '"') value = value.replace(/\\n/g, "\n").replace(/\\"/g, '"');
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    out[m[1]] = value;
  }
  return out;
}

export function loadEnvLocal() {
  const file = join(ROOT, ".env.local");
  if (!existsSync(file)) return;
  for (const [key, value] of Object.entries(parseEnv(readFileSync(file, "utf8")))) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export function migrateUrl() {
  const url = process.env.DATABASE_URL_MIGRATE;
  if (!url) throw new Error("DATABASE_URL_MIGRATE is not set (and not in .env.local)");
  return url;
}

/**
 * `pg` treats `sslmode=prefer|require|verify-ca` as `verify-full` anyway and prints
 * a deprecation warning for the first three; spell it out to keep the behavior
 * (verified TLS) without the noise. A connection string without `sslmode`
 * (local/Docker Postgres) is left untouched.
 */
export function pgConnectionString(url) {
  return url.replace(/([?&]sslmode=)(prefer|require|verify-ca)(?=&|$)/, "$1verify-full");
}

/** Host (and database) of a connection string, for logging - never the password. */
export function describeUrl(url) {
  try {
    const u = new URL(url);
    return `${u.username}@${u.hostname}${u.pathname}`;
  } catch {
    return "<unparseable connection string>";
  }
}

export function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function isLocalHost(url) {
  return LOCAL_HOSTS.has(hostOf(url));
}

/**
 * Refuses a non-local host unless explicitly overridden (WEBAPP_TEMPLATE_SPEC.md
 * §5.7): local hosts (`LOCAL_HOSTS`) always proceed. A non-local host requires
 * `--remote`, plus either `--expect-host=<host>` (CI: aborts unless it matches the
 * URL's host exactly - a swapped secret then never migrates the wrong database) or,
 * interactively, typing the hostname back to confirm. Exits the process on refusal;
 * does nothing (returns) when the host is local or the confirmation succeeds.
 *
 * @param {string} url
 * @param {{ argv: string[]; what: string }} opts
 */
export async function guardHost(url, { argv, what }) {
  const host = hostOf(url);
  if (LOCAL_HOSTS.has(host)) return;

  if (!argv.includes("--remote")) {
    console.error(`Refusing to run ${what} against a non-local host (${host}).`);
    console.error("Pass --remote to confirm this is intentional (plus --expect-host=<host> in CI).");
    process.exit(2);
  }

  const expectHostArg = argv.find((a) => a.startsWith("--expect-host="));
  if (expectHostArg) {
    const expected = expectHostArg.slice("--expect-host=".length).toLowerCase();
    if (expected !== host) {
      console.error(`--expect-host=${expected} does not match the connection string's host (${host}). Aborting.`);
      process.exit(2);
    }
    return;
  }

  if (!process.stdin.isTTY) {
    console.error(
      `Refusing to run ${what} against a non-local host (${host}) non-interactively without --expect-host=<host>.`,
    );
    process.exit(2);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`About to run ${what} against ${host}. Type the hostname to confirm: `);
    if (answer.trim().toLowerCase() !== host) {
      console.error("Hostname did not match. Aborting.");
      process.exit(2);
    }
  } finally {
    rl.close();
  }
}

export function formatPgError(err, sqlText) {
  const parts = [err.message];
  if (err.code) parts.push(`SQLSTATE ${err.code}`);
  const line = sqlText && err.position ? sqlText.slice(0, Number(err.position) - 1).split("\n").length : null;
  if (line) parts.push(`line ${line}`);
  if (err.detail) parts.push(`detail: ${err.detail}`);
  if (err.hint) parts.push(`hint: ${err.hint}`);
  if (err.where) parts.push(`where: ${err.where}`);
  return parts.join(" | ");
}
