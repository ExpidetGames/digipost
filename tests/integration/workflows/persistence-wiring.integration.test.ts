// Owner-crossing wiring test (WEBAPP_TEMPLATE_SPEC.md §10.1): proves the
// composition root (src/persistence/composition/**) actually connects to real Postgres
// end to end, not just that it type-checks. src/persistence/tests/workspaces-repository.db.test.ts
// covers the `workspaces` repositories' own behavior directly; this test covers the
// layer above it, the part no single owner area's `*.db.test.ts` would catch:
// `getRequestServices()` builds without throwing and its `workspaces` use case (built
// on the real `Repositories`/`UnitOfWork` the composition root wires up) reaches a
// real database, and the public pool (`getPublicDb()`) connects as a genuinely
// different, less-privileged role.
import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { getDb, getPublicDb } from "@/persistence/foundation/client";
import { getRequestServices } from "@/persistence/composition/request-services";
import { user } from "@/persistence/schema/auth";

describe("persistence composition root wiring", () => {
  it("getRequestServices() builds a graph whose workspaces use case commits a real write", async () => {
    const services = getRequestServices();

    const email = `${randomUUID()}@example.test`;
    const { workspace } = await services.workspaces.createForUser({
      userId: await insertTestUser(email),
      name: "Wiring probe GmbH",
    });
    expect(workspace.name).toBe("Wiring probe GmbH");
  });

  it("getPublicDb() connects as a role distinct from the runtime role", async () => {
    const publicDb = getPublicDb();
    const result = await publicDb.execute(sql`select current_user`);
    expect(result.rows[0]?.current_user).toBe("app_public");
  });
});

/** Inserts a throwaway auth.user row so `workspace_members.user_id`'s FK is satisfiable. */
async function insertTestUser(email: string): Promise<string> {
  const [row] = await getDb().insert(user).values({ name: "Wiring Test User", email, emailVerified: false }).returning({ id: user.id });
  if (!row) throw new Error("failed to insert test user fixture");
  return row.id;
}
