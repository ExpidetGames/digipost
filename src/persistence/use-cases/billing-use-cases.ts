// Owner: src/modules/billing (architecture brief's product decisions 1, 3, 5, 6;
// decisions/0017-billing-tiers-and-packages.md). No `next/*`, `react`,
// `src/platform/*/client`, or a module's own `server.ts`/`client.ts` - this file only ever
// sees `Repositories`/`UnitOfWork` from `src/persistence/repositories/contracts`, the
// injected `PaymentProvider` port, `@/platform/jobs`'s neutral `JOB_KINDS`, and pure logic
// from `@/modules/billing`'s neutral `index.ts` (persistence may import modules,
// WEBAPP_TEMPLATE_SPEC.md §4's direction matrix).
//
// `recordDocumentsCreated` is the one method here that takes an explicit `Repositories`
// argument instead of using `deps.repos`: `src/persistence/use-cases/documents-use-cases.ts`'s
// `createFromUpload` calls it from *inside its own* `uow.transaction(...)` callback, passing
// the transaction-bound `repos` that callback already received, so the usage increment
// commits atomically with the document insert - one transaction, two owners' use cases,
// neither one writing the other's table (`repos.billing` is still this owner's own
// repository; only its implementation touches `workspace_monthly_usage`). It also evaluates
// the 80% warning crossing (`@/modules/billing`'s pure `evaluateWarningCrossing`) in that
// same transaction and, if a threshold is crossed for the first time this period, sets the
// matching `warned*At` marker and enqueues a `send-quota-warning` job right there - so "never
// twice per period" holds even under concurrency (the marker update commits atomically with
// the usage increment, under the same row's lock `documents-use-cases.ts` already holds via
// `workspace.lockForUpdate`).
//
// `changeTier`/`purchasePackage` cross into `src/modules/workspaces`'/`src/platform/jobs`'
// owned tables the same narrow way: `repos.workspace.updateTier` and `repos.jobs.enqueue`
// are each still only ever written to by their own owner's repository implementation: this
// use case only orchestrates *when* they run, inside its own transaction.
import {
  canPurchasePackages,
  evaluateWarningCrossing,
  periodKeyFor,
  TIER_LIMITS,
  TIERS,
  PACKAGES,
  PaymentProviderError,
  type PackageKey,
  type PaymentProvider,
  type Tier,
} from "@/modules/billing";
import type { QuotaPackagePurchaseRow, Repositories, UnitOfWork } from "@/persistence/repositories/contracts";
import { UseCaseError } from "@/persistence/use-cases/errors";
import { JOB_KINDS } from "@/platform/jobs";

export const BILLING_ERROR = {
  notFound: "not_found",
  unknownTier: "unknown_tier",
  unknownPackage: "unknown_package",
  /** A downgrade (or, in principle, an upgrade to a tier whose total limit is somehow
   * lower - never true today, but the check is direction-agnostic) whose `totalDocuments`
   * limit is below the workspace's currently stored document count. The UI already knows
   * both numbers (the page's own usage view model, `TIER_LIMITS`) and renders the German
   * message naming them itself - this code is the stable, data-free signal a downgrade was
   * rejected. */
  downgradeBelowStoredCount: "downgrade_below_stored_count",
  packagesNotAvailableOnFree: "packages_not_available_on_free",
  /** `BILLING_TEST_MODE` is not `true` - `src/modules/billing/core/payment-provider.ts`'s
   * `PaymentProviderError`, rethrown here as a `UseCaseError` so `changeTier`/
   * `purchasePackage` refuse with this stable code even if their Server Action is invoked
   * directly. */
  notConfigured: "billing_not_configured",
} as const;
export type BillingErrorCode = (typeof BILLING_ERROR)[keyof typeof BILLING_ERROR];

export type UsageSummary = {
  /** Documents created in the current calendar month (UTC), 0 if no row exists yet. */
  createdThisMonth: number;
  /** Sum of `extraDocuments` from packages purchased for the current period, 0 if none. */
  extraMonthlyQuota: number;
  period: string;
};

export type PurchaseSummary = {
  id: string;
  packageKey: PackageKey;
  extraDocuments: number;
  priceEurCents: number;
  period: string;
  purchasedAt: Date;
  provider: "test" | "stripe";
};

export type TierChangeSummary = { tier: Tier };

