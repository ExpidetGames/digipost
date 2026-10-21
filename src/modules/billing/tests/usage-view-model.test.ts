// Unit tests for `buildUsageViewModel` (WEBAPP_TEMPLATE_SPEC.md §10.2: pure formatting, no
// I/O). Covers decisions/0017-billing-tiers-and-packages.md's "Free has no monthly limit,
// show that correctly, not as 0" rule and package capacity raising the effective monthly
// limit without ever exceeding the total limit.
import { describe, expect, it } from "vitest";

import { buildUsageViewModel } from "../core/usage-view-model";

describe("buildUsageViewModel", () => {
  it("free tier: no monthly limit at all, not a zero-valued one", () => {
    const vm = buildUsageViewModel({ tier: "free", storedDocuments: 5, createdThisMonth: 42, extraMonthlyQuota: 0, purchases: [] });
    expect(vm.hasMonthlyLimit).toBe(false);
    expect(vm.monthlyLimit).toBeNull();
    expect(vm.effectiveMonthlyLimit).toBeNull();
    expect(vm.monthlyRatio).toBeNull();
    expect(vm.totalDocuments).toBe(20);
    expect(vm.totalRatio).toBeCloseTo(5 / 20);
  });

  it("starter tier with no package: effective monthly limit equals the tier's own", () => {
    const vm = buildUsageViewModel({ tier: "starter", storedDocuments: 10, createdThisMonth: 50, extraMonthlyQuota: 0, purchases: [] });
    expect(vm.hasMonthlyLimit).toBe(true);
    expect(vm.monthlyLimit).toBe(100);
    expect(vm.effectiveMonthlyLimit).toBe(100);
    expect(vm.monthlyRatio).toBeCloseTo(0.5);
  });

  it("a package raises the effective monthly limit but never past the total limit", () => {
    const vm = buildUsageViewModel({
      tier: "starter",
      storedDocuments: 10,
      createdThisMonth: 100,
      extraMonthlyQuota: 15_000,
      purchases: [],
    });
    // starter total limit is 750: 100 (base monthly) + 15000 extra would be 15100, capped at 750.
    expect(vm.effectiveMonthlyLimit).toBe(750);
  });

  it("maps purchases to ISO dates, newest first as given", () => {
    const purchasedAt = new Date("2026-03-05T00:00:00.000Z");
    const vm = buildUsageViewModel({
      tier: "starter",
      storedDocuments: 1,
      createdThisMonth: 1,
      extraMonthlyQuota: 250,
      purchases: [{ id: "p1", packageKey: "s", extraDocuments: 250, priceEurCents: 1900, purchasedAt }],
    });
    expect(vm.purchases).toEqual([
      { id: "p1", packageKey: "s", extraDocuments: 250, priceEurCents: 1900, purchasedAt: purchasedAt.toISOString() },
    ]);
  });

  it("clamps ratios at 1 even when usage somehow exceeds the limit", () => {
    const vm = buildUsageViewModel({ tier: "free", storedDocuments: 25, createdThisMonth: 0, extraMonthlyQuota: 0, purchases: [] });
    expect(vm.totalRatio).toBe(1);
  });
});
