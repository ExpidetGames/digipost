import { describe, expect, it } from "vitest";

import { DEFAULT_SKONTO_TOLERANCE_PERCENT, isAutoConfirmMatch, isWithinSkontoTolerance, matchByRules } from "../core/rules";
import { MATCH_KINDS, MATCH_REASON_CODES, type MatchableDocument, type MatchableTransaction } from "../core/types";

function tx(overrides: Partial<MatchableTransaction> = {}): MatchableTransaction {
  return {
    id: "tx-1",
    bookingDate: "2026-09-15",
    amountCents: -10_000,
    currency: "EUR",
    counterpartyName: "Musterwerk GmbH",
    counterpartyIban: "DE12345678901234567890",
    remittanceText: "Zahlung RE-2026-00002",
    endToEndId: null,
    accountId: "acct-1",
    ...overrides,
  };
}

function doc(overrides: Partial<MatchableDocument> = {}): MatchableDocument {
  return {
    id: "doc-1",
    direction: "incoming",
    invoiceNumber: "RE-2026-00002",
    totalAmountCents: 10_000,
    currency: "EUR",
    documentDate: "2026-09-01",
    dueDate: "2026-09-20",
    paymentIban: null,
    contactId: "contact-1",
    contactIban: "DE12345678901234567890",
    contactName: "Musterwerk GmbH",
    openAmountCents: 10_000,
    ...overrides,
  };
}

describe("isWithinSkontoTolerance (boundary table)", () => {
  // Invoice open amount 100.00 EUR (10000 cents), default 3% tolerance.
  const invoiceCents = 10_000;

  it.each([
    { discountPercent: 0, expected: true },
    { discountPercent: 1, expected: true },
    { discountPercent: 2.9, expected: true },
    { discountPercent: 3, expected: true },
    { discountPercent: 3.1, expected: false },
    { discountPercent: 5, expected: false },
  ])("a $discountPercent% discount passes=$expected against a 3% tolerance", ({ discountPercent, expected }) => {
    const paidCents = Math.round(invoiceCents * (1 - discountPercent / 100));
    expect(isWithinSkontoTolerance(paidCents, invoiceCents, DEFAULT_SKONTO_TOLERANCE_PERCENT)).toBe(expected);
  });

  it("paying MORE than the open amount is never a skonto match", () => {
    expect(isWithinSkontoTolerance(10_100, invoiceCents, 3)).toBe(false);
  });

  it("an open amount of 0 never passes (nothing left to discount off of)", () => {
    expect(isWithinSkontoTolerance(0, 0, 3)).toBe(false);
  });
});

describe("isAutoConfirmMatch", () => {
  it.each([
    { invoiceNumberFound: true, amountMatchKind: "exact" as const, directionOk: true, expected: true },
    { invoiceNumberFound: true, amountMatchKind: "skonto" as const, directionOk: true, expected: true },
    { invoiceNumberFound: false, amountMatchKind: "exact" as const, directionOk: true, expected: false },
    { invoiceNumberFound: true, amountMatchKind: null, directionOk: true, expected: false },
    { invoiceNumberFound: true, amountMatchKind: "exact" as const, directionOk: false, expected: false },
  ])("invoiceNumberFound=$invoiceNumberFound amountMatchKind=$amountMatchKind directionOk=$directionOk -> $expected", (input) => {
    expect(isAutoConfirmMatch(input)).toBe(input.expected);
  });
});

