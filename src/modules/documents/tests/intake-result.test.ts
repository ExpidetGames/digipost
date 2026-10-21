// `documents.intake_result`'s shape (decisions/0020-universal-intake.md,
// decisions/0022-intake-wiring.md): the builders cap embedded rows for a large source, and
// `parseIntakeResult` safely reads back whatever is stored (never throws).
import { describe, expect, it } from "vitest";

import type { NormalizedTransaction } from "@/modules/intake";

import { buildBankStatementIntakeResult, buildTabularConfirmedIntakeResult, MAX_EMBEDDED_ROWS, parseIntakeResult } from "../core/intake-result";

function fakeTransaction(index: number): NormalizedTransaction {
  return {
    idempotencyKey: `key-${index}`,
    accountIban: "DE89370400440532013000",
    currency: "EUR",
    bookingDate: "2026-01-01",
    valueDate: null,
    amountCents: 100,
    creditDebit: "credit",
    counterpartyName: null,
    counterpartyIban: null,
    counterpartyBic: null,
    remittanceInformation: null,
    endToEndId: null,
    mandateId: null,
    creditorId: null,
    bankTransactionCode: null,
    accountServicerReference: null,
    entryReference: null,
  };
}

describe("buildBankStatementIntakeResult", () => {
  it("embeds every transaction when under the cap", () => {
    const transactions = Array.from({ length: 5 }, (_, i) => fakeTransaction(i));
    const result = buildBankStatementIntakeResult({ statementCount: 1, allStatementsReconcile: true, transactions });
    expect(result.truncated).toBe(false);
    expect(result.transactions).toHaveLength(5);
    expect(result.transactionCount).toBe(5);
  });

  // decisions/0061-a-statement-is-dated-by-its-last-booking.md
  it("records the latest booking date", () => {
    const transactions = [
      { ...fakeTransaction(0), bookingDate: "2026-01-05" },
      { ...fakeTransaction(1), bookingDate: "2026-01-31" },
      { ...fakeTransaction(2), bookingDate: "2026-01-12" },
    ];
    const result = buildBankStatementIntakeResult({ statementCount: 1, allStatementsReconcile: true, transactions });
    expect(result.lastBookingDate).toBe("2026-01-31");
  });

  it("takes the latest booking from EVERY transaction, not only the embedded ones", () => {
    // The cap keeps the first MAX_EMBEDDED_ROWS, so putting the latest booking past the cap
    // is exactly the case a naive "max over result.transactions" would get wrong.
    const transactions = Array.from({ length: MAX_EMBEDDED_ROWS + 50 }, (_, i) => ({
      ...fakeTransaction(i),
      bookingDate: i === MAX_EMBEDDED_ROWS + 10 ? "2026-12-31" : "2026-01-01",
    }));
    const result = buildBankStatementIntakeResult({ statementCount: 1, allStatementsReconcile: true, transactions });
    expect(result.truncated).toBe(true);
    expect(result.lastBookingDate).toBe("2026-12-31");
  });

  it("has no last booking date for a statement with no transactions", () => {
    const result = buildBankStatementIntakeResult({ statementCount: 1, allStatementsReconcile: true, transactions: [] });
    expect(result.lastBookingDate).toBeNull();
  });

  it("caps embedded transactions at MAX_EMBEDDED_ROWS but keeps the real total count", () => {
    const transactions = Array.from({ length: MAX_EMBEDDED_ROWS + 50 }, (_, i) => fakeTransaction(i));
    const result = buildBankStatementIntakeResult({ statementCount: 1, allStatementsReconcile: false, transactions });
    expect(result.truncated).toBe(true);
    expect(result.transactions).toHaveLength(MAX_EMBEDDED_ROWS);
    expect(result.transactionCount).toBe(MAX_EMBEDDED_ROWS + 50);
    expect(result.allStatementsReconcile).toBe(false);
  });
});

describe("buildTabularConfirmedIntakeResult", () => {
  it("caps rows at MAX_EMBEDDED_ROWS but keeps the real row count", () => {
    const rows = Array.from({ length: MAX_EMBEDDED_ROWS + 10 }, (_, i) => ({
      rowNumber: i + 1,
      idempotencyKey: `k-${i}`,
      bookingDate: "2026-01-01",
      valueDate: null,
      amountCents: 100,
      creditDebit: "credit" as const,
      currency: "EUR",
      counterpartyName: null,
      counterpartyIban: null,
      reference: null,
      endToEndId: null,
    }));
    const result = buildTabularConfirmedIntakeResult({ documentKind: "bank_statement", platform: null, rows });
    expect(result.truncated).toBe(true);
    expect(result.rows).toHaveLength(MAX_EMBEDDED_ROWS);
    expect(result.rowCount).toBe(MAX_EMBEDDED_ROWS + 10);
  });
});

describe("parseIntakeResult", () => {
  it("returns null for null/undefined (not_applicable / never-processed documents)", () => {
    expect(parseIntakeResult(null)).toBeNull();
    expect(parseIntakeResult(undefined)).toBeNull();
  });

  it("round-trips a valid tabular_proposal payload", () => {
    const payload = {
      type: "tabular_proposal",
      documentKind: "bank_statement",
      platform: null,
      reason: "Testgrund",
      columnMapping: { bookingDate: "Datum" },
      amountSign: { mode: "signed_column", column: "Betrag" },
      sampleHeader: ["Datum", "Betrag"],
      sampleRows: [["01.01.2026", "10,00"]],
      rowCount: 1,
      validation: { ok: true },
    };
    expect(parseIntakeResult(payload)).toEqual(payload);
  });

  it("degrades to null (never throws) for a value that no longer matches the expected shape", () => {
    expect(parseIntakeResult({ type: "something_unexpected" })).toBeNull();
    expect(parseIntakeResult("not even an object")).toBeNull();
    expect(parseIntakeResult(42)).toBeNull();
  });
});
