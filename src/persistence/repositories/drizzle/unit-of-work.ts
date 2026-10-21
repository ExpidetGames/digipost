// The `UnitOfWork` implementation (WEBAPP_TEMPLATE_SPEC.md §5.3). This template runs
// decisions/0004-three-database-roles.md's TARGET model directly: `db` is the
// runtime connection (`app_runtime`, real grants), so there is no role switch to
// perform: `transaction` is a thin wrapper around Drizzle's own `db.transaction`,
// handing the transaction-bound repositories to `work` instead of the raw `tx`
// handle (use cases never see a `tx`/`DbExecutor`, WEBAPP_TEMPLATE_SPEC.md §5.1).
import "server-only";

import type { AppDb } from "@/persistence/foundation/client";
import type { UnitOfWork } from "@/persistence/repositories/contracts";

import { createDrizzleRepositories } from "./create-repositories";

export function createDrizzleUnitOfWork(db: AppDb): UnitOfWork {
  return {
    transaction: (work) => db.transaction((tx) => work(createDrizzleRepositories(tx))),
  };
}