describe("matchByRules", () => {
  it("exact amount + invoice number in remittance text -> autoConfirm exact suggestion", () => {
    const suggestions = matchByRules(tx(), [doc()]);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({
      documentIds: ["doc-1"],
      transactionIds: ["tx-1"],
      kind: MATCH_KINDS.exact,
      autoConfirm: true,
    });
    expect(suggestions[0]!.reasons).toEqual(
      expect.arrayContaining([MATCH_REASON_CODES.invoiceNumberInRemittance, MATCH_REASON_CODES.amountExact, MATCH_REASON_CODES.ibanMatch, MATCH_REASON_CODES.counterpartyNameMatch]),
    );
  });

  it("skonto amount + invoice number in remittance text -> autoConfirm skonto suggestion", () => {
    const suggestions = matchByRules(tx({ amountCents: -9_800 }), [doc()]);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({ kind: MATCH_KINDS.skonto, autoConfirm: true });
  });

  it("exact amount but NO invoice number, iban match instead -> suggestion, never autoConfirm", () => {
    const suggestions = matchByRules(tx({ remittanceText: "Vielen Dank" }), [doc()]);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({ autoConfirm: false });
  });

  it("amount matches but there is no other signal at all -> no suggestion", () => {
    const suggestions = matchByRules(tx({ remittanceText: "Vielen Dank", counterpartyIban: null, counterpartyName: null }), [doc()]);
    expect(suggestions).toEqual([]);
  });

  it("invoice number found but the amount does not match at all (beyond skonto tolerance) -> no suggestion", () => {
    const suggestions = matchByRules(tx({ amountCents: -5_000 }), [doc()]);
    expect(suggestions).toEqual([]);
  });

  it("direction never crosses: an outgoing (negative) transaction never matches an outgoing document", () => {
    const suggestions = matchByRules(tx({ amountCents: -10_000 }), [doc({ direction: "outgoing" })]);
    expect(suggestions).toEqual([]);
  });

  it("direction never crosses: an incoming (positive) transaction never matches an incoming document", () => {
    const suggestions = matchByRules(tx({ amountCents: 10_000 }), [doc({ direction: "incoming" })]);
    expect(suggestions).toEqual([]);
  });

  it("an incoming (positive) transaction matches an outgoing document", () => {
    const suggestions = matchByRules(tx({ amountCents: 10_000 }), [doc({ direction: "outgoing" })]);
    expect(suggestions).toHaveLength(1);
  });

  it("a zero-amount transaction matches nothing", () => {
    const suggestions = matchByRules(tx({ amountCents: 0 }), [doc()]);
    expect(suggestions).toEqual([]);
  });

  it("a fully paid document (openAmountCents 0) is never suggested again", () => {
    const suggestions = matchByRules(tx(), [doc({ openAmountCents: 0 })]);
    expect(suggestions).toEqual([]);
  });

  it("sorts multiple suggestions by descending confidence", () => {
    const strongDoc = doc({ id: "doc-strong" });
    const weakDoc = doc({ id: "doc-weak", invoiceNumber: "RE-2026-99999", openAmountCents: 10_000, totalAmountCents: 10_000, contactName: "Musterwerk GmbH" });
    const suggestions = matchByRules(tx(), [weakDoc, strongDoc]);
    expect(suggestions.map((s) => s.documentIds[0])).toEqual(["doc-strong", "doc-weak"]);
  });

  it("respects a custom skontoTolerancePercent", () => {
    // 10% discount would fail the default 3% tolerance but pass a 10% one.
    const suggestions = matchByRules(tx({ amountCents: -9_000 }), [doc()], { skontoTolerancePercent: 10 });
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({ kind: MATCH_KINDS.skonto });
  });

  // decisions/0033-contradicting-invoice-number-vetoes-a-match.md
  describe("contradicting invoice number veto", () => {
    it("never produces a suggestion when the remittance text names a different invoice than the candidate's own number", () => {
      // Amount, IBAN, and name would all otherwise match - only the invoice-number
      // contradiction should stop this.
      const suggestions = matchByRules(tx({ remittanceText: "Re Nr. 15" }), [doc({ invoiceNumber: "12" })]);
      expect(suggestions).toEqual([]);
    });

    it("still auto-confirms the exact observed correct case: text names 12, candidate is 12", () => {
      const suggestions = matchByRules(tx({ remittanceText: "Re.Nr. 12 vom 02.07.25 Beratung und Hosting" }), [doc({ invoiceNumber: "12" })]);
      expect(suggestions).toHaveLength(1);
      expect(suggestions[0]).toMatchObject({ kind: MATCH_KINDS.exact, autoConfirm: true });
    });

    it("does not veto a candidate with no invoice number at all - nothing to contradict", () => {
      const suggestions = matchByRules(tx({ remittanceText: "Re Nr. 15" }), [doc({ invoiceNumber: null })]);
      expect(suggestions).toHaveLength(1);
    });

    it("does not veto when the text names no invoice reference at all - a bare amount/iban/name match is unaffected", () => {
      const suggestions = matchByRules(tx({ remittanceText: "Vielen Dank" }), [doc({ invoiceNumber: "12" })]);
      expect(suggestions).toHaveLength(1);
    });
  });
});

