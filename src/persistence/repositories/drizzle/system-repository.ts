// `select 1` against the runtime connection (WEBAPP_TEMPLATE_SPEC.md §13.4: "die DB
// ist mit der Laufzeit-Rolle erreichbar"). No table, no schema import.
import { sql } from "drizzle-orm";

import type { DbExecutor } from "@/persistence/foundation/db-types";
import type { SystemRepository } from "@/persistence/repositories/contracts/system-repository";

export function createDrizzleSystemRepository(db: DbExecutor): SystemRepository {
  return {
    async ping() {
      await db.execute(sql`select 1`);
    },
  };
}
