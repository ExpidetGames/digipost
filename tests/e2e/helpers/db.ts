// Database helpers for e2e setup/teardown (WEBAPP_TEMPLATE_SPEC.md §10.4): e2e
// imports no app code, so this talks to Postgres directly with `pg` - the same
// driver the app uses (decisions/0003), just without going through
// `src/persistence/**`. Uses the owner connection (`DATABASE_URL_MIGRATE`): fixtures
// need to insert directly into `auth."user"`/`auth.session`, which the app itself
// never writes outside Better Auth's own adapter.
import { randomBytes } from "node:crypto";

import { Pool, type QueryResultRow } from "pg";

import { requireEnv } from "./env";

let pool: Pool | undefined;

function ownerPool(): Pool {
  return (pool ??= new Pool({ connectionString: requireEnv("DATABASE_URL_MIGRATE"), max: 5 }));
}

/** Raw query against the owner connection - used by helpers/auth.ts to insert a
 * session row directly (fast sessions, WEBAPP_TEMPLATE_SPEC.md §10.4). */
export async function ownerQuery<T extends QueryResultRow>(text: string, params: unknown[]): Promise<T[]> {
  const result = await ownerPool().query<T>(text, params);
  return result.rows;
}

export function randomSuffix(bytes = 4): string {
  return randomBytes(bytes).toString("hex");
}

/** Unique e-mail address (example.test: nothing is delivered anywhere but Mailpit). */
export function uniqueEmail(label: string): string {
  return `e2e-${label}-${randomSuffix()}@example.test`;
}

export type DbUser = { id: string; email: string };

/** Inserts a user directly (no session) - Better Auth's own tables. */
export async function createDbUser(label: string): Promise<DbUser> {
  const email = uniqueEmail(label);
  const result = await ownerPool().query<{ id: string }>(
    `insert into auth."user" (name, email, "emailVerified") values ($1, $2, true) returning id`,
    [`e2e ${label}`, email],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error(`createDbUser(${label}) returned no row`);
  return { id, email };
}

export async function findUserIdByEmail(email: string): Promise<string | undefined> {
  const result = await ownerPool().query<{ id: string }>(`select id from auth."user" where lower(email) = lower($1)`, [
    email,
  ]);
  return result.rows[0]?.id;
}

/** Deletes a user; `session`/`account` cascade (`src/persistence/schema/auth.ts`'s `onDelete: "cascade"`). */
export async function deleteUserById(id: string | undefined): Promise<void> {
  if (!id) return;
  await ownerPool().query(`delete from auth."user" where id = $1`, [id]);
}

/**
 * Clears Better Auth's database-backed sign-in rate limit (`auth."rateLimit"`,
 * `src/platform/auth/server/auth.ts`'s `MAGIC_LINK_RATE_LIMIT` - 3 requests/60s, keyed by
 * IP). tests/e2e/serial/auth.spec.ts's "login rate limit" test deliberately drains this shared
 * quota to see the "too many" message; call this right after so the quota is fresh
 * again for whatever real magic-link request runs next - notably Playwright's
 * `--repeat-each`, which reruns the whole file back-to-back in the same 60s window
 * (see that test for the full explanation).
 */
export async function clearMagicLinkRateLimit(): Promise<void> {
  await ownerPool().query(`delete from auth."rateLimit"`);
}

/** Closes the pool - call once from a suite's `afterAll` if the process would
 * otherwise hang on an open connection (Playwright itself exits the worker
 * process, so most specs do not need this). */
export async function closeDbPool(): Promise<void> {
  await pool?.end();
  pool = undefined;
}