function toPurchaseSummary(row: QuotaPackagePurchaseRow): PurchaseSummary {
  return {
    id: row.id,
    packageKey: row.packageKey as PackageKey,
    extraDocuments: row.extraDocuments,
    priceEurCents: row.priceCents,
    period: row.period,
    purchasedAt: row.createdAt,
    provider: row.provider as "test" | "stripe",
  };
}

/** Translates a thrown `PaymentProviderError` (`@/modules/billing`) into this use case's own
 * `billing_not_configured` `UseCaseError`; anything else propagates unchanged. */
async function withPaymentProvider<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (err) {
    if (err instanceof PaymentProviderError) throw new UseCaseError(err.code);
    throw err;
  }
}

export interface BillingUseCases {
  /** `repos` defaults to the request-scoped `deps.repos`; pass the transaction-bound
   * `Repositories` a `uow.transaction(...)` callback receives to read usage with the same
   * atomicity as `recordDocumentsCreated` below (`src/persistence/use-cases/documents-use-cases.ts`'s
   * `createFromUpload` does both: a first, non-transactional pre-check for the common case,
   * then an authoritative re-check with the locked workspace row and this same `repos`). */
  getUsage(workspaceId: string, now?: Date, repos?: Repositories): Promise<UsageSummary>;
  /** Must run inside the caller's own `uow.transaction(...)` callback - `repos` is that
   * callback's transaction-bound `Repositories`, never `deps.repos`. `totalRatio`/
   * `monthlyRatio` are the same `QuotaEvaluation` ratios `documents-use-cases.ts`'s
   * authoritative in-transaction quota check already computed for this exact upload -
   * passed in rather than recomputed, so this method and the caller's own check never
   * disagree about whether the threshold was crossed. */
  recordDocumentsCreated(
    repos: Repositories,
    input: { workspaceId: string; period: string; count: number; totalRatio: number; monthlyRatio: number | null },
  ): Promise<void>;
  /** Every package purchased for the current calendar month, newest first - the
   * "/dashboard/billing" purchase list (P3). */
  listPurchasesForCurrentPeriod(workspaceId: string, now?: Date): Promise<PurchaseSummary[]>;
  /**
   * Admin-only (enforced by `src/modules/billing/actions.ts`, not here - this is the last
   * line of defense per WEBAPP_TEMPLATE_SPEC.md §5.4). Rejects an unknown tier
   * (`unknown_tier`), a downgrade whose total limit is below the workspace's currently
   * stored document count (`downgrade_below_stored_count`), and - via the injected
   * `PaymentProvider` - refuses entirely when `BILLING_TEST_MODE` is not `true`
   * (`billing_not_configured`). Records the change in `workspace_tier_changes` and resets
   * both warning markers for the current period (a tier change can move either ratio back
   * under 80%, so a later crossing must be able to warn again) in one transaction with the
   * `workspaces.tier` update itself.
   */
  changeTier(input: { workspaceId: string; newTier: Tier; actingUserId: string }): Promise<TierChangeSummary>;
  /**
   * Admin-only (enforced by `src/modules/billing/actions.ts`). Rejects Free
   * (`packages_not_available_on_free` - product decision 6: no monthly limit to raise) and
   * an unknown package key (`unknown_package`); refuses when `BILLING_TEST_MODE` is not
   * `true` (`billing_not_configured`), same as `changeTier`. Resets the monthly warning
   * marker for the current period (buying a package raises the effective monthly limit, so
   * a later crossing against the new, higher limit must be able to warn again).
   */
  purchasePackage(input: { workspaceId: string; packageKey: PackageKey; actingUserId: string }): Promise<PurchaseSummary>;
}

