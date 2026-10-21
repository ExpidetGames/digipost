import { describe, expect, it } from "vitest";

import { createFakePaymentArbiter } from "../core/fake-payment-arbiter";
import { validateArbiterResult } from "../core/arbiter";
import type { MatchableDocument, MatchableTransaction } from "../core/types";

function tx(overrides: Partial<MatchableTransaction> = {}): MatchableTransaction {
  return {
    id: "tx-1",
    bookingDate: "2026-09-15",
    amountCents: -10_000,
    currency: "EUR",
    counterpartyName: "Musterwerk GmbH",
    counterpartyIban: "DE12345678901234567890",
    remittanceText: null,
    endToEndId: null,
    accountId: "acct-1",
    ...overrides,
  };
}

function doc(overrides: Partial<MatchableDocument> = {}): MatchableDocument {
  return {
    id: "doc-1",
    direction: "incoming",
    invoiceNumber: "RE-2026-00001",
    totalAmountCents: 10_000,
    currency: "EUR",
    documentDate: "2026-09-01",
    dueDate: null,
    paymentIban: null,
    contactId: "contact-1",
    contactIban: null,
    contactName: "Musterwerk GmbH",
    openAmountCents: 10_000,
    ...overrides,
  };
}

describe("createFakePaymentArbiter", () => {
  it("is deterministic across repeated calls with the same input", async () => {
    const arbiter = createFakePaymentArbiter();
    const input = { transaction: tx(), candidates: [doc()] };
    const first = await arbiter.rank(input);
    const second = await arbiter.rank(input);
    expect(first).toEqual(second);
  });

  it("returns null when there are no candidates", async () => {
    const arbiter = createFakePaymentArbiter();
    const result = await arbiter.rank({ transaction: tx(), candidates: [] });
    expect(result.bestDocumentId).toBeNull();
  });

  it("picks the candidate whose invoice number is in the remittance text over a closer-amount one without it", async () => {
    const arbiter = createFakePaymentArbiter();
    const withInvoiceNumber = doc({ id: "with-invoice-number", openAmountCents: 10_500 });
    const closerAmountNoInvoice = doc({ id: "closer-amount", invoiceNumber: "RE-2026-99999", openAmountCents: 10_000 });
    const result = await arbiter.rank({ transaction: tx({ remittanceText: "RE-2026-00001" }), candidates: [closerAmountNoInvoice, withInvoiceNumber] });
    expect(result.bestDocumentId).toBe("with-invoice-number");
  });

  it("returns null when no candidate is within 25% of the paid amount", async () => {
    const arbiter = createFakePaymentArbiter();
    const result = await arbiter.rank({ transaction: tx(), candidates: [doc({ openAmountCents: 100_000 })] });
    expect(result.bestDocumentId).toBeNull();
  });

  it("its output always survives validateArbiterResult when the pick is direction-compatible", async () => {
    const arbiter = createFakePaymentArbiter();
    const candidates = [doc()];
    const raw = await arbiter.rank({ transaction: tx({ remittanceText: "RE-2026-00001" }), candidates });
    const validated = validateArbiterResult(raw, { transaction: tx({ remittanceText: "RE-2026-00001" }), candidates });
    expect(validated).not.toBeNull();
    expect(validated!.autoConfirm).toBe(false);
  });
});
