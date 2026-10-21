// Owner: src/modules/billing. Single source of truth for the tier and one-off package
// tables (architecture brief's product decisions, table "Tiers"): every other owner that
// needs a tier's limits or a package's contents imports from here, never re-declares them.
// `src/persistence/schema/workspaces.ts` imports `TIERS`/`Tier` from this file for its
// `workspaces.tier` column enum (persistence may import modules, WEBAPP_TEMPLATE_SPEC.md
// §4's direction matrix) instead of the other way around, so this stays the one place the
// tier list is written.
//
// Pure, no I/O, no `next/*`/`react` import: `evaluateQuota` is deterministic business logic,
// testable with plain function calls (WEBAPP_TEMPLATE_SPEC.md §10.2).

export const TIERS = ["free", "starter", "pro", "unlimited"] as const;
export type Tier = (typeof TIERS)[number];

export type TierLimits = {
  /** Total documents allowed to be stored at once (product decision 1: deleting frees
   * capacity, so this is compared against the current stored count, not a lifetime total). */
  totalDocuments: number;
  /** Documents that may be *created* in the current calendar month (UTC). `null` means no
   * monthly limit (Free): only the total limit applies. */
  monthlyDocuments: number | null;
  priceEurCents: number;
};

export const TIER_LIMITS: Record<Tier, TierLimits> = {
  free: { totalDocuments: 20, monthlyDocuments: null, priceEurCents: 0 },
  starter: { totalDocuments: 750, monthlyDocuments: 100, priceEurCents: 2900 },
  pro: { totalDocuments: 5000, monthlyDocuments: 500, priceEurCents: 7900 },
  unlimited: { totalDocuments: 200_000, monthlyDocuments: 5000, priceEurCents: 24_900 },
};

export const PACKAGE_KEYS = ["s", "m", "l"] as const;
export type PackageKey = (typeof PACKAGE_KEYS)[number];

export type PackageDefinition = { key: PackageKey; extraDocuments: number; priceCents: number };

/** One-off digitization packages (product decision 5/6): raise the *monthly* limit for the
 * calendar month they were bought in, capped by the tier's total limit (`evaluateQuota`
 * below); never purchasable on Free, which has no monthly limit to raise. */
export const PACKAGES: Record<PackageKey, PackageDefinition> = {
  s: { key: "s", extraDocuments: 250, priceCents: 1900 },
  m: { key: "m", extraDocuments: 1000, priceCents: 5900 },
  l: { key: "l", extraDocuments: 5000, priceCents: 24_900 },
};

export function canPurchasePackages(tier: Tier): boolean {
  return TIER_LIMITS[tier].monthlyDocuments !== null;
}

export const QUOTA_ERROR = {
  totalExceeded: "quota_total_exceeded",
  monthlyExceeded: "quota_monthly_exceeded",
} as const;
export type QuotaErrorCode = (typeof QUOTA_ERROR)[keyof typeof QUOTA_ERROR];

/** `totalRatio`/`monthlyRatio` reflect usage *after* `adding` would be applied (the ratio
 * that would result if this call is allowed) - P3's 80% warning email compares this against
 * 0.8 once per limit per calendar month. `monthlyRatio` is `null` when the tier has no
 * monthly limit (Free). */
export type QuotaEvaluation =
  | { allowed: true; totalRatio: number; monthlyRatio: number | null }
  | { allowed: false; code: QuotaErrorCode; totalRatio: number; monthlyRatio: number | null };

export type EvaluateQuotaInput = {
  tier: Tier;
  /** Documents currently stored in the workspace (any status) - product decision 1. */
  storedDocuments: number;
  /** Documents created in the current calendar month (UTC) - product decision 1. */
  createdThisMonth: number;
  /** Sum of `extraDocuments` from packages purchased for the current period (0 if none). */
  extraMonthlyQuota: number;
  /** How many documents this call would add (always 1 for a single upload today). */
  adding: number;
};

/**
 * Pure quota check (architecture brief's product decisions 1, 5, 6): the total limit is
 * checked first (it gates regardless of tier), then the monthly limit if the tier has one.
 * A package's `extraDocuments` raises the effective monthly limit but never above the
 * tier's total limit ("packages ... capped by total limit").
 */
export function evaluateQuota(input: EvaluateQuotaInput): QuotaEvaluation {
  const limits = TIER_LIMITS[input.tier];

  const totalAfter = input.storedDocuments + input.adding;
  const totalRatio = limits.totalDocuments > 0 ? totalAfter / limits.totalDocuments : 0;

  if (totalAfter > limits.totalDocuments) {
    return { allowed: false, code: QUOTA_ERROR.totalExceeded, totalRatio, monthlyRatio: null };
  }

  if (limits.monthlyDocuments === null) {
    return { allowed: true, totalRatio, monthlyRatio: null };
  }

  const effectiveMonthlyLimit = Math.min(limits.monthlyDocuments + input.extraMonthlyQuota, limits.totalDocuments);
  const monthlyAfter = input.createdThisMonth + input.adding;
  const monthlyRatio = effectiveMonthlyLimit > 0 ? monthlyAfter / effectiveMonthlyLimit : 0;

  if (monthlyAfter > effectiveMonthlyLimit) {
    return { allowed: false, code: QUOTA_ERROR.monthlyExceeded, totalRatio, monthlyRatio };
  }

  return { allowed: true, totalRatio, monthlyRatio };
}

/** First day of `date`'s UTC month, as `YYYY-MM-DD` - the `period` key
 * `workspace_monthly_usage`/`quota_package_purchases` both use (product decision 1: the
 * monthly limit resets on the calendar month, UTC). */
export function periodKeyFor(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}-01`;
}

/** The 80% warning threshold (architecture brief: "Warning email to the admin at 80% of
 * either limit, at most once per limit per calendar month",
 * decisions/0017-billing-tiers-and-packages.md). */
export const WARNING_THRESHOLD_RATIO = 0.8;

export type WarningCrossing = { crossedTotal: boolean; crossedMonthly: boolean };

/**
 * Pure "did this upload just cross the 80% threshold for the first time this period"
 * check (decisions/0017-billing-tiers-and-packages.md). `warnedTotalAt`/`warnedMonthlyAt`
 * are the current period's usage row markers (`null` until a warning has actually been
 * sent) - a threshold already crossed once this period (marker non-null) never crosses
 * again, which is what makes "at most once per limit per calendar month" hold even under
 * concurrency: the caller sets the marker in the SAME transaction as this check's result is
 * acted on (`src/persistence/use-cases/billing-use-cases.ts`'s `recordDocumentsCreated`),
 * so two concurrent uploads racing past the threshold can still only enqueue one warning
 * each per limit (the loser of the row-lock race sees the marker already set).
 */
export function evaluateWarningCrossing(input: {
  totalRatio: number;
  monthlyRatio: number | null;
  warnedTotalAt: Date | null;
  warnedMonthlyAt: Date | null;
}): WarningCrossing {
  return {
    crossedTotal: input.totalRatio >= WARNING_THRESHOLD_RATIO && input.warnedTotalAt === null,
    crossedMonthly:
      input.monthlyRatio !== null && input.monthlyRatio >= WARNING_THRESHOLD_RATIO && input.warnedMonthlyAt === null,
  };
}
