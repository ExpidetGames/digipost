import { describe, expect, it } from "vitest";

import { parseClosingPeriod } from "../core/period";
import { buildClosingReport, CLOSING_CHECK_KEYS, type ClosingCheckCounts } from "../core/report";

const period = parseClosingPeriod("2026-01")!;

function counts(overrides: Partial<ClosingCheckCounts> = {}): ClosingCheckCounts {
  return {
    unmatchedTransactions: 0,
    documentsWithoutPayment: 0,
    pendingConfirmation: 0,
    failedProcessing: 0,
    openSuggestions: 0,
    ...overrides,
  };
}

describe("buildClosingReport", () => {
  it("reports every check key, in a stable order, with a link each", () => {
    const report = buildClosingReport(period, counts(), { documents: 3, transactions: 7 });
    expect(report.items.map((item) => item.key)).toEqual([...CLOSING_CHECK_KEYS]);
    for (const item of report.items) expect(item.href).toMatch(/^\/dashboard/);
  });

  // decisions/0066-abschluss-check-and-export.md: the defect this replaced was a
  // period-scoped COUNT opening an all-time LIST. Every link now carries the period as the
  // plain `?from=`/`?to=` range the three target pages accept.
  it("carries the period into every link as a date range", () => {
    const report = buildClosingReport(period, counts(), { documents: 3, transactions: 7 });
    for (const item of report.items) {
      const url = new URL(item.href, "https://example.test");
      expect(url.searchParams.get("from")).toBe("2026-01-01");
      expect(url.searchParams.get("to")).toBe("2026-01-31");
    }
  });

  it("keeps a link's own existing filter when it appends the range", () => {
    const report = buildClosingReport(period, counts(), { documents: 3, transactions: 7 });
    const byKey = new Map(report.items.map((item) => [item.key, item.href]));
    expect(byKey.get("pendingConfirmation")).toBe("/dashboard?intakeStatus=pending_confirmation&from=2026-01-01&to=2026-01-31");
    expect(byKey.get("failedProcessing")).toBe("/dashboard?status=failed&from=2026-01-01&to=2026-01-31");
    expect(byKey.get("unmatchedTransactions")).toBe("/dashboard/finance/zuordnung?from=2026-01-01&to=2026-01-31");
    expect(byKey.get("documentsWithoutPayment")).toBe("/dashboard/finance/offene-posten?from=2026-01-01&to=2026-01-31");
  });

  it("spans the whole year for a year period", () => {
    const year = parseClosingPeriod("2025")!;
    const report = buildClosingReport(year, counts(), { documents: 3, transactions: 7 });
    expect(report.items[0]!.href).toBe("/dashboard/finance/zuordnung?from=2025-01-01&to=2025-12-31");
  });

  it("is complete only when every single count is zero", () => {
    expect(buildClosingReport(period, counts(), { documents: 3, transactions: 7 }).complete).toBe(true);
    for (const key of CLOSING_CHECK_KEYS) {
      const report = buildClosingReport(period, counts({ [key]: 1 }), { documents: 3, transactions: 7 });
      expect(report.complete).toBe(false);
      expect(report.items.find((item) => item.key === key)).toMatchObject({ count: 1, clear: false });
      // Every OTHER item is still clear - one gap never hides the rest.
      expect(report.items.filter((item) => item.key !== key).every((item) => item.clear)).toBe(true);
    }
  });

  it("separates 'nothing is missing' from 'nothing is here' (decisions/0066)", () => {
    const emptyPeriod = buildClosingReport(period, counts(), { documents: 0, transactions: 0 });
    expect(emptyPeriod).toMatchObject({ complete: true, empty: true });

    const realPeriod = buildClosingReport(period, counts(), { documents: 0, transactions: 4 });
    expect(realPeriod).toMatchObject({ complete: true, empty: false });
  });

  it("carries the period and its totals through untouched", () => {
    const report = buildClosingReport(period, counts({ failedProcessing: 2 }), { documents: 11, transactions: 42 });
    expect(report.period).toBe(period);
    expect(report.totals).toEqual({ documents: 11, transactions: 42 });
  });
});
