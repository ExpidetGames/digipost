import { describe, expect, it } from "vitest";

import {
  buildClosingCrossReferences,
  closingReference,
  DOCUMENT_REFERENCE_PREFIX,
  TRANSACTION_REFERENCE_PREFIX,
  type ClosingReferenceLabels,
  type CrossReferenceDocument,
  type CrossReferenceTransaction,
} from "../core/cross-references";

const PERIOD = { from: "2026-01-01", to: "2026-01-31" } as const;

/** Deliberately not German here: the point is that the caller owns every word, so the test
 * can tell the two cases apart at a glance. */
const labels: ClosingReferenceLabels = {
  outsidePeriod: ({ isoDate, amountCents, currency }) => `outside(${isoDate}, ${amountCents ?? "-"} ${currency ?? "-"})`,
  notListed: ({ isoDate, amountCents, currency }) => `notlisted(${isoDate}, ${amountCents ?? "-"} ${currency ?? "-"})`,
};

function document(id: string, effectiveDate: string, overrides: Partial<CrossReferenceDocument> = {}): CrossReferenceDocument {
  return { id, effectiveDate, totalAmountCents: 11900, currency: "EUR", confirmedTransactions: [], ...overrides };
}

function transaction(id: string, bookingDate: string, overrides: Partial<CrossReferenceTransaction> = {}): CrossReferenceTransaction {
  return { id, bookingDate, amountCents: -11900, currency: "EUR", confirmedDocuments: [], ...overrides };
}

describe("closingReference", () => {
  it("numbers a sheet's rows from one, zero-padded, and never truncates a big year", () => {
    expect(closingReference(DOCUMENT_REFERENCE_PREFIX, 0)).toBe("D-001");
    expect(closingReference(TRANSACTION_REFERENCE_PREFIX, 11)).toBe("B-012");
    expect(closingReference(DOCUMENT_REFERENCE_PREFIX, 999)).toBe("D-1000");
  });
});

describe("buildClosingCrossReferences", () => {
  it("numbers both sheets in their own row order and points each side at the other", () => {
    const result = buildClosingCrossReferences({
      period: PERIOD,
      documents: [
        document("doc-1", "2026-01-05", {
          confirmedTransactions: [
            { id: "tx-1", bookingDate: "2026-01-10", amountCents: -11900, currency: "EUR", allocatedAmountCents: 11900 },
            { id: "tx-2", bookingDate: "2026-01-20", amountCents: -2300, currency: "EUR", allocatedAmountCents: 2300 },
          ],
        }),
        document("doc-2", "2026-01-06"),
      ],
      transactions: [
        transaction("tx-1", "2026-01-10", {
          confirmedDocuments: [{ id: "doc-1", effectiveDate: "2026-01-05", amountCents: 11900, currency: "EUR", allocatedAmountCents: 11900 }],
        }),
        transaction("tx-2", "2026-01-20", {
          confirmedDocuments: [{ id: "doc-1", effectiveDate: "2026-01-05", amountCents: 11900, currency: "EUR", allocatedAmountCents: 2300 }],
        }),
      ],
      labels,
    });

    expect(result.documentReferences.get("doc-1")).toBe("D-001");
    expect(result.documentReferences.get("doc-2")).toBe("D-002");
    expect(result.transactionReferences.get("tx-2")).toBe("B-002");
    expect(result.transactionsOfDocument.get("doc-1")).toBe("B-001, B-002");
    // No confirmed link at all is an empty cell, never a placeholder.
    expect(result.transactionsOfDocument.get("doc-2")).toBe("");
    expect(result.documentsOfTransaction.get("tx-1")).toBe("D-001");

    // One row per pairing, each counted once although both sides know about it.
    expect(result.assignments.map((row) => [row.documentReference, row.transactionReference])).toEqual([
      ["D-001", "B-001"],
      ["D-001", "B-002"],
    ]);
    expect(result.assignments[1]).toMatchObject({
      documentRowId: "doc-1",
      documentDate: "2026-01-05",
      documentAmountCents: 11900,
      transactionDate: "2026-01-20",
      transactionAmountCents: -2300,
      allocatedAmountCents: 2300,
      currency: "EUR",
    });
  });

  it("names a counterpart outside the period instead of leaving the cell empty", () => {
    const result = buildClosingCrossReferences({
      period: PERIOD,
      documents: [
        // A December invoice settled in January is not in a January export at all; its
        // booking still has to say which invoice it paid.
        document("doc-1", "2026-01-15", {
          confirmedTransactions: [{ id: "tx-old", bookingDate: "2025-12-14", amountCents: -2300, currency: "EUR", allocatedAmountCents: 2300 }],
        }),
      ],
      transactions: [
        transaction("tx-1", "2026-01-12", {
          confirmedDocuments: [{ id: "doc-old", effectiveDate: "2025-12-14", amountCents: 2300, currency: "EUR", allocatedAmountCents: 2300 }],
        }),
      ],
      labels,
    });

    expect(result.transactionsOfDocument.get("doc-1")).toBe("outside(2025-12-14, -2300 EUR)");
    expect(result.documentsOfTransaction.get("tx-1")).toBe("outside(2025-12-14, 2300 EUR)");

    // Both pairings reach the "Zuordnungen" sheet: one known from the document's side, one
    // only from the transaction's. The unlisted document has no name to show.
    expect(result.assignments).toHaveLength(2);
    expect(result.assignments[0]).toMatchObject({
      documentReference: "D-001",
      transactionReference: "outside(2025-12-14, -2300 EUR)",
      transactionDate: "2025-12-14",
    });
    expect(result.assignments[1]).toMatchObject({
      documentReference: "outside(2025-12-14, 2300 EUR)",
      documentRowId: null,
      documentDate: "2025-12-14",
      transactionReference: "B-001",
    });
  });

  it("says 'not listed' rather than 'outside the period' for a counterpart the sheet omits", () => {
    const result = buildClosingCrossReferences({
      period: PERIOD,
      documents: [
        // A clearing account's rows are deliberately not in the Buchungen sheet, so this
        // counterpart is missing although its booking date is inside the period.
        document("doc-1", "2026-01-15", {
          confirmedTransactions: [{ id: "tx-clearing", bookingDate: "2026-01-16", amountCents: 79, currency: "EUR", allocatedAmountCents: 79 }],
        }),
      ],
      transactions: [],
      labels,
    });

    expect(result.transactionsOfDocument.get("doc-1")).toBe("notlisted(2026-01-16, 79 EUR)");
  });

  it("carries a document with no amount of its own through both sides", () => {
    const result = buildClosingCrossReferences({
      period: PERIOD,
      documents: [],
      transactions: [
        transaction("tx-1", "2026-01-12", {
          confirmedDocuments: [{ id: "doc-old", effectiveDate: "2025-11-30", amountCents: null, currency: null, allocatedAmountCents: 500 }],
        }),
      ],
      labels,
    });

    expect(result.documentsOfTransaction.get("tx-1")).toBe("outside(2025-11-30, - -)");
    expect(result.assignments[0]).toMatchObject({ documentAmountCents: null, currency: "EUR", allocatedAmountCents: 500 });
  });
});
