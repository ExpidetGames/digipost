import { describe, expect, it } from "vitest";

import { findSubsetSums, partialPaymentFor, remainingOpenAmount } from "../core/arithmetic";
import type { MatchableDocument } from "../core/types";

function doc(id: string, openAmountCents: number): MatchableDocument {
  return {
    id,
    direction: "incoming",
    invoiceNumber: `RE-${id}`,
    totalAmountCents: openAmountCents,
    currency: "EUR",
    documentDate: "2026-09-01",
    dueDate: null,
    paymentIban: null,
    contactId: "contact-1",
    contactIban: null,
    contactName: "Musterwerk GmbH",
    openAmountCents,
  };
}

describe("findSubsetSums", () => {
  it("finds the exact single-document sum", () => {
    const result = findSubsetSums([doc("a", 5_000), doc("b", 3_000)], 5_000);
    expect(result.solutions).toEqual([["a"]]);
    expect(result.ambiguous).toBe(false);
  });

  it("finds a two-document collective sum", () => {
    const result = findSubsetSums([doc("a", 5_000), doc("b", 3_000), doc("c", 7_000)], 8_000);
    expect(result.solutions).toEqual([["a", "b"]]);
    expect(result.ambiguous).toBe(false);
  });

  it("reports ambiguity when several subsets fit", () => {
    // {a,b} = 8000 and {c} = 8000 both sum to the target.
    const result = findSubsetSums([doc("a", 5_000), doc("b", 3_000), doc("c", 8_000)], 8_000);
    expect(result.ambiguous).toBe(true);
    expect(result.solutions).toEqual(expect.arrayContaining([["c"], ["a", "b"]]));
    expect(result.solutions).toHaveLength(2);
  });

  it("returns no solutions when nothing sums to the target", () => {
    const result = findSubsetSums([doc("a", 5_000), doc("b", 3_000)], 9_000);
    expect(result.solutions).toEqual([]);
    expect(result.ambiguous).toBe(false);
  });

  it("applies a percent tolerance to the target sum", () => {
    // target 10000, tolerance 3% -> [9700, 10300] accepted.
    const result = findSubsetSums([doc("a", 9_800)], 10_000, { tolerancePercent: 3 });
    expect(result.solutions).toEqual([["a"]]);
  });

  it("rejects a sum outside the percent tolerance", () => {
    const result = findSubsetSums([doc("a", 9_600)], 10_000, { tolerancePercent: 3 });
    expect(result.solutions).toEqual([]);
  });

  it("the empty subset is never a solution, even for a target of 0", () => {
    const result = findSubsetSums([doc("a", 5_000)], 0);
    expect(result.solutions).toEqual([]);
  });

  it("performance bound: 15 items resolve well under 50ms", () => {
    const documents = Array.from({ length: 15 }, (_, i) => doc(`doc-${i}`, (i + 1) * 1_000));
    const started = performance.now();
    const result = findSubsetSums(documents, 15_000 + 14_000); // sum of last two items, arbitrary
    const elapsedMs = performance.now() - started;
    expect(elapsedMs).toBeLessThan(50);
    expect(result.solutions.length).toBeGreaterThanOrEqual(0);
  });

  it("bounds the search to maxItems (default 15) by taking the smallest open amounts, deterministically", () => {
    // 16 documents, all with distinct amounts; only the 15 smallest are ever considered, so a
    // target only reachable using the single largest one has no solution.
    const documents = Array.from({ length: 16 }, (_, i) => doc(`doc-${i}`, (i + 1) * 1_000));
    const largest = documents[15]!; // 16000, excluded once maxItems=15 keeps only the 15 smallest
    const result = findSubsetSums(documents, largest.openAmountCents);
    expect(result.solutions.flat()).not.toContain("doc-15");
  });

  it("caps the number of returned solutions at maxSolutions but still reports ambiguity", () => {
    // Every single one of 4 equal-amount documents alone sums to the target - 4 solutions exist.
    const documents = [doc("a", 1_000), doc("b", 1_000), doc("c", 1_000), doc("d", 1_000)];
    const result = findSubsetSums(documents, 1_000, { maxSolutions: 2 });
    expect(result.solutions).toHaveLength(2);
    expect(result.ambiguous).toBe(true);
  });
});

describe("partialPaymentFor", () => {
  it("applies the full paid amount when it is less than the open amount", () => {
    expect(partialPaymentFor(doc("a", 10_000), { amountCents: -4_000 })).toEqual({ appliedCents: 4_000, remainingOpenCents: 6_000 });
  });

  it("caps the applied amount at the document's own open amount when the payment overshoots", () => {
    expect(partialPaymentFor(doc("a", 10_000), { amountCents: -12_000 })).toEqual({ appliedCents: 10_000, remainingOpenCents: 0 });
  });

  it("uses the absolute value of a negative or positive amountCents identically", () => {
    expect(partialPaymentFor(doc("a", 10_000), { amountCents: 4_000 })).toEqual({ appliedCents: 4_000, remainingOpenCents: 6_000 });
  });
});

describe("remainingOpenAmount", () => {
  it("subtracts the applied amount from the open amount", () => {
    expect(remainingOpenAmount(doc("a", 10_000), 4_000)).toBe(6_000);
  });

  it("never goes negative even if appliedCents exceeds the open amount", () => {
    expect(remainingOpenAmount(doc("a", 10_000), 15_000)).toBe(0);
  });
});
