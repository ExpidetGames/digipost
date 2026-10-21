import { describe, expect, it } from "vitest";

import { MAX_CANDIDATES, selectCandidateDocuments, selectCandidateTransactions } from "../core/candidates";
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
    contactIban: "DE12345678901234567890",
    contactName: "Musterwerk GmbH",
    openAmountCents: 10_000,
    ...overrides,
  };
}

describe("selectCandidateDocuments", () => {
  it("excludes a document with no open amount left", () => {
    expect(selectCandidateDocuments(tx(), [doc({ openAmountCents: 0 })])).toEqual([]);
  });

  it("never crosses direction", () => {
    expect(selectCandidateDocuments(tx({ amountCents: -10_000 }), [doc({ direction: "outgoing" })])).toEqual([]);
    expect(selectCandidateDocuments(tx({ amountCents: 10_000 }), [doc({ direction: "incoming" })])).toEqual([]);
  });

  it("excludes a document outside the date window", () => {
    const farInThePast = doc({ documentDate: "2026-01-01" });
    expect(selectCandidateDocuments(tx(), [farInThePast], { windowDaysBefore: 30 })).toEqual([]);
  });

  it("never excludes a document with no date at all, regardless of the window", () => {
    const noDate = doc({ documentDate: null, dueDate: null });
    expect(selectCandidateDocuments(tx(), [noDate], { windowDaysBefore: 1, windowDaysAfter: 1 })).toEqual([noDate]);
  });

  it("prefers dueDate over documentDate as the reference date", () => {
    const withDueDate = doc({ documentDate: "2026-01-01", dueDate: "2026-09-14" });
    expect(selectCandidateDocuments(tx(), [withDueDate], { windowDaysBefore: 5, windowDaysAfter: 5 })).toEqual([withDueDate]);
  });

  it("never hard-excludes by amount distance (a much smaller document is still a candidate, e.g. a collective-payment component)", () => {
    const smallDoc = doc({ id: "small", openAmountCents: 500, documentDate: "2026-09-01" });
    expect(selectCandidateDocuments(tx(), [smallDoc])).toEqual([smallDoc]);
  });

  it("bounds the result to maxCandidates (default 20)", () => {
    const documents = Array.from({ length: 30 }, (_, i) => doc({ id: `doc-${i}`, documentDate: "2026-09-10" }));
    const result = selectCandidateDocuments(tx(), documents);
    expect(result.length).toBe(MAX_CANDIDATES);
  });

  it("sorts a same-contact (matching iban) candidate before a closer-amount but different-contact one", () => {
    const sameContact = doc({ id: "same-contact", contactIban: "DE12345678901234567890", openAmountCents: 50_000 });
    const closerAmount = doc({ id: "closer-amount", contactIban: "DE99999999999999999999", contactName: "Anderes Unternehmen", openAmountCents: 10_000 });
    const result = selectCandidateDocuments(tx(), [closerAmount, sameContact]);
    expect(result[0]!.id).toBe("same-contact");
  });

  it("sorts by amount+date closeness when sameContactFirst is disabled", () => {
    const closer = doc({ id: "closer", openAmountCents: 10_000, documentDate: "2026-09-01" });
    const farther = doc({ id: "farther", openAmountCents: 50_000, documentDate: "2026-09-01" });
    const result = selectCandidateDocuments(tx(), [farther, closer], { sameContactFirst: false });
    expect(result[0]!.id).toBe("closer");
  });

  it("deterministic ordering: identical scores are broken by document id", () => {
    const a = doc({ id: "a", documentDate: "2026-09-01" });
    const b = doc({ id: "b", documentDate: "2026-09-01" });
    const result = selectCandidateDocuments(tx(), [b, a], { sameContactFirst: false });
    expect(result.map((d) => d.id)).toEqual(["a", "b"]);
  });
});

describe("selectCandidateTransactions (mirrored direction)", () => {
  it("excludes a platform payout transaction", () => {
    const payoutTx = tx({ isPlatformPayout: true });
    expect(selectCandidateTransactions(doc(), [payoutTx])).toEqual([]);
  });

  it("never crosses direction", () => {
    expect(selectCandidateTransactions(doc({ direction: "incoming" }), [tx({ amountCents: 10_000 })])).toEqual([]);
    expect(selectCandidateTransactions(doc({ direction: "outgoing" }), [tx({ amountCents: -10_000 })])).toEqual([]);
  });

  it("finds a direction-compatible transaction near the document's due date", () => {
    const nearby = tx({ bookingDate: "2026-09-05" });
    expect(selectCandidateTransactions(doc({ dueDate: "2026-09-01" }), [nearby])).toEqual([nearby]);
  });

  it("bounds the result to maxCandidates (default 20)", () => {
    const transactions = Array.from({ length: 30 }, (_, i) => tx({ id: `tx-${i}`, bookingDate: "2026-09-05" }));
    const result = selectCandidateTransactions(doc({ dueDate: "2026-09-01" }), transactions);
    expect(result.length).toBe(MAX_CANDIDATES);
  });
});