// The owner's real case (decisions/0033, revised): outgoing invoice 21 over 312,50 EUR, paid by the
// customer's owner privately ("PRIVAT MUSTERMANN", so no name or IBAN signal at all) with the
// remittance line "Re Nr. 21/ 24". Before the fix the veto read the reference as "2124" and
// blocked this, the correct payment.
describe("matchByRules on a number/year remittance line", () => {
  const payment = tx({
    bookingDate: "2025-03-11",
    amountCents: 31_250,
    counterpartyName: "PRIVAT MUSTERMANN",
    counterpartyIban: null,
    remittanceText: "Re Nr. 21/ 24",
  });
  const invoice21 = doc({
    id: "doc-21",
    direction: "outgoing",
    invoiceNumber: "21",
    totalAmountCents: 31_250,
    openAmountCents: 31_250,
    documentDate: "2025-03-06",
    dueDate: null,
    contactIban: null,
    contactName: "Bauwerk Generalbau München GmbH",
  });

  it("auto-confirms invoice 21", () => {
    const suggestions = matchByRules(payment, [invoice21]);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({ documentIds: ["doc-21"], kind: MATCH_KINDS.exact, autoConfirm: true });
  });

  it("does not match a different invoice with the same amount", () => {
    const invoice22 = { ...invoice21, id: "doc-22", invoiceNumber: "22" };
    expect(matchByRules(payment, [invoice22])).toHaveLength(0);
  });
});

// decisions/0071: Meta charges the card per receipt; the bank shows "FACEBK *4TXV8WLN2B" as the
// counterparty and no remittance text, and the receipt prints "Referenznummer: 4TXV8WLN2B". Two
// receipts often carry the same amount, which is what made the AI arbiter swap them.
describe("matchByRules - card statement reference (decisions/0071)", () => {
  const metaTx = (reference: string, amountCents: number) =>
    tx({ counterpartyName: `FACEBK *${reference}`, counterpartyIban: null, remittanceText: null, amountCents: -amountCents, bookingDate: "2026-09-04" });
  const metaDoc = (id: string, reference: string, amountCents: number) =>
    doc({
      id,
      invoiceNumber: `FBADS-100-${id}`,
      totalAmountCents: amountCents,
      openAmountCents: amountCents,
      documentDate: "2026-09-03",
      dueDate: null,
      contactIban: null,
      contactName: "Meta Platforms Ireland Limited",
      referenceText: `Zahlungsmethode Visa ··· 4242 Referenznummer: ${reference} Transaktions-ID 1000000001`,
    });

  it("auto-confirms the receipt that prints the descriptor's reference, not its same-amount twin", () => {
    const suggestions = matchByRules(metaTx("K3M9P2QX7R", 2500), [metaDoc("200000002", "W6ZN1CDJ5L", 2500), metaDoc("200000001", "K3M9P2QX7R", 2500)]);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({ documentIds: ["200000001"], kind: MATCH_KINDS.exact, autoConfirm: true });
    expect(suggestions[0]!.reasons).toContain(MATCH_REASON_CODES.statementReferenceInDocument);
    expect(suggestions[0]!.reasons).not.toContain(MATCH_REASON_CODES.invoiceNumberInRemittance);
  });

  it("is no signal when the amount is not exact", () => {
    expect(matchByRules(metaTx("K3M9P2QX7R", 2450), [metaDoc("200000001", "K3M9P2QX7R", 2500)])).toEqual([]);
  });

  it("does not match a reference that only appears inside a longer token", () => {
    const docWithLongerToken = { ...metaDoc("200000001", "XK3M9P2QX7R", 2500) };
    expect(matchByRules(metaTx("K3M9P2QX7R", 2500), [docWithLongerToken])).toEqual([]);
  });

  it("is no signal for a document without text", () => {
    expect(matchByRules(metaTx("K3M9P2QX7R", 2500), [{ ...metaDoc("200000001", "K3M9P2QX7R", 2500), referenceText: undefined }])).toEqual([]);
  });
});
