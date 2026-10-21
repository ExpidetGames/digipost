import { describe, expect, it } from "vitest";

import { planApplePayoutPairing, planGooglePayoutPairing, type AppStoreReportSummary, type BankCreditCandidate } from "../core/app-store-payout-matching";

function candidate(overrides: Partial<BankCreditCandidate> & Pick<BankCreditCandidate, "transactionId" | "amountCents" | "bookingDate">): BankCreditCandidate {
  return { counterpartyName: null, remittanceText: null, ...overrides };
}

function appleReport(overrides: Partial<AppStoreReportSummary> = {}): AppStoreReportSummary {
  return { documentId: "apple-2025-01", platform: "apple", period: "2025-01", payoutAmountCents: 6151, ...overrides };
}

describe("planApplePayoutPairing", () => {
  it("pairs the real owner data: the January report with the 2025-03-06 credit of 61.51 EUR", () => {
    const report = appleReport();
    const candidates = [
      candidate({ transactionId: "tx-2025-01-02", amountCents: 69, bookingDate: "2025-01-02", counterpartyName: "APPLE DISTRIBUTION INTL LTD" }),
      candidate({ transactionId: "tx-2025-01-30", amountCents: 2082, bookingDate: "2025-01-30", counterpartyName: "Apple Inc" }),
      candidate({ transactionId: "tx-2025-03-06", amountCents: 6151, bookingDate: "2025-03-06", counterpartyName: "Apple Inc" }),
      candidate({ transactionId: "tx-2025-04-03", amountCents: 8815, bookingDate: "2025-04-03", counterpartyName: "Apple Inc" }),
    ];

    const pairing = planApplePayoutPairing(report, candidates);
    expect(pairing).toEqual({ transactionId: "tx-2025-03-06", documentIds: ["apple-2025-01"], totalAmountCents: 6151 });
  });

  it("requires the counterparty name (or remittance text) to name Apple", () => {
    const report = appleReport();
    const candidates = [candidate({ transactionId: "tx-1", amountCents: 6151, bookingDate: "2025-02-15", counterpartyName: "Some Other Company" })];
    expect(planApplePayoutPairing(report, candidates)).toBeNull();
  });

  it("matches via remittance text when the counterparty name does not mention Apple", () => {
    const report = appleReport();
    const candidates = [candidate({ transactionId: "tx-1", amountCents: 6151, bookingDate: "2025-02-15", counterpartyName: "Musterbank SE", remittanceText: "CCI 0304291607,PURPDEVELOPER PROCE Apple" })];
    expect(planApplePayoutPairing(report, candidates)?.transactionId).toBe("tx-1");
  });

  it("rejects a credit booked before the period ends", () => {
    const report = appleReport();
    const candidates = [candidate({ transactionId: "tx-1", amountCents: 6151, bookingDate: "2025-01-15", counterpartyName: "Apple Inc" })];
    expect(planApplePayoutPairing(report, candidates)).toBeNull();
  });

  it("rejects a credit booked more than 120 days after the period ends", () => {
    const report = appleReport();
    const candidates = [candidate({ transactionId: "tx-1", amountCents: 6151, bookingDate: "2025-06-15", counterpartyName: "Apple Inc" })];
    expect(planApplePayoutPairing(report, candidates)).toBeNull();
  });

  it("never pairs when the amount is off by even one cent", () => {
    const report = appleReport();
    const candidates = [candidate({ transactionId: "tx-1", amountCents: 6150, bookingDate: "2025-02-15", counterpartyName: "Apple Inc" })];
    expect(planApplePayoutPairing(report, candidates)).toBeNull();
  });

  it("refuses to pair when two candidates both match exactly (ambiguous)", () => {
    const report = appleReport();
    const candidates = [
      candidate({ transactionId: "tx-1", amountCents: 6151, bookingDate: "2025-02-15", counterpartyName: "Apple Inc" }),
      candidate({ transactionId: "tx-2", amountCents: 6151, bookingDate: "2025-03-01", counterpartyName: "Apple Inc" }),
    ];
    expect(planApplePayoutPairing(report, candidates)).toBeNull();
  });

  it("returns null when there is no candidate at all (not yet paid)", () => {
    expect(planApplePayoutPairing(appleReport(), [])).toBeNull();
  });
});

function googleReport(period: string, payoutAmountCents: number): AppStoreReportSummary {
  return { documentId: `google-${period}`, platform: "google", period, payoutAmountCents };
}

