import Link from "next/link";

import { buttonVariants, cn } from "@/shared/ui-primitives";
import type { Tier } from "@/modules/billing";

export type PricingTierRow = {
  tier: Tier;
  tierLabel: string;
  priceLabel: string;
  totalDocumentsLabel: string;
  monthlyDocumentsLabel: string;
  /** Marks the one column that gets the accent top rule and the small "most chosen" label
   * (decisions/0056-paper-brand.md's layout grammar); optional so a caller/test that does not
   * care about the recommendation simply omits it. */
  recommended?: boolean;
};

// Pure presentational (no i18n, no data import of its own): the parent server component
// (pricing-section.tsx) is the single place that reads `@/modules/billing`'s tier constants
// and resolves next-intl copy, then hands this component plain, already-formatted rows -
// keeping this leaf trivially unit-testable against the same constants
// (tests/pricing-table.test.tsx asserts every tier renders with its own limits).
//
// Four collapsed-hairline columns (decisions/0056-paper-brand.md's layout grammar): each
// column is its own bordered box, sharing borders with its neighbor on one row. Two columns
// below 860px, one below 521px.
export function PricingTable({
  rows,
  ctaLabel,
  ctaHref,
  recommendedLabel,
}: {
  rows: PricingTierRow[];
  ctaLabel: string;
  ctaHref: string;
  /** Optional so existing callers/tests that never set `row.recommended` do not need to pass
   * this too; only read when a row's `recommended` flag is set. */
  recommendedLabel?: string;
}) {
  return (
    <ul className="grid grid-cols-1 gap-4 min-[521px]:grid-cols-2 min-[860px]:grid-cols-4 min-[860px]:gap-0">
      {rows.map((row, index) => (
        <li
          key={row.tier}
          className={cn(
            "flex h-full flex-col border border-border bg-background px-6 py-7",
            index > 0 && "min-[860px]:-ml-px",
            row.recommended && "border-t-2 border-t-primary pt-[27px]",
          )}
        >
          {row.recommended && recommendedLabel ? (
            <p className="mb-3.5 flex items-center gap-1.5 text-[0.82rem] text-accent-strong">
              <span aria-hidden="true" className="inline-block size-1.5 rounded-full bg-brand-warm" />
              {recommendedLabel}
            </p>
          ) : null}
          <h3 className="font-heading text-[1.25rem] font-medium text-foreground">{row.tierLabel}</h3>
          <p className="mt-3.5 font-heading text-[2.1rem] font-medium text-foreground">{row.priceLabel}</p>
          <div className="mt-5 space-y-2.5 border-t border-border pt-4 text-sm text-muted-foreground">
            <p>{row.totalDocumentsLabel}</p>
            <p>{row.monthlyDocumentsLabel}</p>
          </div>
          <Link href={ctaHref} className={buttonVariants({ className: "mt-6 w-full justify-center" })}>
            {ctaLabel}
          </Link>
        </li>
      ))}
    </ul>
  );
}
