import { getTranslations } from "next-intl/server";

import { PACKAGES, TIER_LIMITS, TIERS } from "@/modules/billing";

import { PricingTable, type PricingTierRow } from "./pricing-table";

const NUMBER_FORMAT = new Intl.NumberFormat("de-DE");

const CONTAINER_CLASS = "mx-auto w-full max-w-[1120px] px-5 sm:px-8";

// The tier this phase's brief highlights as "most chosen" in the reference mockup (a design
// decision, not a billing fact): the mid tier with a monthly limit, one step below the
// unlimited plan. Purely presentational (the small accent rule and label on its column),
// never read by `@/modules/billing` or by the quota logic.
const RECOMMENDED_TIER = "pro";

function formatDocumentCount(count: number): string {
  return NUMBER_FORMAT.format(count);
}

function formatEuroAmount(cents: number): string {
  // Every price in `TIER_LIMITS`/`PACKAGES` is a whole-euro amount today (no cents), so a
  // plain integer division is exact; `NUMBER_FORMAT` still gives correct German grouping
  // for the unlimited tier's larger price if that ever changes.
  return NUMBER_FORMAT.format(cents / 100);
}

// Server component: the one place this section imports `@/modules/billing`'s tier/package
// constants (single source of truth, decisions/0015-documents-and-quotas.md) and resolves
// next-intl copy, per WEBAPP_TEMPLATE_SPEC.md §8 ("Server Components zuerst"). Never
// duplicates a price or limit as a literal in this file or in de.json: every number shown
// here is read from `TIER_LIMITS`/`PACKAGES` and only formatted for display.
//
// The section that "carries weight" on a soft `bg-muted` band with a hairline top and bottom
// (decisions/0056-paper-brand.md's layout grammar), rendering `PricingTable`'s four
// collapsed-hairline columns.
export async function PricingSection() {
  const t = await getTranslations("Marketing.pricing");

  const rows: PricingTierRow[] = TIERS.map((tier) => {
    const limits = TIER_LIMITS[tier];
    const priceLabel =
      limits.priceEurCents === 0 ? t("free") : t("perMonth", { price: `${formatEuroAmount(limits.priceEurCents)} €` });
    const totalDocumentsLabel = t("totalDocumentsLabel", { count: formatDocumentCount(limits.totalDocuments) });
    const monthlyDocumentsLabel =
      limits.monthlyDocuments === null
        ? t("monthlyDocumentsNone")
        : t("monthlyDocumentsLabel", { count: formatDocumentCount(limits.monthlyDocuments) });

    return {
      tier,
      tierLabel: t(`tiers.${tier}`),
      priceLabel,
      totalDocumentsLabel,
      monthlyDocumentsLabel,
      recommended: tier === RECOMMENDED_TIER,
    };
  });

  const packagesNote = t("packagesNote", {
    sExtra: formatDocumentCount(PACKAGES.s.extraDocuments),
    sPrice: formatEuroAmount(PACKAGES.s.priceCents),
    mExtra: formatDocumentCount(PACKAGES.m.extraDocuments),
    mPrice: formatEuroAmount(PACKAGES.m.priceCents),
    lExtra: formatDocumentCount(PACKAGES.l.extraDocuments),
    lPrice: formatEuroAmount(PACKAGES.l.priceCents),
  });

  return (
    <section id="pricing" aria-labelledby="pricing-heading" className="scroll-mt-20 border-y border-border bg-muted">
      <div className={`py-20 sm:py-24 ${CONTAINER_CLASS}`}>
        <h2 id="pricing-heading" className="max-w-[34ch] text-[clamp(1.6rem,2.6vw,2.1rem)] text-foreground">
          {t("heading")}
        </h2>
        <p className="mt-3.5 max-w-[50ch] text-muted-foreground">{t("description")}</p>

        <div className="mt-12">
          <PricingTable rows={rows} ctaLabel={t("cta")} ctaHref="/login" recommendedLabel={t("recommended")} />
        </div>

        <div className="mt-8 max-w-[720px] space-y-2 border-t border-border pt-6 text-sm text-muted-foreground">
          <p>{packagesNote}</p>
          <p>{t("hardStopNote")}</p>
          <p>{t("vatNote")}</p>
        </div>
      </div>
    </section>
  );
}
