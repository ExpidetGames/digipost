"use client";

import { useTranslations } from "next-intl";

import { canPurchasePackages } from "../core/plans";
import type { UsageViewModel } from "../core/usage-view-model";
import { PurchasePackageForm } from "./purchase-package-form";
import { TierChangeForm } from "./tier-change-form";
import { UsageProgressBar } from "./usage-progress-bar";

/**
 * `/dashboard/billing` ("Tarif & Nutzung", decisions/0017-billing-tiers-and-packages.md).
 * Everyone in the workspace sees the usage numbers; only `canManage` (the caller's own
 * `billing.manage` permission, resolved server-side) sees the tier-change and
 * package-purchase controls, and those controls only render at all when `testModeActive`
 * (no real payment provider exists otherwise - the notice below explains why).
 */
export function BillingPageClient({
  usage,
  canManage,
  testModeActive,
}: {
  usage: UsageViewModel;
  canManage: boolean;
  testModeActive: boolean;
}) {
  const t = useTranslations("Billing");

  return (
    <div className="flex max-w-2xl flex-col gap-8">
      <div>
        <h1 className="text-xl font-semibold text-foreground">{t("heading")}</h1>
        <p className="text-sm text-muted-foreground">{t("description")}</p>
      </div>

      <section className="flex flex-col gap-4 rounded-lg border border-border p-4">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold text-foreground">{t(`tiers.${usage.tier}.name`)}</h2>
          <span className="text-sm text-muted-foreground">{(usage.tierPriceEurCents / 100).toFixed(0)} €/Monat</span>
        </div>

        <UsageProgressBar
          label={t("usage.totalLabel")}
          current={usage.storedDocuments}
          max={usage.totalDocuments}
          unlimitedLabel={t("usage.unlimited")}
        />

        <UsageProgressBar
          label={t("usage.monthlyLabel")}
          current={usage.createdThisMonth}
          max={usage.effectiveMonthlyLimit}
          unlimitedLabel={t("usage.noMonthlyLimit")}
        />

        {usage.hasMonthlyLimit && usage.extraMonthlyQuota > 0 ? (
          <p className="text-xs text-muted-foreground">
            {t("usage.extraMonthlyQuota", { count: usage.extraMonthlyQuota })}
          </p>
        ) : null}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-foreground">{t("purchases.heading")}</h2>
        {usage.purchases.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("purchases.empty")}</p>
        ) : (
          <ul className="flex flex-col gap-2 text-sm">
            {usage.purchases.map((purchase) => (
              <li key={purchase.id} className="flex items-center justify-between rounded-md border border-border px-3 py-2">
                <span>
                  {new Intl.DateTimeFormat("de-DE").format(new Date(purchase.purchasedAt))} -{" "}
                  {t(`packages.${purchase.packageKey}.name`)} (+{purchase.extraDocuments})
                </span>
                <span className="text-muted-foreground">{(purchase.priceEurCents / 100).toFixed(2)} €</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {canManage ? <AdminControls usage={usage} testModeActive={testModeActive} /> : <p className="text-sm text-muted-foreground">{t("memberHint")}</p>}
    </div>
  );
}

/** Only ever rendered for a caller with `billing.manage` (the parent's own `canManage`
 * check) - split out purely to avoid nesting a second ternary inside the first. */
function AdminControls({ usage, testModeActive }: { usage: UsageViewModel; testModeActive: boolean }) {
  const t = useTranslations("Billing");

  if (!testModeActive) {
    return (
      <section className="flex flex-col gap-2 rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
        <p>{t("notConfigured.notice")}</p>
        <p>{t("notConfigured.contactHint")}</p>
      </section>
    );
  }

  return (
    <>
      <section className="flex flex-col gap-3 border-t border-border pt-6">
        <h2 className="text-sm font-semibold text-foreground">{t("tierChange.heading")}</h2>
        <TierChangeForm currentTier={usage.tier} storedDocuments={usage.storedDocuments} />
      </section>

      {canPurchasePackages(usage.tier) ? (
        <section className="flex flex-col gap-3 border-t border-border pt-6">
          <PurchasePackageForm />
        </section>
      ) : (
        <p className="text-sm text-muted-foreground">{t("packages.notAvailableOnFree")}</p>
      )}
    </>
  );
}
