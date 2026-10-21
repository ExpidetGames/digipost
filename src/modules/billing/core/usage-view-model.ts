// Pure view-model formatting (no I/O, no `next/*`/`react`): the `/dashboard/billing` page's
// server component calls this once, with numbers already read from the use cases, so the
// "free has no monthly limit, show that correctly, not as 0" rule
// (decisions/0017-billing-tiers-and-packages.md) is proven by a plain unit test, not only
// eyeballed in the UI.
import { TIER_LIMITS, type PackageKey, type Tier } from "./plans";

export type PurchaseListItem = {
  id: string;
  packageKey: PackageKey;
  extraDocuments: number;
  priceEurCents: number;
  /** ISO 8601 - a UI-facing DTO never carries a `Date` (WEBAPP_TEMPLATE_SPEC.md §8). */
  purchasedAt: string;
};

export type UsageViewModel = {
  tier: Tier;
  tierPriceEurCents: number;
  totalDocuments: number;
  storedDocuments: number;
  /** `storedDocuments / totalDocuments`, clamped to `[0, 1]` - safe to feed straight into a
   * progress bar's `value`/`aria-valuenow`. */
  totalRatio: number;
  /** `false` for Free (no monthly limit to raise or approach) - the UI must render "kein
   * monatliches Limit", never a `0`-valued progress bar. */
  hasMonthlyLimit: boolean;
  /** The tier's own base monthly limit (before any package), `null` for Free. */
  monthlyLimit: number | null;
  /** `monthlyLimit + extraMonthlyQuota`, capped by `totalDocuments` (product decisions 5/6),
   * `null` for Free. */
  effectiveMonthlyLimit: number | null;
  createdThisMonth: number;
  /** `createdThisMonth / effectiveMonthlyLimit`, clamped to `[0, 1]`; `null` for Free
   * (`hasMonthlyLimit: false`) - never `0`, which would misleadingly read as "just started". */
  monthlyRatio: number | null;
  /** Sum of package capacity bought for the current period (0 if none). */
  extraMonthlyQuota: number;
  /** Newest first (the repository already orders this way) - the "packages bought this
   * month" list. */
  purchases: PurchaseListItem[];
};

export function buildUsageViewModel(input: {
  tier: Tier;
  storedDocuments: number;
  createdThisMonth: number;
  extraMonthlyQuota: number;
  purchases: readonly { id: string; packageKey: PackageKey; extraDocuments: number; priceEurCents: number; purchasedAt: Date }[];
}): UsageViewModel {
  const limits = TIER_LIMITS[input.tier];
  const hasMonthlyLimit = limits.monthlyDocuments !== null;
  const effectiveMonthlyLimit = hasMonthlyLimit
    ? Math.min(limits.monthlyDocuments! + input.extraMonthlyQuota, limits.totalDocuments)
    : null;

  const totalRatio = limits.totalDocuments > 0 ? Math.min(1, input.storedDocuments / limits.totalDocuments) : 0;
  let monthlyRatio: number | null = null;
  if (effectiveMonthlyLimit !== null) {
    monthlyRatio = effectiveMonthlyLimit > 0 ? Math.min(1, input.createdThisMonth / effectiveMonthlyLimit) : 0;
  }

  return {
    tier: input.tier,
    tierPriceEurCents: limits.priceEurCents,
    totalDocuments: limits.totalDocuments,
    storedDocuments: input.storedDocuments,
    totalRatio,
    hasMonthlyLimit,
    monthlyLimit: limits.monthlyDocuments,
    effectiveMonthlyLimit,
    createdThisMonth: input.createdThisMonth,
    monthlyRatio,
    extraMonthlyQuota: input.extraMonthlyQuota,
    purchases: input.purchases.map((p) => ({
      id: p.id,
      packageKey: p.packageKey,
      extraDocuments: p.extraDocuments,
      priceEurCents: p.priceEurCents,
      purchasedAt: p.purchasedAt.toISOString(),
    })),
  };
}
