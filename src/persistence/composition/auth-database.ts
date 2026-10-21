// Narrow entry (WEBAPP_TEMPLATE_SPEC.md §5.1, src/persistence/README.md's "Entry seams"):
//
//   target   src/persistence/composition/auth-database.ts
//   owner    persistence
//   importer src/platform/auth/server/auth.ts
//   reason   Better Auth's Drizzle adapter needs the Drizzle instance and the raw
//            auth schema object directly for its own adapter; the rest of the
//            persistence graph (use cases, the Unit of Work) does not belong in
//            auth initialization (decisions/0005-better-auth-magic-link-drizzle-adapter.md).
//
// The only file under src/persistence/ besides composition/request-services.ts,
// composition/create-request-services.ts and composition/public-services.ts that
// application code may import.
import "server-only";

import { getDb, type AppDb } from "@/persistence/foundation/client";
import * as authSchema from "@/persistence/schema/auth";

/**
 * The runtime connection (`app_runtime`, `DATABASE_URL`) - the same one every other
 * owner area uses. decisions/0004-three-database-roles.md already grants
 * `app_runtime` full DML on the `auth` schema (src/persistence/sql/grants/grants.sql),
 * so Better Auth's adapter does not need, and this template does not provision, a
 * fourth, auth-specific database role.
 */
export function getAuthDb(): AppDb {
  return getDb();
}

/**
 * The whole `src/persistence/schema/auth.ts` namespace (`user`, `session`, `account`,
 * `verification`, `rateLimit`, and the `authSchema` pgSchema itself) - exactly the
 * shape Better Auth's Drizzle adapter wants for its `schema` option:
 * `drizzleAdapter(getAuthDb(), { provider: "pg", schema: authSchema })`
 * (src/platform/auth/server/auth.ts). Re-exported under the same name; this module
 * never needs the individual table bindings itself.
 */
export { authSchema };
