import { describe, expect, it } from "vitest";

import { closingPeriodOptions, currentClosingPeriod, parseClosingPeriod } from "../core/period";

describe("parseClosingPeriod", () => {
  it("parses a month into its real first and last day", () => {
    expect(parseClosingPeriod("2026-01")).toEqual({ kind: "month", value: "2026-01", year: 2026, month: 1, from: "2026-01-01", to: "2026-01-31" });
  });

  it("parses a year into the whole year", () => {
    expect(parseClosingPeriod("2026")).toEqual({ kind: "year", value: "2026", year: 2026, month: null, from: "2026-01-01", to: "2026-12-31" });
  });

  it("knows how long February is, leap year included", () => {
    expect(parseClosingPeriod("2026-02")?.to).toBe("2026-02-28");
    expect(parseClosingPeriod("2024-02")?.to).toBe("2024-02-29");
    expect(parseClosingPeriod("2026-04")?.to).toBe("2026-04-30");
    expect(parseClosingPeriod("2026-12")?.to).toBe("2026-12-31");
  });

  it("rejects anything that is not a period, rather than throwing", () => {
    for (const raw of ["", "   ", "2026-00", "2026-13", "26-01", "2026-1", "2026-01-15", "202X", "1989", "3000", "../etc", null, undefined]) {
      expect(parseClosingPeriod(raw)).toBeNull();
    }
  });

  it("accepts a padded value with surrounding whitespace (a form field, trimmed)", () => {
    expect(parseClosingPeriod(" 2026-07 ")?.value).toBe("2026-07");
  });
});

describe("currentClosingPeriod", () => {
  it("is the month the given day falls in", () => {
    expect(currentClosingPeriod("2026-03-17").value).toBe("2026-03");
    expect(currentClosingPeriod("2026-12-31")).toMatchObject({ value: "2026-12", from: "2026-12-01", to: "2026-12-31" });
  });
});

describe("closingPeriodOptions", () => {
  it("offers the current month first and rolls back over a year boundary", () => {
    const options = closingPeriodOptions("2026-02-10", { months: 4, years: 2 });
    expect(options.months.map((p) => p.value)).toEqual(["2026-02", "2026-01", "2025-12", "2025-11"]);
    expect(options.years.map((p) => p.value)).toEqual(["2026", "2025"]);
  });

  it("only ever offers values the parser accepts", () => {
    const options = closingPeriodOptions("2026-02-10", { months: 36, years: 5 });
    for (const option of [...options.months, ...options.years]) {
      expect(parseClosingPeriod(option.value)).toEqual(option);
    }
  });
});
