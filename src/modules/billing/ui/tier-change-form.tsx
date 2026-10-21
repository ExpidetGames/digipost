"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import { Button } from "@/shared/ui-primitives";

import { changeTierAction } from "../actions";
import { TIERS, TIER_LIMITS, type Tier } from "../core/plans";
import type { BillingActionErrorCode } from "../core/error-codes";

/**
 * Admin-only tier change (`billing.manage`). `storedDocuments` is the workspace's own
 * currently-known count (already loaded for the usage display) - used only to render the
 * German "you have N documents, the new tier's limit is M" message client-side when the
 * server rejects a downgrade (`downgrade_below_stored_count`): the stable error code itself
 * carries no numbers (decisions/0017-billing-tiers-and-packages.md), the UI already has them.
 */
export function TierChangeForm({ currentTier, storedDocuments }: { currentTier: Tier; storedDocuments: number }) {
  const t = useTranslations("Billing");
  const router = useRouter();
  const [selected, setSelected] = useState<Tier>(currentTier);
  const [errorCode, setErrorCode] = useState<BillingActionErrorCode>();
  const [pending, startTransition] = useTransition();

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorCode(undefined);
    startTransition(async () => {
      const result = await changeTierAction({ tier: selected });
      if (result.status === "error") {
        setErrorCode(result.errorCode);
        return;
      }
      router.refresh();
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="flex items-center gap-2 font-medium text-foreground">
            {t("tierChange.label")}
            <span className="rounded-full bg-accent px-2 py-0.5 text-xs font-semibold uppercase text-accent-foreground">
              {t("testModeBadge")}
            </span>
          </span>
          <select
            value={selected}
            onChange={(event) => setSelected(event.target.value as Tier)}
            className="rounded-md border border-input bg-background px-3 py-2 text-sm"
          >
            {TIERS.map((tier) => (
              <option key={tier} value={tier}>
                {t(`tiers.${tier}.name`)} ({(TIER_LIMITS[tier].priceEurCents / 100).toFixed(0)} €/Monat)
              </option>
            ))}
          </select>
        </label>
        <Button type="submit" disabled={pending || selected === currentTier} aria-busy={pending}>
          {pending ? t("tierChange.submitPending") : t("tierChange.submit")}
        </Button>
      </div>

      {errorCode ? (
        <p role="alert" className="text-sm text-destructive">
          {errorCode === "downgrade_below_stored_count"
            ? t("errors.downgrade_below_stored_count", { stored: storedDocuments, limit: TIER_LIMITS[selected].totalDocuments })
            : t(`errors.${errorCode}`)}
        </p>
      ) : null}
    </form>
  );
}
