// Owner: src/modules/billing. Encapsulates access only: no quota logic (that is
// `src/modules/billing`'s pure `evaluateQuota`), no transaction management of its own -
// `incrementDocumentsCreated` runs against whatever `db` it is given, which is always the
// transaction-bound executor the caller (`src/persistence/use-cases/documents-use-cases.ts`)
// already holds (WEBAPP_TEMPLATE_SPEC.md §5.3).
import { and, desc, eq, sql } from "drizzle-orm";

import type { DbExecutor } from "@/persistence/foundation/db-types";
import { quotaPackagePurchases, workspaceMonthlyUsage, workspaceTierChanges } from "@/persistence/schema/billing";
import type { BillingRepository } from "@/persistence/repositories/contracts/billing-repository";

export function createDrizzleBillingRepository(db: DbExecutor): BillingRepository {
  return {
    async findMonthlyUsage(workspaceId, period) {
      const [row] = await db
        .select()
        .from(workspaceMonthlyUsage)
        .where(and(eq(workspaceMonthlyUsage.workspaceId, workspaceId), eq(workspaceMonthlyUsage.period, period)))
        .limit(1);
      return row ?? null;
    },

    async incrementDocumentsCreated(workspaceId, period, count) {
      const [row] = await db
        .insert(workspaceMonthlyUsage)
        .values({ workspaceId, period, documentsCreated: count })
        .onConflictDoUpdate({
          target: [workspaceMonthlyUsage.workspaceId, workspaceMonthlyUsage.period],
          set: { documentsCreated: sql`${workspaceMonthlyUsage.documentsCreated} + ${count}` },
        })
        .returning();
      if (!row) throw new Error("upsert into workspace_monthly_usage returned no row");
      return row;
    },

    async sumExtraDocumentsForPeriod(workspaceId, period) {
      const rows = await db
        .select({ extraDocuments: quotaPackagePurchases.extraDocuments })
        .from(quotaPackagePurchases)
        .where(and(eq(quotaPackagePurchases.workspaceId, workspaceId), eq(quotaPackagePurchases.period, period)));
      return rows.reduce((sum, row) => sum + row.extraDocuments, 0);
    },

    listPurchasesForPeriod: (workspaceId, period) =>
      db
        .select()
        .from(quotaPackagePurchases)
        .where(and(eq(quotaPackagePurchases.workspaceId, workspaceId), eq(quotaPackagePurchases.period, period)))
        .orderBy(desc(quotaPackagePurchases.createdAt)),

    async insertPurchase(input) {
      const [row] = await db.insert(quotaPackagePurchases).values(input).returning();
      if (!row) throw new Error("insert into quota_package_purchases returned no row");
      return row;
    },

    async insertTierChange(input) {
      const [row] = await db.insert(workspaceTierChanges).values(input).returning();
      if (!row) throw new Error("insert into workspace_tier_changes returned no row");
      return row;
    },

    async markWarned(workspaceId, period, markers, at) {
      const set: Partial<typeof workspaceMonthlyUsage.$inferInsert> = {};
      if (markers.total) set.warnedTotalAt = at;
      if (markers.monthly) set.warnedMonthlyAt = at;
      if (Object.keys(set).length === 0) return;
      await db
        .update(workspaceMonthlyUsage)
        .set(set)
        .where(and(eq(workspaceMonthlyUsage.workspaceId, workspaceId), eq(workspaceMonthlyUsage.period, period)));
    },

    async clearWarnings(workspaceId, period, markers) {
      const set: Partial<typeof workspaceMonthlyUsage.$inferInsert> = {};
      if (markers.total) set.warnedTotalAt = null;
      if (markers.monthly) set.warnedMonthlyAt = null;
      if (Object.keys(set).length === 0) return;
      await db
        .update(workspaceMonthlyUsage)
        .set(set)
        .where(and(eq(workspaceMonthlyUsage.workspaceId, workspaceId), eq(workspaceMonthlyUsage.period, period)));
    },
  };
}
