import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  APPLE_PAYMENT_SUMMARY_ERROR,
  ApplePaymentSummaryParseError,
  detectApplePaymentSummary,
  parseApplePaymentSummary,
} from "../core/apple-payment-summary";
import { sniffFileKind } from "../core/file-kind";

function readFixtureText(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");
}

const REAL_REPORT = "apple-payment-summary.csv";

describe("sniffFileKind - the real Apple payment summary", () => {
  it("sniffs as csv despite the title/footer rows' different field counts", () => {
    expect(sniffFileKind(new TextEncoder().encode(readFixtureText(REAL_REPORT)))).toBe("csv");
  });
});

describe("detectApplePaymentSummary", () => {
  it("recognizes the real (German) report", () => {
    expect(detectApplePaymentSummary(readFixtureText(REAL_REPORT))).toBe(true);
  });

  it("does not recognize an unrelated CSV", () => {
    expect(detectApplePaymentSummary("a,b,c\n1,2,3\n")).toBe(false);
  });

  it("does not recognize a title cell with no tab separator", () => {
    expect(detectApplePaymentSummary('"iTunes Connect - Zahlungen und Finanzberichte (Januar, 2025)",,\n,,\nfoo,bar,baz\n')).toBe(false);
  });

  it("does not recognize the right title with a header that no longer matches", () => {
    const mangled = readFixtureText(REAL_REPORT).replace("Verkaufte Einheiten", "Sold Units");
    expect(detectApplePaymentSummary(mangled)).toBe(false);
  });

  it("recognizes a minimal English-guessed variant", () => {
    const english = [
      '"iTunes Connect - Payments and Financial Reports\t(January, 2025)",,,,,,,,,,,',
      ",,,,,,,,,,,",
      "Country or Region (Currency),Units Sold,Customer Price,Partial Balance Before Tax,Tax,Adjustments,Withholding Tax,Total Amount Owed,Exchange Rate,Proceeds,Bank Account Currency,",
      '"Eurozone (EUR)","1","10.00","10.00","0","0","0","10.00","1.00000","10.00","EUR",',
    ].join("\n");
    expect(detectApplePaymentSummary(english)).toBe(true);
  });
});

describe("parseApplePaymentSummary - the real report", () => {
  const result = parseApplePaymentSummary(readFixtureText(REAL_REPORT));

  it("reads the period from the title cell", () => {
    expect(result.period).toBe("2025-01");
  });

  it("reads one line per region with proceeds in the bank currency", () => {
    expect(result.lines).toHaveLength(4);
    expect(result.lines.map((line) => line.grossCents)).toEqual([1145, 3111, 699, 1196]);
    expect(result.lines.map((line) => line.netCents)).toEqual([1145, 3111, 699, 1196]);
    expect(result.lines.every((line) => line.feeCents === null)).toBe(true);
    expect(result.lines.map((line) => line.countryOfSale)).toEqual(["Kanada (CAD)", "Eurozone (EUR)", "Vereinigtes Königreich (GBP)", "Nord- und Südamerika (USD)"]);
    expect(result.lines.map((line) => line.quantity)).toEqual([1, 6, 1, 3]);
    // The report states no per-row date at all - every line is booked on the period's own end
    // date (decisions/0048-app-store-reports.md's documented approximation).
    expect(result.lines.every((line) => line.bookingDate === "2025-01-31")).toBe(true);
  });

  it("reads the stated payout total and currency from the footer", () => {
    expect(result.payoutAmountCents).toBe(6151);
    expect(result.payoutCurrency).toBe("EUR");
  });

  it("the footer total equals the sum of every region's own proceeds", () => {
    const sum = result.lines.reduce((total, line) => total + (line.grossCents ?? 0), 0);
    expect(sum).toBe(result.payoutAmountCents);
  });
});

describe("parseApplePaymentSummary - fallback and error paths", () => {
  it("falls back to the sum of proceeds when the footer is missing", () => {
    const withoutFooter = readFixtureText(REAL_REPORT)
      .split("\n")
      .filter((line) => !line.includes("61.51 EUR") && !line.includes("Ausgezahlt"))
      .join("\n");
    const result = parseApplePaymentSummary(withoutFooter);
    expect(result.payoutAmountCents).toBe(6151);
    expect(result.payoutCurrency).toBe("EUR");
  });

  it("throws not_apple_payment_summary for text that was never recognized", () => {
    expect(() => parseApplePaymentSummary("a,b,c\n1,2,3\n")).toThrowError(ApplePaymentSummaryParseError);
    try {
      parseApplePaymentSummary("a,b,c\n1,2,3\n");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ApplePaymentSummaryParseError);
      expect((err as ApplePaymentSummaryParseError).code).toBe(APPLE_PAYMENT_SUMMARY_ERROR.notRecognized);
    }
  });

  it("throws apple_payment_summary_no_rows for a title/header match with no region rows", () => {
    const titleAndHeaderOnly = [
      '"iTunes Connect - Zahlungen und Finanzberichte\t(Januar, 2025)",,,,,,,,,,,',
      ",,,,,,,,,,,",
      "Land oder Region (Währung),Verkaufte Einheiten,Eingenommen,Teilsaldo vor Steuern,Umsatzsteuer,Anpassungen,Quellensteuer,Geschuldeter Gesamtbetrag,Wechselkurs,Gewinn,Bankkontowährung,",
      ",,,,,,,,,,,",
    ].join("\n");
    try {
      parseApplePaymentSummary(titleAndHeaderOnly);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ApplePaymentSummaryParseError);
      expect((err as ApplePaymentSummaryParseError).code).toBe(APPLE_PAYMENT_SUMMARY_ERROR.noDataRows);
    }
  });
});

// decisions/0053: Apple's own monthly reports do not all carry the same columns. June 2025 has no
// "Teilsaldo vor Steuern" and no "Wechselkurs" at all, July 2025 adds a "Saldo" column. Both were
// rejected by the fixed eleven-column header and imported nothing.
describe("months whose column set differs", () => {
  it("reads a report without the exchange-rate column", () => {
    const result = parseApplePaymentSummary(readFixtureText("apple-payment-summary-no-exchange-rate-column.csv"));
    expect(result.period).toBe("2025-06");
    expect(result.lines).toHaveLength(2);
    expect(result.payoutAmountCents).toBe(4765);
  });

  // decisions/0054: July's payout covers June's returned one, so its "Gewinn" contains June's
  // money as well. Only what July newly earned becomes a line; the stated payout stays whole.
  it("counts only what the month newly earned when a balance was carried over", () => {
    const result = parseApplePaymentSummary(readFixtureText("apple-payment-summary-extra-balance-column.csv"));
    expect(result.period).toBe("2025-07");
    expect(result.lines).toHaveLength(3);
    expect(result.payoutAmountCents).toBe(7025); // the report's own payout total, carried money included
    // Switzerland has no carried balance; the euro zone carried 45,84 of its 66,38; the dollar
    // region carried its whole 2,10 (1,80 at July's rate) and earned nothing new.
    expect(result.lines.map((line) => line.grossCents)).toEqual([207, 2054, 0]);
  });
});
