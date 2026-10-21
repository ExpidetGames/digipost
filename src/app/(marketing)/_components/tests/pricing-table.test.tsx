// @vitest-environment jsdom
// No `@testing-library/jest-dom` in this repository's dependencies: presence is asserted via
// `getByText` (throws if missing) rather than `.toBeInTheDocument()`, and the CTA `href` is
// read with `.getAttribute()` rather than `.toHaveAttribute()` (see faq-accordion.test.tsx's
// header comment for the same note).
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { TIER_LIMITS, TIERS } from "@/modules/billing";

import { PricingTable, type PricingTierRow } from "../pricing-table";

afterEach(() => {
  cleanup();
});

/** Builds rows the same way pricing-section.tsx does (formatting only), so this test proves
 * the table renders every tier `@/modules/billing` defines with that tier's own limits -
 * if `TIER_LIMITS` changes, this test's expectations move with it automatically instead of
 * drifting from a hardcoded duplicate. */
function buildRows(): PricingTierRow[] {
  return TIERS.map((tier) => {
    const limits = TIER_LIMITS[tier];
    return {
      tier,
      tierLabel: tier,
      priceLabel: limits.priceEurCents === 0 ? "kostenlos" : `${limits.priceEurCents / 100} EUR pro Monat`,
      totalDocumentsLabel: `${limits.totalDocuments} Dokumente gesamt`,
      monthlyDocumentsLabel:
        limits.monthlyDocuments === null ? "kein monatliches Limit" : `${limits.monthlyDocuments} pro Monat`,
    };
  });
}

describe("PricingTable", () => {
  it("renders one entry per tier, matching that tier's own limits from @/modules/billing", () => {
    const rows = buildRows();
    render(<PricingTable rows={rows} ctaLabel="Kostenlos starten" ctaHref="/login" />);

    expect(TIERS.length).toBeGreaterThan(0);
    for (const tier of TIERS) {
      const limits = TIER_LIMITS[tier];
      expect(screen.getByText(tier)).not.toBeNull();
      expect(screen.getByText(`${limits.totalDocuments} Dokumente gesamt`)).not.toBeNull();
      if (limits.monthlyDocuments === null) {
        expect(screen.getByText("kein monatliches Limit")).not.toBeNull();
      } else {
        expect(screen.getByText(`${limits.monthlyDocuments} pro Monat`)).not.toBeNull();
      }
    }

    expect(screen.getAllByRole("link", { name: "Kostenlos starten" })).toHaveLength(TIERS.length);
  });

  it("links every tier's CTA to the given href", () => {
    render(<PricingTable rows={buildRows()} ctaLabel="Kostenlos starten" ctaHref="/login" />);

    for (const link of screen.getAllByRole("link", { name: "Kostenlos starten" })) {
      expect(link.getAttribute("href")).toBe("/login");
    }
  });
});