export function createBillingUseCases(deps: {
  repos: Repositories;
  uow: UnitOfWork;
  paymentProvider: PaymentProvider;
  now?: () => Date;
}): BillingUseCases {
  const now = deps.now ?? (() => new Date());

  return {
    async getUsage(workspaceId, at = now(), repos = deps.repos) {
      const period = periodKeyFor(at);
      const [usage, extraMonthlyQuota] = await Promise.all([
        repos.billing.findMonthlyUsage(workspaceId, period),
        repos.billing.sumExtraDocumentsForPeriod(workspaceId, period),
      ]);
      return { createdThisMonth: usage?.documentsCreated ?? 0, extraMonthlyQuota, period };
    },

    async recordDocumentsCreated(repos, { workspaceId, period, count, totalRatio, monthlyRatio }) {
      const usageRow = await repos.billing.incrementDocumentsCreated(workspaceId, period, count);

      const crossing = evaluateWarningCrossing({
        totalRatio,
        monthlyRatio,
        warnedTotalAt: usageRow.warnedTotalAt,
        warnedMonthlyAt: usageRow.warnedMonthlyAt,
      });
      if (!crossing.crossedTotal && !crossing.crossedMonthly) return;

      const warnedAt = now();
      await repos.billing.markWarned(workspaceId, period, { total: crossing.crossedTotal, monthly: crossing.crossedMonthly }, warnedAt);

      if (crossing.crossedTotal) {
        await repos.jobs.enqueue({
          kind: JOB_KINDS.sendQuotaWarning,
          workspaceId,
          payload: { workspaceId, period, limit: "total" } satisfies SendQuotaWarningInput,
        });
      }
      if (crossing.crossedMonthly) {
        await repos.jobs.enqueue({
          kind: JOB_KINDS.sendQuotaWarning,
          workspaceId,
          payload: { workspaceId, period, limit: "monthly" } satisfies SendQuotaWarningInput,
        });
      }
    },

    async listPurchasesForCurrentPeriod(workspaceId, at = now()) {
      const period = periodKeyFor(at);
      const rows = await deps.repos.billing.listPurchasesForPeriod(workspaceId, period);
      return rows.map(toPurchaseSummary);
    },

    async changeTier({ workspaceId, newTier, actingUserId }) {
      if (!TIERS.includes(newTier)) throw new UseCaseError(BILLING_ERROR.unknownTier);

      const workspace = await deps.repos.workspace.findById(workspaceId);
      if (!workspace) throw new UseCaseError(BILLING_ERROR.notFound);
      const previousTier = workspace.tier as Tier;

      const storedCount = await deps.repos.document.countByWorkspace(workspaceId);
      if (storedCount > TIER_LIMITS[newTier].totalDocuments) {
        throw new UseCaseError(BILLING_ERROR.downgradeBelowStoredCount);
      }

      const payment = await withPaymentProvider(() => deps.paymentProvider.changeTier({ workspaceId, newTier }));

      await deps.uow.transaction(async (repos) => {
        await repos.workspace.updateTier(workspaceId, newTier);
        await repos.billing.insertTierChange({
          workspaceId,
          previousTier,
          newTier,
          changedByUserId: actingUserId,
          provider: payment.provider,
          providerReference: payment.providerReference,
        });

        const period = periodKeyFor(now());
        await repos.billing.clearWarnings(workspaceId, period, { total: true, monthly: true });
      });

      return { tier: newTier };
    },

    async purchasePackage({ workspaceId, packageKey, actingUserId }) {
      const workspace = await deps.repos.workspace.findById(workspaceId);
      if (!workspace) throw new UseCaseError(BILLING_ERROR.notFound);
      const tier = workspace.tier as Tier;
      if (!canPurchasePackages(tier)) throw new UseCaseError(BILLING_ERROR.packagesNotAvailableOnFree);

      const pkg = PACKAGES[packageKey];
      if (!pkg) throw new UseCaseError(BILLING_ERROR.unknownPackage);

      const payment = await withPaymentProvider(() => deps.paymentProvider.purchasePackage({ workspaceId, packageKey }));

      const period = periodKeyFor(now());
      const purchase = await deps.uow.transaction(async (repos) => {
        const row = await repos.billing.insertPurchase({
          workspaceId,
          packageKey,
          extraDocuments: pkg.extraDocuments,
          priceCents: pkg.priceCents,
          period,
          purchasedByUserId: actingUserId,
          provider: payment.provider,
          providerReference: payment.providerReference,
        });

        // A package only ever raises the *monthly* effective limit (product decisions 5/6),
        // never the total limit - only the monthly marker needs resetting.
        await repos.billing.clearWarnings(workspaceId, period, { monthly: true });

        return row;
      });

      return toPurchaseSummary(purchase);
    },
  };
}

/** The `send-quota-warning` job's payload shape (enqueued by `recordDocumentsCreated` above).
 * `src/persistence/composition/job-handlers.ts` reads the document/workspace back at send
 * time - the numbers may have moved on since enqueueing (another document deleted, a
 * package bought), which is fine: the mail reports whatever is true when it actually sends. */
export type SendQuotaWarningInput = { workspaceId: string; period: string; limit: "total" | "monthly" };
