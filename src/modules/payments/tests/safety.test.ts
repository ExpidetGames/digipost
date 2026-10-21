import { describe, expect, it } from "vitest";

import { detectDuplicatePayment, reminderAlreadyPaid } from "../core/safety";
import type { MatchableDocument, MatchableTransaction } from "../core/types";

function tx(overrides: Partial<MatchableTransaction> = {}): MatchableTransaction {
  return {
    id: "tx-1",
    bookingDate: "2026-09-15",
    amountCents: -10_000,
    currency: "EUR",
    counterpartyName: "Musterwerk GmbH",
    counterpartyIban: "DE12345678901234567890",
    remittanceText: "RE-2026-00001",
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
    openAmountCents: 0,
    ...overrides,
  };
}

describe("detectDuplicatePayment", () => {
  it("flags a document referenced by two direction-compatible transactions", () => {
    const warnings = detectDuplicatePayment([doc()], [tx({ id: "tx-1" }), tx({ id: "tx-2" })]);
    expect(warnings).toEqual([{ documentId: "doc-1", invoiceNumber: "RE-2026-00001", transactionIds: ["tx-1", "tx-2"] }]);
  });

  it("does not flag a document referenced by only one transaction", () => {
    expect(detectDuplicatePayment([doc()], [tx({ id: "tx-1" })])).toEqual([]);
  });

  it("does not flag a document with no invoice number", () => {
    expect(detectDuplicatePayment([doc({ invoiceNumber: null })], [tx({ id: "tx-1" }), tx({ id: "tx-2" })])).toEqual([]);
  });

  it("does not count a cross-direction transaction as a second reference", () => {
    const warnings = detectDuplicatePayment([doc()], [tx({ id: "tx-1", amountCents: -10_000 }), tx({ id: "tx-2", amountCents: 10_000 })]);
    expect(warnings).toEqual([]);
  });

  it("does not flag a transaction whose remittance text does not name the invoice number", () => {
    expect(detectDuplicatePayment([doc()], [tx({ id: "tx-1" }), tx({ id: "tx-2", remittanceText: "unrelated" })])).toEqual([]);
  });
});

describe("reminderAlreadyPaid", () => {
  it("returns true when the same invoice number + contact already has openAmountCents 0", () => {
    const paidInvoice = doc({ id: "invoice-1", openAmountCents: 0 });
    expect(reminderAlreadyPaid({ invoiceNumber: "RE-2026-00001", contactId: "contact-1" }, [paidInvoice])).toBe(true);
  });

  it("returns false when the invoice is still open", () => {
    const openInvoice = doc({ id: "invoice-1", openAmountCents: 5_000 });
    expect(reminderAlreadyPaid({ invoiceNumber: "RE-2026-00001", contactId: "contact-1" }, [openInvoice])).toBe(false);
  });

  it("returns false when the reminder has no invoice number", () => {
    expect(reminderAlreadyPaid({ invoiceNumber: null, contactId: "contact-1" }, [doc({ openAmountCents: 0 })])).toBe(false);
  });

  it("returns false when the reminder has no contact id", () => {
    expect(reminderAlreadyPaid({ invoiceNumber: "RE-2026-00001", contactId: null }, [doc({ openAmountCents: 0 })])).toBe(false);
  });

  it("returns false when the matching document belongs to a different contact", () => {
    const paidInvoiceOtherContact = doc({ id: "invoice-1", openAmountCents: 0, contactId: "contact-2" });
    expect(reminderAlreadyPaid({ invoiceNumber: "RE-2026-00001", contactId: "contact-1" }, [paidInvoiceOtherContact])).toBe(false);
  });
});
