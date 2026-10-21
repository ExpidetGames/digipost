// Owner: src/modules/payments (F4, decisions/0026-platform-settlements.md).
import { describe, expect, it } from "vitest";

import { detectPlatformFromText, isPlatformContactName, looksLikePlatformPayout, reconcileFeeInvoice, textNamesPlatform } from "../core/platform-detection";

describe("textNamesPlatform / detectPlatformFromText", () => {
  it("matches case-insensitively against a legal-entity-style name", () => {
    expect(textNamesPlatform("Stripe Payments Europe, Ltd.", "stripe")).toBe(true);
    expect(textNamesPlatform("PAYPAL (EUROPE) S.A R.L.", "paypal")).toBe(true);
    expect(textNamesPlatform("Musterfirma GmbH", "stripe")).toBe(false);
  });

  it("never matches for null/blank text", () => {
    expect(textNamesPlatform(null, "stripe")).toBe(false);
    expect(textNamesPlatform("", "apple")).toBe(false);
  });

  it("detects the first matching platform, or null for an unrelated name", () => {
    expect(detectPlatformFromText("Apple Distribution International Ltd.")).toBe("apple");
    expect(detectPlatformFromText("Amazon EU S.a.r.l.")).toBe("amazon");
    expect(detectPlatformFromText("Musterfirma GmbH")).toBeNull();
  });

  it("never matches the 'other' platform - it has no keywords by design", () => {
    expect(textNamesPlatform("Some Other Platform Inc.", "other")).toBe(false);
  });
});

describe("looksLikePlatformPayout", () => {
  it("detects a platform from the counterparty name first", () => {
    expect(looksLikePlatformPayout({ counterpartyName: "STRIPE PAYMENTS EUROPE LTD", remittanceText: null })).toBe("stripe");
  });

  it("falls back to the remittance text when the counterparty name does not name a platform", () => {
    expect(looksLikePlatformPayout({ counterpartyName: "Auszahlung", remittanceText: "PAYOUT PAYPAL REF 12345" })).toBe("paypal");
  });

  it("returns null for an ordinary bank transaction naming neither", () => {
    expect(looksLikePlatformPayout({ counterpartyName: "Müller GmbH", remittanceText: "Rechnung 1001" })).toBeNull();
  });
});

describe("isPlatformContactName", () => {
  it("matches a fee invoice's sender contact to its platform", () => {
    expect(isPlatformContactName("Stripe Payments Europe, Ltd.", "stripe")).toBe(true);
    expect(isPlatformContactName("Deutsche Telekom AG", "stripe")).toBe(false);
  });
});

describe("reconcileFeeInvoice", () => {
  it("matches when the fee sum equals the invoice total exactly", () => {
    const result = reconcileFeeInvoice(1234, 1234);
    expect(result).toMatchObject({ matches: true, discrepancyCents: 0 });
  });

  it("matches within the default 3% tolerance either above or below the invoice total", () => {
    // 3% of 10000 = 300 - a 250-cent gap either way should still match.
    expect(reconcileFeeInvoice(10250, 10000).matches).toBe(true);
    expect(reconcileFeeInvoice(9750, 10000).matches).toBe(true);
  });

  it("does not match beyond the tolerance", () => {
    // 3% of 10000 = 300 - a 400-cent gap should not match.
    expect(reconcileFeeInvoice(10400, 10000).matches).toBe(false);
    expect(reconcileFeeInvoice(9600, 10000).matches).toBe(false);
  });

  it("respects a custom tolerance percentage", () => {
    expect(reconcileFeeInvoice(10500, 10000, 10).matches).toBe(true);
    expect(reconcileFeeInvoice(10500, 10000, 1).matches).toBe(false);
  });
});