describe("planGooglePayoutPairing", () => {
  it("pairs a single not-yet-covered report with its own exact net", () => {
    const reports = [googleReport("2025-01", 3010)];
    const candidates = [candidate({ transactionId: "tx-1", amountCents: 3010, bookingDate: "2025-02-18", counterpartyName: "Google Payment Ireland Limited" })];

    const pairings = planGooglePayoutPairing(reports, candidates);
    expect(pairings).toEqual([{ transactionId: "tx-1", documentIds: ["google-2025-01"], totalAmountCents: 3010 }]);
  });

  it("pairs a credit that is the sum of two CONSECUTIVE not-yet-paid reports", () => {
    const reports = [googleReport("2025-01", 3010), googleReport("2025-02", 12240)];
    const candidates = [candidate({ transactionId: "tx-1", amountCents: 15250, bookingDate: "2025-03-14", counterpartyName: "Google Payment Ireland Limited" })];

    const pairings = planGooglePayoutPairing(reports, candidates);
    expect(pairings).toEqual([{ transactionId: "tx-1", documentIds: ["google-2025-01", "google-2025-02"], totalAmountCents: 15250 }]);
  });

  it("does not skip a gap month to find a sum (a run must be truly consecutive)", () => {
    // January + March (no February report at all) never form a "consecutive" run, even if
    // their sum happens to equal a candidate's amount.
    const reports = [googleReport("2025-01", 3010), googleReport("2025-03", 12240)];
    const candidates = [candidate({ transactionId: "tx-1", amountCents: 15250, bookingDate: "2025-04-18", counterpartyName: "Google Payment Ireland Limited" })];
    expect(planGooglePayoutPairing(reports, candidates)).toEqual([]);
  });

  it("honestly does not pair January alone when the real credit needs February too", () => {
    // Real-world shape: 30.10 EUR (January's net) is not what the first Google
    // credit (152.50 EUR on 2025-03-14) actually is - with only January uploaded, this must
    // find nothing, not a wrong partial match.
    const reports = [googleReport("2025-01", 3010)];
    const candidates = [candidate({ transactionId: "tx-1", amountCents: 15250, bookingDate: "2025-03-14", counterpartyName: "Google Payment Ireland Limited" })];
    expect(planGooglePayoutPairing(reports, candidates)).toEqual([]);
  });

  it("claims each report at most once across several candidates", () => {
    const reports = [googleReport("2025-01", 100), googleReport("2025-02", 200), googleReport("2025-03", 300)];
    const candidates = [
      candidate({ transactionId: "tx-1", amountCents: 100, bookingDate: "2025-02-10", counterpartyName: "Google Payment Ireland Limited" }),
      candidate({ transactionId: "tx-2", amountCents: 500, bookingDate: "2025-04-10", counterpartyName: "Google Payment Ireland Limited" }),
    ];
    const pairings = planGooglePayoutPairing(reports, candidates);
    expect(pairings).toEqual([
      { transactionId: "tx-1", documentIds: ["google-2025-01"], totalAmountCents: 100 },
      { transactionId: "tx-2", documentIds: ["google-2025-02", "google-2025-03"], totalAmountCents: 500 },
    ]);
  });

  it("rejects a candidate booked before the run's own last period ends", () => {
    const reports = [googleReport("2025-01", 3010)];
    const candidates = [candidate({ transactionId: "tx-1", amountCents: 3010, bookingDate: "2025-01-20", counterpartyName: "Google Payment Ireland Limited" })];
    expect(planGooglePayoutPairing(reports, candidates)).toEqual([]);
  });

  it("ignores a candidate that does not name Google", () => {
    const reports = [googleReport("2025-01", 3010)];
    const candidates = [candidate({ transactionId: "tx-1", amountCents: 3010, bookingDate: "2025-02-18", counterpartyName: "Some Other Company" })];
    expect(planGooglePayoutPairing(reports, candidates)).toEqual([]);
  });
});

// decisions/0049: a real-world case. January (30,10) and February (52,40) belong to a payout
// that also needs December 2024, which is not uploaded, so they stay unexplained; they must not
// block March (80,25) + April (61,35) = 141,60 EUR, the 2025-05-14 credit.
describe("planGooglePayoutPairing with an unexplainable older month", () => {
  const report = (period: string, cents: number) => ({ documentId: period, platform: "google" as const, period, payoutAmountCents: cents });
  const credit = (id: string, bookingDate: string, amountCents: number) => ({ transactionId: id, bookingDate, amountCents, counterpartyName: "Google Payment Ireland Limited", remittanceText: "GG100EF34GH" });
  const reports = [report("2025-01", 3010), report("2025-02", 5240), report("2025-03", 8025), report("2025-04", 6135)];

  it("pairs March + April with the May credit although January and February stay open", () => {
    const pairs = planGooglePayoutPairing(reports, [credit("mar14", "2025-03-14", 15250), credit("may14", "2025-05-14", 14160)]);
    expect(pairs).toEqual([{ transactionId: "may14", documentIds: ["2025-03", "2025-04"], totalAmountCents: 14160 }]);
  });

  it("does not pair a run that ends too long before the credit", () => {
    expect(planGooglePayoutPairing(reports, [credit("aug15", "2025-08-15", 14160)])).toEqual([]);
  });

  it("leaves a credit unexplained when two different runs add up to it", () => {
    const twin = [report("2025-03", 5000), report("2025-04", 5000), report("2025-05", 5000)];
    expect(planGooglePayoutPairing(twin, [credit("jun", "2025-06-16", 5000)])).toEqual([]);
  });
});
