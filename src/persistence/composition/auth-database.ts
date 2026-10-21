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

import { and, gt, isNull, sql } from "drizzle-orm";

import { getDb, type AppDb } from "@/persistence/foundation/client";
import * as authSchema from "@/persistence/schema/auth";
import { workspaceInvitations } from "@/persistence/schema/workspaces";

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

/** decisions/0074: what the sign-in gate needs to know about an e-mail address. */
export type SignInEligibility = { hasAccount: boolean; hasPendingInvitation: boolean };

/**
 * decisions/0074-sign-up-by-invitation-only.md: whether `email` already has an account, and
 * whether any workspace holds a pending, unexpired invitation for it. Both compared
 * case-insensitively. A read of `src/modules/workspaces`' own table, never a write (the
 * "read via a join" side of the owner rule); it lives here because `src/platform/auth` may only
 * import this seam.
 */
export async function findSignInEligibility(email: string, now: Date): Promise<SignInEligibility> {
  const db = getDb();
  const normalized = email.trim().toLowerCase();
  const [account] = await db
    .select({ id: authSchema.user.id })
    .from(authSchema.user)
    .where(sql`lower(${authSchema.user.email}) = ${normalized}`)
    .limit(1);
  const [invitation] = await db
    .select({ id: workspaceInvitations.id })
    .from(workspaceInvitations)
    .where(and(sql`lower(${workspaceInvitations.email}) = ${normalized}`, isNull(workspaceInvitations.acceptedAt), gt(workspaceInvitations.expiresAt, now)))
    .limit(1);
  return { hasAccount: account !== undefined, hasPendingInvitation: invitation !== undefined };
}
