// Owner: src/modules/billing. Read models for `/dashboard/billing`
// (decisions/0017-billing-tiers-and-packages.md), published through `server.ts` like every
// other module's `server/read-models.ts`.
import "server-only";

import { cache } from "react";

import { buildUsageViewModel, type UsageViewModel } from "@/modules/billing/core/usage-view-model";
import type { Tier } from "@/modules/billing/core/plans";
import { getRequestServices } from "@/persistence/composition/request-services";

/**
 * Everything the "Tarif & Nutzung" page needs: the current tier's usage
 * (`billing.getUsage`), the currently stored document count (`documents.countStored`), and
 * this period's package purchases (`billing.listPurchasesForCurrentPeriod`), combined by the
 * pure `buildUsageViewModel`. `cache()`d per request like every other read model in this
 * repository, since the billing page reads it once but a future page could read it twice in
 * the same request tree.
 */
export const getUsageViewModel = cache(async function getUsageViewModel(workspaceId: string, tier: Tier): Promise<UsageViewModel> {
  const services = getRequestServices();
  const [usage, storedDocuments, purchases] = await Promise.all([
    services.billing.getUsage(workspaceId),
    services.documents.countStored(workspaceId),
    services.billing.listPurchasesForCurrentPeriod(workspaceId),
  ]);

  return buildUsageViewModel({
    tier,
    storedDocuments,
    createdThisMonth: usage.createdThisMonth,
    extraMonthlyQuota: usage.extraMonthlyQuota,
    purchases: purchases.map((p) => ({
      id: p.id,
      packageKey: p.packageKey,
      extraDocuments: p.extraDocuments,
      priceEurCents: p.priceEurCents,
      purchasedAt: p.purchasedAt,
    })),
  });
});
