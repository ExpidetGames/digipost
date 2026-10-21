// Real Postgres (WEBAPP_TEMPLATE_SPEC.md §10.1/§10.3): proves `ping()` actually
// reaches the runtime connection, not just that it type-checks.
import { describe, expect, it } from "vitest";

import { getDb } from "@/persistence/foundation/client";
import { createDrizzleSystemRepository } from "@/persistence/repositories/drizzle/system-repository";

describe("createDrizzleSystemRepository", () => {
  it("ping() resolves against the runtime connection", async () => {
    const repo = createDrizzleSystemRepository(getDb());
    await expect(repo.ping()).resolves.toBeUndefined();
  });
});
