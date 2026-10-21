// The only module that knows the driver (WEBAPP_TEMPLATE_SPEC.md §5.2). `pg.Pool` +
// `drizzle-orm/node-postgres`, `casing: "snake_case"` (src/persistence/schema/**'s
// camelCase columns map to the database's snake_case ones automatically; `auth.ts`
// opts every column out of that with an explicit db name, see its header comment,
// since Better Auth's own tables are camelCase in the database too).
//
// Two pools, matching decisions/0004-three-database-roles.md's target model
// exactly (no transition machinery, no role switching):
// - `getDb()`: the runtime connection (`DATABASE_URL`, `app_runtime`). Real
//   grants, no DDL. Used by the whole application: dashboard, Server Actions,
//   Better Auth.
// - `getPublicDb()`: the public connection (`DATABASE_URL_PUBLIC`, `app_public`).
//   Only `src/persistence/foundation/**` and `src/persistence/composition/public-services.ts`
//   (the narrow composition seam, WEBAPP_TEMPLATE_SPEC.md §5.8) may call this.
//   Throws if `DATABASE_URL_PUBLIC` is not configured: a project with no
//   unauthenticated public path yet simply never calls it.
//
// `attachDatabasePool` (`@vercel/functions`) lets a Vercel Fluid Compute instance
// close idle connections before suspending. The `globalThis` singletons survive
// Next's dev-server HMR: a plain module-level variable would leak the previous
// pool's sockets when this module is re-evaluated.
import "server-only";

import { attachDatabasePool } from "@vercel/functions";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { serverEnv } from "@/platform/env/server";
import * as schema from "@/persistence/schema";

function createDb(url: string) {
  const pool = new Pool({
    connectionString: url, // SSL via ?sslmode=require in the connection string
    max: 5,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
  });
  attachDatabasePool(pool);
  return drizzle({ client: pool, schema, casing: "snake_case" });
}

export type AppDb = ReturnType<typeof createDb>;

declare global {
  var __persistenceRuntimeDb: AppDb | undefined;
  var __persistencePublicDb: AppDb | undefined;
}

/** The runtime connection (`DATABASE_URL`, `app_runtime`). */
export function getDb(): AppDb {
  return (globalThis.__persistenceRuntimeDb ??= createDb(serverEnv().DATABASE_URL));
}

/**
 * The public connection (`DATABASE_URL_PUBLIC`, `app_public`): narrow-entry only,
 * see this file's header comment. Throws if the project has not configured an
 * unauthenticated public path yet (`DATABASE_URL_PUBLIC` is optional in
 * `src/platform/env`, WEBAPP_TEMPLATE_SPEC.md §5.8).
 */
export function getPublicDb(): AppDb {
  const url = serverEnv().DATABASE_URL_PUBLIC;
  if (!url) {
    throw new Error(
      "DATABASE_URL_PUBLIC is not set. getPublicDb() is only for unauthenticated public " +
        "paths (decisions/0004-three-database-roles.md); configure DATABASE_URL_PUBLIC " +
        "before adding one.",
    );
  }
  return (globalThis.__persistencePublicDb ??= createDb(url));
}

/** Test hook: drop both memoized instances (`globalThis` survives `vi.resetModules()`). */
export function resetDbForTests(): void {
  globalThis.__persistenceRuntimeDb = undefined;
  globalThis.__persistencePublicDb = undefined;
}
