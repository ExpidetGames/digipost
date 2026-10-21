import { describe, expect, it } from "vitest";

import { decomposeSettlement, matchSettlementLinesToDocuments, type SettlementLine } from "../core/settlement";
import type { MatchableDocument } from "../core/types";

function line(overrides: Partial<SettlementLine> = {}): SettlementLine {
  return {
    grossCents: 10_000,
    feeCents: 300,
    netCents: 9_700,
    invoiceNumber: "RE-2026-00001",
    description: null,
    customerName: "Musterwerk GmbH",
    bookingDate: "2026-09-10",
    ...overrides,
  };
}

function outgoingDoc(overrides: Partial<MatchableDocument> = {}): MatchableDocument {
  return {
    id: "doc-1",
    direction: "outgoing",
    invoiceNumber: "RE-2026-00001",
    totalAmountCents: 10_000,
    currency: "EUR",
    documentDate: "2026-09-08",
    dueDate: null,
    paymentIban: null,
    contactId: "contact-1",
    contactIban: null,
    contactName: "Musterwerk GmbH",
    openAmountCents: 10_000,
    ...overrides,
  };
}

describe("decomposeSettlement", () => {
  it("balances when gross - fees - refunds equals the actual payout, in cents", () => {
    const lines = [line({ grossCents: 10_000, feeCents: 300 }), line({ grossCents: 5_000, feeCents: 150 })];
    // expected net = 15000 - 450 - 0 = 14550
    const result = decomposeSettlement(lines, 14_550);
    expect(result).toEqual({ grossCents: 15_000, refundCents: 0, feeCents: 450, expectedNetCents: 14_550, discrepancyCents: 0, balanced: true });
  });

  it("splits a negative-gross line out as a refund rather than reducing gross", () => {
    const lines = [line({ grossCents: 10_000, feeCents: 300 }), line({ grossCents: -2_000, feeCents: 0 })];
    const result = decomposeSettlement(lines, 7_700);
    expect(result.grossCents).toBe(10_000);
    expect(result.refundCents).toBe(2_000);
    expect(result.expectedNetCents).toBe(10_000 - 300 - 2_000);
    expect(result.balanced).toBe(true);
  });

  it("treats feeCents as a positive magnitude regardless of the source's own sign", () => {
    const lines = [line({ grossCents: 10_000, feeCents: -300 })];
    const result = decomposeSettlement(lines, 9_700);
    expect(result.feeCents).toBe(300);
    expect(result.balanced).toBe(true);
  });

  it("reports a discrepancy in cents when the payout does not match the computed net", () => {
    const lines = [line({ grossCents: 10_000, feeCents: 300 })];
    const result = decomposeSettlement(lines, 9_600);
    expect(result.expectedNetCents).toBe(9_700);
    expect(result.discrepancyCents).toBe(100);
    expect(result.balanced).toBe(false);
  });

  it("handles an empty line list", () => {
    expect(decomposeSettlement([], 0)).toEqual({ grossCents: 0, refundCents: 0, feeCents: 0, expectedNetCents: 0, discrepancyCents: 0, balanced: true });
  });
});

describe("matchSettlementLinesToDocuments", () => {
  it("matches by invoice number first", () => {
    const result = matchSettlementLinesToDocuments([line({ invoiceNumber: "RE-2026-00001" })], [outgoingDoc()]);
    expect(result).toEqual([{ line: expect.objectContaining({ invoiceNumber: "RE-2026-00001" }), documentId: "doc-1", matchRule: "invoice_number" }]);
  });

  it("matches by invoice number embedded in the description when no dedicated invoiceNumber field is present", () => {
    const result = matchSettlementLinesToDocuments([line({ invoiceNumber: null, description: "Zahlung fuer RE-2026-00001 erhalten" })], [outgoingDoc()]);
    expect(result[0]!.documentId).toBe("doc-1");
    expect(result[0]!.matchRule).toBe("invoice_number");
  });

  it("falls back to customer + amount + date when no invoice number matches", () => {
    const result = matchSettlementLinesToDocuments(
      [line({ invoiceNumber: "UNRELATED", description: null, customerName: "Musterwerk GmbH", grossCents: 10_000, bookingDate: "2026-09-10" })],
      [outgoingDoc({ invoiceNumber: "RE-2026-00099" })],
    );
    expect(result[0]!.documentId).toBe("doc-1");
    expect(result[0]!.matchRule).toBe("customer_amount_date");
  });

  it("does not fall back when the amount does not match", () => {
    const result = matchSettlementLinesToDocuments(
      [line({ invoiceNumber: "UNRELATED", grossCents: 20_000 })],
      [outgoingDoc({ invoiceNumber: "RE-2026-00099" })],
    );
    expect(result[0]!.documentId).toBeNull();
  });

  it("does not fall back when the customer name is unrelated", () => {
    const result = matchSettlementLinesToDocuments(
      [line({ invoiceNumber: "UNRELATED", customerName: "Voellig Anderes Unternehmen" })],
      [outgoingDoc({ invoiceNumber: "RE-2026-00099" })],
    );
    expect(result[0]!.documentId).toBeNull();
  });

  it("does not fall back when the date is outside the window", () => {
    const result = matchSettlementLinesToDocuments(
      [line({ invoiceNumber: "UNRELATED", bookingDate: "2026-01-01" })],
      [outgoingDoc({ invoiceNumber: "RE-2026-00099", documentDate: "2026-09-08" })],
    );
    expect(result[0]!.documentId).toBeNull();
  });

  it("returns documentId null and matchRule null when nothing matches at all", () => {
    const result = matchSettlementLinesToDocuments([line({ invoiceNumber: "GHOST" })], []);
    expect(result).toEqual([{ line: expect.objectContaining({ invoiceNumber: "GHOST" }), documentId: null, matchRule: null }]);
  });
});
