import { describe, expect, it } from "vitest";

import { MAX_ARBITER_CANDIDATES, arbiterCacheKey, validateArbiterResult } from "../core/arbiter";
import { MATCH_KINDS, type MatchableDocument, type MatchableTransaction } from "../core/types";

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

describe("validateArbiterResult", () => {
  it("accepts a well-formed pick among the candidates", () => {
    const candidates = [doc()];
    const result = validateArbiterResult({ bestDocumentId: "doc-1", confidence: 0.8, reason: "Betrag und Datum passen gut." }, { transaction: tx(), candidates });
    expect(result).toMatchObject({
      documentIds: ["doc-1"],
      transactionIds: ["tx-1"],
      kind: MATCH_KINDS.ai,
      confidence: 0.8,
      autoConfirm: false,
    });
    expect(result!.aiExplanation).toBe("Betrag und Datum passen gut.");
  });

  it("rejects a hallucinated document id not present in the candidates", () => {
    const candidates = [doc({ id: "doc-1" })];
    const result = validateArbiterResult({ bestDocumentId: "doc-does-not-exist", confidence: 0.9, reason: "..." }, { transaction: tx(), candidates });
    expect(result).toBeNull();
  });

  it("rejects a cross-direction pick even if it was somehow in the candidate list", () => {
    // The candidate itself contradicts the transaction's direction - the arbiter's own pick
    // must be re-checked, never trusted just because it appears in `candidates`.
    const candidates = [doc({ id: "doc-1", direction: "outgoing" })];
    const result = validateArbiterResult({ bestDocumentId: "doc-1", confidence: 0.9, reason: "..." }, { transaction: tx({ amountCents: -10_000 }), candidates });
    expect(result).toBeNull();
  });

  it("rejects a pick with no open amount left", () => {
    const candidates = [doc({ id: "doc-1", openAmountCents: 0 })];
    const result = validateArbiterResult({ bestDocumentId: "doc-1", confidence: 0.9, reason: "..." }, { transaction: tx(), candidates });
    expect(result).toBeNull();
  });

  it("treats a null bestDocumentId as no suggestion", () => {
    const result = validateArbiterResult({ bestDocumentId: null, confidence: 0, reason: "Kein Treffer." }, { transaction: tx(), candidates: [doc()] });
    expect(result).toBeNull();
  });

  it("rejects a completely malformed raw response", () => {
    const result = validateArbiterResult({ nonsense: true }, { transaction: tx(), candidates: [doc()] });
    expect(result).toBeNull();
  });

  it("clamps an out-of-range confidence into [0, 1]", () => {
    const result = validateArbiterResult({ bestDocumentId: "doc-1", confidence: 5, reason: "..." }, { transaction: tx(), candidates: [doc()] });
    expect(result!.confidence).toBe(1);
  });

  it("clamps a negative confidence to 0", () => {
    const result = validateArbiterResult({ bestDocumentId: "doc-1", confidence: -2, reason: "..." }, { transaction: tx(), candidates: [doc()] });
    expect(result!.confidence).toBe(0);
  });

  it("never sets autoConfirm true, even at maximum confidence with an invoice number present", () => {
    const result = validateArbiterResult(
      { bestDocumentId: "doc-1", confidence: 1, reason: "Perfekte Uebereinstimmung." },
      { transaction: tx({ remittanceText: "RE-2026-00001" }), candidates: [doc()] },
    );
    expect(result!.autoConfirm).toBe(false);
  });

  it("keeps only the first sentence of a multi-sentence reason", () => {
    const result = validateArbiterResult(
      { bestDocumentId: "doc-1", confidence: 0.5, reason: "Erster Satz. Zweiter Satz sollte verworfen werden." },
      { transaction: tx(), candidates: [doc()] },
    );
    expect(result!.aiExplanation).toBe("Erster Satz.");
  });

  // decisions/0033-contradicting-invoice-number-vetoes-a-match.md: the exact observed
  // production defect - a transaction whose remittance text names invoice 40 was suggested by
  // the AI arbiter for document 12 anyway, at confidence 0.9, with the model's own explanation
  // noting the contradiction and suggesting the match regardless.
  it("rejects the exact observed defect: remittance names invoice 40, the picked candidate is document 12", () => {
    const candidates = [doc({ id: "doc-38", direction: "outgoing", invoiceNumber: "12", openAmountCents: 48_000 })];
    const result = validateArbiterResult(
      { bestDocumentId: "doc-38", confidence: 0.9, reason: "Die Rechnungsnummer im Verwendungszweck (40) weicht leicht von der im Kandidaten ab (38), aber es handelt sich um die ei..." },
      { transaction: tx({ amountCents: 90_500, remittanceText: "Re Nr. 15" }), candidates },
    );
    expect(result).toBeNull();
  });

  it("still accepts a matching case: remittance names invoice 12, the picked candidate is document 12", () => {
    const candidates = [doc({ id: "doc-38", direction: "outgoing", invoiceNumber: "12", openAmountCents: 48_000 })];
    const result = validateArbiterResult(
      { bestDocumentId: "doc-38", confidence: 0.9, reason: "Rechnungsnummer und Betrag passen." },
      { transaction: tx({ amountCents: 48_000, remittanceText: "Re.Nr. 12 vom 02.07.25 Beratung und Hosting" }), candidates },
    );
    expect(result).toMatchObject({ documentIds: ["doc-38"], kind: MATCH_KINDS.ai });
  });

  it("throws when called with more than MAX_ARBITER_CANDIDATES candidates", () => {
    const candidates = Array.from({ length: MAX_ARBITER_CANDIDATES + 1 }, (_, i) => doc({ id: `doc-${i}` }));
    expect(() => validateArbiterResult({ bestDocumentId: "doc-0", confidence: 0.5, reason: "..." }, { transaction: tx(), candidates })).toThrow();
  });
});

describe("arbiterCacheKey", () => {
  const baseTx = tx();

  it("is deterministic for the same transaction and candidate set", () => {
    expect(arbiterCacheKey(baseTx, ["doc-1", "doc-2"])).toBe(arbiterCacheKey(baseTx, ["doc-1", "doc-2"]));
  });

  it("is order-independent over candidate ids", () => {
    expect(arbiterCacheKey(baseTx, ["doc-1", "doc-2"])).toBe(arbiterCacheKey(baseTx, ["doc-2", "doc-1"]));
  });

  it("differs when the candidate set differs", () => {
    expect(arbiterCacheKey(baseTx, ["doc-1"])).not.toBe(arbiterCacheKey(baseTx, ["doc-1", "doc-2"]));
  });

  it("differs when the transaction's amount differs", () => {
    expect(arbiterCacheKey(baseTx, ["doc-1"])).not.toBe(arbiterCacheKey({ ...baseTx, amountCents: -9_999 }, ["doc-1"]));
  });

  it("differs when the remittance text differs", () => {
    expect(arbiterCacheKey(baseTx, ["doc-1"])).not.toBe(arbiterCacheKey({ ...baseTx, remittanceText: "something else" }, ["doc-1"]));
  });
});
