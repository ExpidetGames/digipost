import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { sniffFileKind } from "../core/file-kind";
import { detectGooglePlayEarnings, GOOGLE_PLAY_EARNINGS_ERROR, GooglePlayEarningsParseError, parseGooglePlayEarnings } from "../core/google-play-earnings";

function readFixtureText(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");
}

const REAL_REPORT = "google-play-earnings.csv";

describe("sniffFileKind - the Google Play earnings report", () => {
  it("sniffs as csv despite the quoted 'Jan 5, 2025' comma", () => {
    expect(sniffFileKind(new TextEncoder().encode(readFixtureText(REAL_REPORT)))).toBe("csv");
  });
});

describe("detectGooglePlayEarnings", () => {
  it("recognizes the sample report", () => {
    expect(detectGooglePlayEarnings(readFixtureText(REAL_REPORT))).toBe(true);
  });

  it("does not recognize an unrelated CSV", () => {
    expect(detectGooglePlayEarnings("a,b,c\n1,2,3\n")).toBe(false);
  });

  // decisions/0051: a column this reader never reads may be renamed or dropped (Google does that);
  // a column it does read may not.
  it("still recognizes a header whose unused trailing column is gone", () => {
    expect(detectGooglePlayEarnings(readFixtureText(REAL_REPORT).replace("Promotion ID\n", "\n"))).toBe(true);
  });

  it("does not recognize a header missing a column it reads", () => {
    expect(detectGooglePlayEarnings(readFixtureText(REAL_REPORT).replace("Transaction Type,", ""))).toBe(false);
  });
});

describe("parseGooglePlayEarnings - the sample report", () => {
  const result = parseGooglePlayEarnings(readFixtureText(REAL_REPORT));

  it("has 8 lines (Charge + Google fee per order)", () => {
    expect(result.lines).toHaveLength(8);
  });

  it("reads revenue and fee amounts with their own sign, in Merchant Currency", () => {
    const gross = result.lines.map((line) => line.grossCents).filter((cents): cents is number => cents !== null);
    const fees = result.lines.map((line) => line.feeCents).filter((cents): cents is number => cents !== null);
    expect(gross).toEqual([419, 302, 2016, 1008]);
    expect(fees).toEqual([-63, -45, -302, -151]);
  });

  it("computes the net as the sum of every row's own amount", () => {
    expect(result.netAmountCents).toBe(3184);
  });

  it("reads the merchant currency", () => {
    expect(result.merchantCurrency).toBe("EUR");
  });

  it("resolves the period to the month of the transactions", () => {
    expect(result.period).toBe("2025-01");
  });

  it("reads dates from 2025-01-05 to 2025-01-24", () => {
    const dates = [...new Set(result.lines.map((line) => line.bookingDate))].sort();
    expect(dates[0]).toBe("2025-01-05");
    expect(dates.at(-1)).toBe("2025-01-24");
  });

  it("carries the order id (Description) as chargeId and the product title", () => {
    expect(result.lines[0]!.chargeId).toBe("GPA.3300-1111-2222-30001");
    expect(result.lines[0]!.productName).toBe("Legionshelm (Lateinquiz - Deine Lern-App)");
  });

  it("carries the buyer country", () => {
    expect(result.lines[2]!.countryOfSale).toBe("MX");
  });
});

describe("parseGooglePlayEarnings - error paths", () => {
  it("throws not_google_play_earnings for an unrecognized header", () => {
    try {
      parseGooglePlayEarnings("a,b,c\n1,2,3\n");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(GooglePlayEarningsParseError);
      expect((err as GooglePlayEarningsParseError).code).toBe(GOOGLE_PLAY_EARNINGS_ERROR.notRecognized);
    }
  });

  it("throws google_play_earnings_unparseable_row for a row with an unreadable date", () => {
    const broken = readFixtureText(REAL_REPORT).replace('"Jan 5, 2025"', '"not-a-date"');
    try {
      parseGooglePlayEarnings(broken);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(GooglePlayEarningsParseError);
      expect((err as GooglePlayEarningsParseError).code).toBe(GOOGLE_PLAY_EARNINGS_ERROR.unparseableRow);
    }
  });
});

// decisions/0051: Google renamed columns in November 2025 ("Product id" -> "Package ID",
// "Base Plan ID" -> "Base Plan or Purchase Option ID") and added "Sales Channel". The owner's
// November and December reports were rejected by the exact full-header match and ended up as
// "Sonstiges". Recognition now rests on the columns this reader actually reads.
describe("the November 2025 column renaming", () => {
  const RENAMED_HEADER = "google-play-earnings-2025-11-header.csv";

  it("recognizes the renamed header", () => {
    expect(detectGooglePlayEarnings(readFixtureText(RENAMED_HEADER))).toBe(true);
  });

  it("reads the columns by their own position, not the old fixed order", () => {
    const result = parseGooglePlayEarnings(readFixtureText(RENAMED_HEADER));
    expect(result.period).toBe("2025-11");
    expect(result.lines).toHaveLength(4);
    expect(result.lines.every((line) => line.productName !== null)).toBe(true);
  });

  it("rejects a CSV that is missing one of the columns it reads", () => {
    const header = readFixtureText(RENAMED_HEADER).split("\n")[0]!.replace("Amount (Merchant Currency)", "Amount (Something Else)");
    expect(detectGooglePlayEarnings(`${header}\nx,"Nov 3, 2025",1:00:00 AM PST,,Charge,,T,p,1,s,h,DE,,00000,EUR,1.00,1.0,EUR,1.00`)).toBe(false);
  });
});

// decisions/0052: the owner's 2025 reports contain five row types. "Charge refund" and "Tax"
// produced no settlement line at all and "Google fee refund" was booked as another deduction, so
// the Google clearing account was 60,50 EUR off what the reports actually earned.
describe("every row type ends up in the settlement lines", () => {
  const ALL_TYPES = "google-play-earnings-all-row-types.csv";

  it("puts every non-fee row on the revenue side and keeps the fee sign", () => {
    const result = parseGooglePlayEarnings(readFixtureText(ALL_TYPES));
    const revenueSide = result.lines.filter((line) => line.grossCents !== null);
    const feeSide = result.lines.filter((line) => line.feeCents !== null);
    expect(revenueSide).toHaveLength(4); // Charge, Charge refund, Tax, and the refunded fee
    expect(feeSide).toHaveLength(1); // only Google's own commission is deducted as a fee
    expect(revenueSide.some((line) => (line.grossCents ?? 0) > 0)).toBe(true);
  });

  it("keeps the sum of the lines equal to the report's own net", () => {
    const result = parseGooglePlayEarnings(readFixtureText(ALL_TYPES));
    const sum = result.lines.reduce((total, line) => total + (line.netCents ?? 0), 0);
    expect(sum).toBe(result.netAmountCents);
  });
});
