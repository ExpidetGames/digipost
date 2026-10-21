// Typed in-memory fake for `BillingRepository` (WEBAPP_TEMPLATE_SPEC.md §10.2).
import type {
  BillingRepository,
  QuotaPackagePurchaseRow,
  WorkspaceMonthlyUsageRow,
  WorkspaceTierChangeRow,
} from "@/persistence/repositories/contracts";

export function monthlyUsageRow(
  overrides: Partial<WorkspaceMonthlyUsageRow> & Pick<WorkspaceMonthlyUsageRow, "workspaceId" | "period">,
): WorkspaceMonthlyUsageRow {
  return { documentsCreated: 0, warnedTotalAt: null, warnedMonthlyAt: null, ...overrides };
}

export function packagePurchaseRow(
  overrides: Partial<QuotaPackagePurchaseRow> & Pick<QuotaPackagePurchaseRow, "workspaceId" | "period" | "extraDocuments">,
): QuotaPackagePurchaseRow {
  return {
    id: crypto.randomUUID(),
    packageKey: "s",
    priceCents: 1900,
    purchasedByUserId: crypto.randomUUID(),
    provider: "test",
    providerReference: null,
    createdAt: new Date(0),
    ...overrides,
  };
}

export function tierChangeRow(
  overrides: Partial<WorkspaceTierChangeRow> & Pick<WorkspaceTierChangeRow, "workspaceId" | "previousTier" | "newTier">,
): WorkspaceTierChangeRow {
  return {
    id: crypto.randomUUID(),
    changedByUserId: crypto.randomUUID(),
    provider: "test",
    providerReference: null,
    createdAt: new Date(0),
    ...overrides,
  };
}

export function createFakeBillingRepository(
  usageSeed: WorkspaceMonthlyUsageRow[] = [],
  purchasesSeed: QuotaPackagePurchaseRow[] = [],
): {
  repo: BillingRepository;
  usageState: WorkspaceMonthlyUsageRow[];
  purchasesState: QuotaPackagePurchaseRow[];
  tierChangesState: WorkspaceTierChangeRow[];
} {
  const usage = [...usageSeed];
  const purchases = [...purchasesSeed];
  const tierChanges: WorkspaceTierChangeRow[] = [];

  const repo: BillingRepository = {
    async findMonthlyUsage(workspaceId, period) {
      return usage.find((u) => u.workspaceId === workspaceId && u.period === period) ?? null;
    },

    async incrementDocumentsCreated(workspaceId, period, count) {
      const row = usage.find((u) => u.workspaceId === workspaceId && u.period === period);
      if (row) {
        row.documentsCreated += count;
        return row;
      }
      const created = monthlyUsageRow({ workspaceId, period, documentsCreated: count });
      usage.push(created);
      return created;
    },

    async sumExtraDocumentsForPeriod(workspaceId, period) {
      return purchases
        .filter((p) => p.workspaceId === workspaceId && p.period === period)
        .reduce((sum, p) => sum + p.extraDocuments, 0);
    },

    async listPurchasesForPeriod(workspaceId, period) {
      return purchases
        .filter((p) => p.workspaceId === workspaceId && p.period === period)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    },

    async insertPurchase(input) {
      const row = packagePurchaseRow(input);
      purchases.push(row);
      return row;
    },

    async insertTierChange(input) {
      const row = tierChangeRow(input);
      tierChanges.push(row);
      return row;
    },

    async markWarned(workspaceId, period, markers, at) {
      const row = usage.find((u) => u.workspaceId === workspaceId && u.period === period);
      if (!row) return;
      if (markers.total) row.warnedTotalAt = at;
      if (markers.monthly) row.warnedMonthlyAt = at;
    },

    async clearWarnings(workspaceId, period, markers) {
      const row = usage.find((u) => u.workspaceId === workspaceId && u.period === period);
      if (!row) return;
      if (markers.total) row.warnedTotalAt = null;
      if (markers.monthly) row.warnedMonthlyAt = null;
    },
  };

  return { repo, usageState: usage, purchasesState: purchases, tierChangesState: tierChanges };
}
