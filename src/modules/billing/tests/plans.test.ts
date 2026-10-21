// Table-driven unit tests for `evaluateQuota` (WEBAPP_TEMPLATE_SPEC.md §10.2: pure logic,
// no I/O, called directly). Covers every tier, its total/monthly boundaries, and a package
// raising the monthly limit but never past the total limit.
import { describe, expect, it } from "vitest";

import { evaluateQuota, evaluateWarningCrossing, periodKeyFor, QUOTA_ERROR, TIER_LIMITS } from "../core/plans";

describe("evaluateQuota", () => {
  describe("free tier (total limit only, no monthly limit)", () => {
    it("allows the 20th document (19 stored + 1)", () => {
      const result = evaluateQuota({ tier: "free", storedDocuments: 19, createdThisMonth: 0, extraMonthlyQuota: 0, adding: 1 });
      expect(result.allowed).toBe(true);
    });

    it("rejects the 21st document (20 stored + 1) with quota_total_exceeded", () => {
      const result = evaluateQuota({ tier: "free", storedDocuments: 20, createdThisMonth: 0, extraMonthlyQuota: 0, adding: 1 });
      expect(result).toMatchObject({ allowed: false, code: QUOTA_ERROR.totalExceeded });
    });

    it("rejects further still (21 stored + 1)", () => {
      const result = evaluateQuota({ tier: "free", storedDocuments: 21, createdThisMonth: 0, extraMonthlyQuota: 0, adding: 1 });
      expect(result).toMatchObject({ allowed: false, code: QUOTA_ERROR.totalExceeded });
    });

    it("has no monthly limit, however many were created this month", () => {
      const result = evaluateQuota({ tier: "free", storedDocuments: 1, createdThisMonth: 10_000, extraMonthlyQuota: 0, adding: 1 });
      expect(result).toMatchObject({ allowed: true, monthlyRatio: null });
    });
  });

  describe("every other tier's total-limit boundary", () => {
    const tiers = ["starter", "pro", "unlimited"] as const;

    for (const tier of tiers) {
      it(`${tier}: allows exactly at the total limit, rejects one past it`, () => {
        const limit = TIER_LIMITS[tier].totalDocuments;
        const atLimit = evaluateQuota({ tier, storedDocuments: limit - 1, createdThisMonth: 0, extraMonthlyQuota: 0, adding: 1 });
        expect(atLimit.allowed).toBe(true);

        const overLimit = evaluateQuota({ tier, storedDocuments: limit, createdThisMonth: 0, extraMonthlyQuota: 0, adding: 1 });
        expect(overLimit).toMatchObject({ allowed: false, code: QUOTA_ERROR.totalExceeded });
      });
    }
  });

  describe("monthly limit (starter: 100/month, 750 total)", () => {
    it("allows up to the monthly limit", () => {
      const result = evaluateQuota({ tier: "starter", storedDocuments: 1, createdThisMonth: 99, extraMonthlyQuota: 0, adding: 1 });
      expect(result.allowed).toBe(true);
    });

    it("rejects one past the monthly limit with quota_monthly_exceeded", () => {
      const result = evaluateQuota({ tier: "starter", storedDocuments: 1, createdThisMonth: 100, extraMonthlyQuota: 0, adding: 1 });
      expect(result).toMatchObject({ allowed: false, code: QUOTA_ERROR.monthlyExceeded });
    });

    it("a package's extraDocuments raises the effective monthly limit", () => {
      const result = evaluateQuota({ tier: "starter", storedDocuments: 1, createdThisMonth: 150, extraMonthlyQuota: 250, adding: 1 });
      expect(result.allowed).toBe(true);
    });

    it("packages never raise the monthly limit past the tier's total limit", () => {
      // 100 (base) + 15000 (three L packages) would be 15100, but the total limit (750)
      // caps it - createdThisMonth is already at the total limit.
      const result = evaluateQuota({
        tier: "starter",
        storedDocuments: 1,
        createdThisMonth: 750,
        extraMonthlyQuota: 15_000,
        adding: 1,
      });
      // The total check (storedDocuments + adding = 2) passes, but the effective monthly
      // limit is capped at 750, and createdThisMonth + adding (751) exceeds it.
      expect(result).toMatchObject({ allowed: false, code: QUOTA_ERROR.monthlyExceeded });
    });

    it("the total limit is checked first even when the monthly limit alone would allow it", () => {
      const result = evaluateQuota({
        tier: "starter",
        storedDocuments: 750,
        createdThisMonth: 0,
        extraMonthlyQuota: 0,
        adding: 1,
      });
      expect(result).toMatchObject({ allowed: false, code: QUOTA_ERROR.totalExceeded });
    });
  });

  describe("ratios", () => {
    it("reflects usage after the addition, not before", () => {
      const result = evaluateQuota({ tier: "free", storedDocuments: 15, createdThisMonth: 0, extraMonthlyQuota: 0, adding: 1 });
      expect(result.allowed).toBe(true);
      if (result.allowed) expect(result.totalRatio).toBeCloseTo(16 / 20);
    });
  });
});

describe("periodKeyFor", () => {
  it("returns the first day of the UTC month", () => {
    expect(periodKeyFor(new Date("2026-03-15T23:59:59.000Z"))).toBe("2026-03-01");
  });

  it("pads single-digit months", () => {
    expect(periodKeyFor(new Date("2026-01-05T00:00:00.000Z"))).toBe("2026-01-01");
  });
});

describe("evaluateWarningCrossing", () => {
  it("crosses the total threshold at exactly 80%, when not already warned", () => {
    const result = evaluateWarningCrossing({ totalRatio: 0.8, monthlyRatio: null, warnedTotalAt: null, warnedMonthlyAt: null });
    expect(result).toEqual({ crossedTotal: true, crossedMonthly: false });
  });

  it("does not cross just under 80%", () => {
    const result = evaluateWarningCrossing({ totalRatio: 0.79, monthlyRatio: null, warnedTotalAt: null, warnedMonthlyAt: null });
    expect(result.crossedTotal).toBe(false);
  });

  it("never crosses twice: a non-null warnedTotalAt suppresses it even above 80%", () => {
    const result = evaluateWarningCrossing({
      totalRatio: 0.95,
      monthlyRatio: null,
      warnedTotalAt: new Date("2026-03-01T00:00:00.000Z"),
      warnedMonthlyAt: null,
    });
    expect(result.crossedTotal).toBe(false);
  });

  it("crosses the monthly threshold independently of the total one", () => {
    const result = evaluateWarningCrossing({ totalRatio: 0.1, monthlyRatio: 0.85, warnedTotalAt: null, warnedMonthlyAt: null });
    expect(result).toEqual({ crossedTotal: false, crossedMonthly: true });
  });

  it("a null monthlyRatio (Free) never crosses the monthly threshold", () => {
    const result = evaluateWarningCrossing({ totalRatio: 0.95, monthlyRatio: null, warnedTotalAt: null, warnedMonthlyAt: null });
    expect(result.crossedMonthly).toBe(false);
  });

  it("can cross both at once", () => {
    const result = evaluateWarningCrossing({ totalRatio: 0.9, monthlyRatio: 0.9, warnedTotalAt: null, warnedMonthlyAt: null });
    expect(result).toEqual({ crossedTotal: true, crossedMonthly: true });
  });

  it("a reset marker (null again after an upgrade/purchase) allows crossing again", () => {
    const result = evaluateWarningCrossing({ totalRatio: 0.85, monthlyRatio: null, warnedTotalAt: null, warnedMonthlyAt: null });
    expect(result.crossedTotal).toBe(true);
  });
});
