import { describe, expect, it } from "vitest";

import { findCoverageGaps } from "../core/coverage";

describe("findCoverageGaps", () => {
  it("finds no gap for back-to-back statements", () => {
    const gaps = findCoverageGaps([
      { statementFrom: "2026-01-01", statementTo: "2026-01-31" },
      { statementFrom: "2026-02-01", statementTo: "2026-02-28" },
    ]);
    expect(gaps).toEqual([]);
  });

  it("finds a gap of more than one day between two statements", () => {
    const gaps = findCoverageGaps([
      { statementFrom: "2026-01-01", statementTo: "2026-01-31" },
      { statementFrom: "2026-03-01", statementTo: "2026-03-31" },
    ]);
    expect(gaps).toEqual([{ from: "2026-02-01", to: "2026-02-28" }]);
  });

  it("ignores order in the input (sorts by statementFrom first)", () => {
    const gaps = findCoverageGaps([
      { statementFrom: "2026-03-01", statementTo: "2026-03-31" },
      { statementFrom: "2026-01-01", statementTo: "2026-01-31" },
    ]);
    expect(gaps).toEqual([{ from: "2026-02-01", to: "2026-02-28" }]);
  });

  it("ignores a batch missing either date", () => {
    const gaps = findCoverageGaps([{ statementFrom: "2026-01-01", statementTo: null }, { statementFrom: null, statementTo: "2026-03-31" }]);
    expect(gaps).toEqual([]);
  });

  it("returns no gaps for a single statement", () => {
    expect(findCoverageGaps([{ statementFrom: "2026-01-01", statementTo: "2026-01-31" }])).toEqual([]);
  });
});
