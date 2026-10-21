"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import { Button } from "@/shared/ui-primitives";

import { purchasePackageAction } from "../actions";
import { PACKAGE_KEYS, PACKAGES, type PackageKey } from "../core/plans";
import type { BillingActionErrorCode } from "../core/error-codes";

/** Admin-only package purchase (`billing.manage`), not shown at all on Free - the parent
 * only renders this when `canPurchasePackages(tier)` is true (P3,
 * decisions/0017-billing-tiers-and-packages.md). Capacity is for the current calendar month
 * only and never raises the total limit - both stated explicitly here, not just implied by
 * the numbers. */
export function PurchasePackageForm() {
  const t = useTranslations("Billing");
  const router = useRouter();
  const [pendingKey, setPendingKey] = useState<PackageKey>();
  const [errorCode, setErrorCode] = useState<BillingActionErrorCode>();
  const [, startTransition] = useTransition();

  function handlePurchase(packageKey: PackageKey) {
    setErrorCode(undefined);
    setPendingKey(packageKey);
    startTransition(async () => {
      const result = await purchasePackageAction({ packageKey });
      setPendingKey(undefined);
      if (result.status === "error") {
        setErrorCode(result.errorCode);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold text-foreground">{t("packages.heading")}</h3>
        <span className="rounded-full bg-accent px-2 py-0.5 text-xs font-semibold uppercase text-accent-foreground">
          {t("testModeBadge")}
        </span>
      </div>
      <p className="text-sm text-muted-foreground">{t("packages.description")}</p>
      <ul className="flex flex-wrap gap-3">
        {PACKAGE_KEYS.map((key) => {
          const pkg = PACKAGES[key];
          return (
            <li key={key} className="flex flex-col gap-2 rounded-lg border border-border p-4 text-sm">
              <span className="font-semibold text-foreground">{t(`packages.${key}.name`)}</span>
              <span className="text-muted-foreground">{t("packages.extraDocuments", { count: pkg.extraDocuments })}</span>
              <span className="text-muted-foreground">{(pkg.priceCents / 100).toFixed(2)} €</span>
              <Button
                type="button"
                size="sm"
                disabled={pendingKey !== undefined}
                aria-busy={pendingKey === key}
                onClick={() => handlePurchase(key)}
              >
                {pendingKey === key ? t("packages.submitPending") : t("packages.submit")}
              </Button>
            </li>
          );
        })}
      </ul>
      {errorCode ? (
        <p role="alert" className="text-sm text-destructive">
          {t(`errors.${errorCode}`)}
        </p>
      ) : null}
    </div>
  );
}
