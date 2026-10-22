import { describe, expect, it } from "vitest";

import { MAX_ARBITER_CANDIDATES, arbiterCacheKey, toCacheableArbiterAnswer, validateArbiterResult } from "../core/arbiter";
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
  // decisions/0077-arbiter-answer-cache.md: the key is the whole question, so any answer (also
  // "no match") can be reused exactly as long as nothing the arbiter is given has changed.
  const VERSION = "fake:1";
  const baseTx = tx();
  const doc1 = doc({ id: "doc-1" });
  const doc2 = doc({ id: "doc-2", invoiceNumber: "RE-2026-00002", openAmountCents: 20_000, totalAmountCents: 20_000 });
  const key = (transaction: MatchableTransaction = baseTx, candidates: readonly MatchableDocument[] = [doc1, doc2], version = VERSION) => arbiterCacheKey(transaction, candidates, version);

  it("is deterministic for the same question", () => {
    expect(key()).toBe(key());
    expect(key()).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable across copies with a different property order", () => {
    const reorderedTx = Object.fromEntries(Object.entries(baseTx).reverse()) as MatchableTransaction;
    const reorderedDoc = Object.fromEntries(Object.entries(doc1).reverse()) as MatchableDocument;
    expect(key(reorderedTx, [reorderedDoc, doc2])).toBe(key());
  });

  it("is order-independent over the candidates", () => {
    expect(key(baseTx, [doc2, doc1])).toBe(key(baseTx, [doc1, doc2]));
  });

  it("treats an absent optional field like null", () => {
    expect(key(baseTx, [{ ...doc1, referenceText: null }, doc2])).toBe(key(baseTx, [doc1, doc2]));
  });

  it("differs when a candidate is added or dropped", () => {
    expect(key(baseTx, [doc1])).not.toBe(key(baseTx, [doc1, doc2]));
    expect(key(baseTx, [doc1, doc2, doc({ id: "doc-3" })])).not.toBe(key());
  });

  it("differs when a candidate is replaced by another with the same fields", () => {
    expect(key(baseTx, [doc1, { ...doc2, id: "doc-9" }])).not.toBe(key());
  });

  it.each<[string, Partial<MatchableTransaction>]>([
    ["id", { id: "tx-2" }],
    ["amount", { amountCents: -9_999 }],
    ["currency", { currency: "USD" }],
    ["booking date", { bookingDate: "2026-09-16" }],
    ["remittance text", { remittanceText: "something else" }],
    ["counterparty name", { counterpartyName: "Andere GmbH" }],
    ["counterparty IBAN", { counterpartyIban: null }],
  ])("differs when the transaction's %s changes", (_label, change) => {
    expect(key({ ...baseTx, ...change })).not.toBe(key());
  });

  it.each<[string, Partial<MatchableDocument>]>([
    ["open amount (a partial payment booked elsewhere)", { openAmountCents: 4_000 }],
    ["invoice number (a re-extraction)", { invoiceNumber: "RE-2026-00077" }],
    ["direction (a kind correction)", { direction: "outgoing" }],
    ["document date", { documentDate: "2026-08-01" }],
    ["due date", { dueDate: "2026-09-30" }],
    ["contact name", { contactName: "Andere GmbH" }],
    ["currency", { currency: "USD" }],
    ["reference text", { referenceText: "FACEBK *ABC" }],
  ])("differs when a candidate's %s changes", (_label, change) => {
    expect(key(baseTx, [{ ...doc1, ...change }, doc2])).not.toBe(key());
  });

  it("differs when the arbiter's model or prompt version changes", () => {
    expect(key(baseTx, [doc1, doc2], "mistral:mistral-small-latest:aaaa")).not.toBe(key(baseTx, [doc1, doc2], "mistral:mistral-small-latest:bbbb"));
    expect(key(baseTx, [doc1, doc2], "mistral:mistral-small-latest:aaaa")).not.toBe(key(baseTx, [doc1, doc2], "mistral:mistral-medium-latest:aaaa"));
  });
});

describe("toCacheableArbiterAnswer", () => {
  it("keeps a well-formed answer, clamping the confidence", () => {
    expect(toCacheableArbiterAnswer({ bestDocumentId: "doc-1", confidence: 1.7, reason: "Passt." })).toEqual({ bestDocumentId: "doc-1", confidence: 1, reason: "Passt." });
  });

  it("stores a malformed answer as no pick", () => {
    expect(toCacheableArbiterAnswer({ bestDocumentId: 7 })).toEqual({ bestDocumentId: null, confidence: 0, reason: "" });
    expect(toCacheableArbiterAnswer(null)).toEqual({ bestDocumentId: null, confidence: 0, reason: "" });
  });

  it("validates to the same result as the live answer it was made from", () => {
    const input = { transaction: tx(), candidates: [doc()] };
    const live = { bestDocumentId: "doc-1", confidence: 0.83, reason: `Betrag passt. ${"x".repeat(5_000)}` };
    expect(validateArbiterResult(toCacheableArbiterAnswer(live), input)).toEqual(validateArbiterResult(live, input));
    const noMatch = { bestDocumentId: null, confidence: 0, reason: "Keine passt." };
    expect(validateArbiterResult(toCacheableArbiterAnswer(noMatch), input)).toBeNull();
  });
});
