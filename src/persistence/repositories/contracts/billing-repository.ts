// Owner: src/modules/billing (architecture brief's product decisions 1, 5, 6). Contracts
// only, no Drizzle import besides type-only schema references.
import type { InferSelectModel } from "drizzle-orm";

import type { quotaPackagePurchases, workspaceMonthlyUsage, workspaceTierChanges } from "@/persistence/schema/billing";

export type WorkspaceMonthlyUsageRow = InferSelectModel<typeof workspaceMonthlyUsage>;
export type QuotaPackagePurchaseRow = InferSelectModel<typeof quotaPackagePurchases>;
export type WorkspaceTierChangeRow = InferSelectModel<typeof workspaceTierChanges>;

export type CreatePurchaseRow = {
  workspaceId: string;
  packageKey: QuotaPackagePurchaseRow["packageKey"];
  extraDocuments: number;
  priceCents: number;
  period: string;
  purchasedByUserId: string;
  provider: QuotaPackagePurchaseRow["provider"];
  providerReference?: string | null;
};

export type CreateTierChangeRow = {
  workspaceId: string;
  previousTier: WorkspaceTierChangeRow["previousTier"];
  newTier: WorkspaceTierChangeRow["newTier"];
  changedByUserId: string;
  provider: WorkspaceTierChangeRow["provider"];
  providerReference?: string | null;
};

/** Which of the two per-period warning markers to set/clear (P3,
 * decisions/0017-billing-tiers-and-packages.md's "at most once per limit per calendar
 * month" rule). Omitted/false leaves that marker untouched. */
export type WarningMarkers = { total?: boolean; monthly?: boolean };

/** One repository, one owner (`src/modules/billing`), matching the three tables in
 * `src/persistence/schema/billing.ts` - all small enough, and always used together
 * (`getUsage` reads two of them, `recordDocumentsCreated`/`changeTier`/`purchasePackage`
 * write one each), to not warrant a separate `Repositories` slot each. */
export interface BillingRepository {
  findMonthlyUsage(workspaceId: string, period: string): Promise<WorkspaceMonthlyUsageRow | null>;
  /** Upserts the `(workspaceId, period)` row, adding `count` to `documentsCreated` (0 if the
   * row does not exist yet). Called inside the caller's own transaction
   * (`src/persistence/use-cases/billing-use-cases.ts`'s `recordDocumentsCreated`). */
  incrementDocumentsCreated(workspaceId: string, period: string, count: number): Promise<WorkspaceMonthlyUsageRow>;
  /** Sum of `extraDocuments` for every package bought for `workspaceId` in `period` (0 if
   * none). */
  sumExtraDocumentsForPeriod(workspaceId: string, period: string): Promise<number>;
  /** Every package purchased for `workspaceId` in `period`, newest first - the "packages
   * bought this month" list on `/dashboard/billing` (P3). */
  listPurchasesForPeriod(workspaceId: string, period: string): Promise<QuotaPackagePurchaseRow[]>;
  /** Inserts one purchase row (P3, `billing-use-cases.ts`'s `purchasePackage`, called inside
   * its own transaction). */
  insertPurchase(input: CreatePurchaseRow): Promise<QuotaPackagePurchaseRow>;
  /** Inserts one tier-change ledger row (P3, `billing-use-cases.ts`'s `changeTier`, called
   * inside its own transaction alongside `WorkspaceRepository.updateTier`). */
  insertTierChange(input: CreateTierChangeRow): Promise<WorkspaceTierChangeRow>;
  /** Sets `warnedTotalAt`/`warnedMonthlyAt` to `at` for whichever of `markers` is true - the
   * "at most once per limit per calendar month" 80% warning rule
   * (decisions/0017-billing-tiers-and-packages.md). A no-op for a period with no usage row
   * yet is not expected here: `recordDocumentsCreated` always upserts the row first. */
  markWarned(workspaceId: string, period: string, markers: WarningMarkers, at: Date): Promise<void>;
  /** Clears (`null`s) `warnedTotalAt`/`warnedMonthlyAt` for whichever of `markers` is true -
   * an upgrade or a package purchase resets the relevant marker so a later crossing warns
   * again. A no-op if the period has no usage row yet (nothing to clear). */
  clearWarnings(workspaceId: string, period: string, markers: WarningMarkers): Promise<void>;
}
