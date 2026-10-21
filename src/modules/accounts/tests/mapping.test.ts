// Idempotency-key stability (F2's own scope): both mapping functions must carry the intake
// module's own `idempotencyKey` through verbatim, never recompute or drop it - that key is
// what backs `transactions`'s per-account unique constraint and therefore the whole
// idempotent-reimport guarantee (decisions/0024-accounts-and-transactions.md).
import { describe, expect, it } from "vitest";

import type { Camt053Statement, NormalizedBankTransactionFromMapping } from "@/modules/intake";

import { mapCamt053StatementsToImportable, mapTabularRowsToImportable, summarizeStatementsForBatch } from "../core/mapping";

function camtStatement(overrides: Partial<Camt053Statement> = {}): Camt053Statement {
  return {
    statementId: "STMT-1",
    accountIban: "DE89370400440532013000",
    currency: "EUR",
    openingBalance: { type: "OPBD", date: "2026-01-01", amountCents: 10000, currency: "EUR" },
    closingBalance: { type: "CLBD", date: "2026-01-31", amountCents: 15000, currency: "EUR" },
    transactions: [
      {
        idempotencyKey: "same-key-every-time",
        accountIban: "DE89370400440532013000",
        currency: "EUR",
        bookingDate: "2026-01-15",
        valueDate: null,
        amountCents: 5000,
        creditDebit: "credit",
        counterpartyName: "Kunde AG",
        counterpartyIban: null,
        counterpartyBic: null,
        remittanceInformation: "Rechnung 1",
        endToEndId: null,
        mandateId: null,
        creditorId: null,
        bankTransactionCode: null,
        accountServicerReference: null,
        entryReference: null,
      },
    ],
    ...overrides,
  };
}

describe("mapCamt053StatementsToImportable", () => {
  it("carries idempotencyKey through verbatim", () => {
    const [statement] = mapCamt053StatementsToImportable([camtStatement()]);
    expect(statement!.transactions[0]!.idempotencyKey).toBe("same-key-every-time");
  });

  it("maps balances, currency, and remittance information", () => {
    const [statement] = mapCamt053StatementsToImportable([camtStatement()]);
    expect(statement).toMatchObject({ accountIban: "DE89370400440532013000", currency: "EUR", openingBalanceCents: 10000, closingBalanceCents: 15000 });
    expect(statement!.transactions[0]!.remittanceText).toBe("Rechnung 1");
  });
});

describe("mapTabularRowsToImportable", () => {
  const rows: NormalizedBankTransactionFromMapping[] = [
    {
      rowNumber: 1,
      idempotencyKey: "tabular-key-1",
      bookingDate: "2026-01-15",
      valueDate: null,
      amountCents: 10000,
      creditDebit: "credit",
      currency: "EUR",
      counterpartyName: "Kunde AG",
      counterpartyIban: "DE89370400440532013000",
      reference: "Rechnung 1",
      endToEndId: null,
    },
  ];

  it("carries idempotencyKey through verbatim and never invents an own-account IBAN", () => {
    const statement = mapTabularRowsToImportable(rows);
    expect(statement.accountIban).toBeNull();
    expect(statement.openingBalanceCents).toBeNull();
    expect(statement.closingBalanceCents).toBeNull();
    expect(statement.transactions[0]!.idempotencyKey).toBe("tabular-key-1");
    expect(statement.transactions[0]!.counterpartyIban).toBe("DE89370400440532013000");
  });
});

describe("summarizeStatementsForBatch", () => {
  it("uses the earliest/latest booking date and the first opening / last closing balance across statements", () => {
    const early = camtStatement({
      openingBalance: { type: "OPBD", date: "2026-01-01", amountCents: 0, currency: "EUR" },
      closingBalance: { type: "CLBD", date: "2026-01-15", amountCents: 5000, currency: "EUR" },
      transactions: [{ ...camtStatement().transactions[0]!, bookingDate: "2026-01-10", amountCents: 5000, idempotencyKey: "k1" }],
    });
    const later = camtStatement({
      openingBalance: { type: "OPBD", date: "2026-02-01", amountCents: 5000, currency: "EUR" },
      closingBalance: { type: "CLBD", date: "2026-02-28", amountCents: 10000, currency: "EUR" },
      transactions: [{ ...camtStatement().transactions[0]!, bookingDate: "2026-02-20", amountCents: 5000, idempotencyKey: "k2" }],
    });

    const statements = mapCamt053StatementsToImportable([early, later]);
    const summary = summarizeStatementsForBatch(statements);

    expect(summary).toMatchObject({
      statementFrom: "2026-01-10",
      statementTo: "2026-02-20",
      openingBalanceCents: 0,
      closingBalanceCents: 10000,
      balanceMismatch: false,
    });
  });

  it("flags balanceMismatch when any one statement does not reconcile", () => {
    const broken = camtStatement({ closingBalance: { type: "CLBD", date: "2026-01-31", amountCents: 99999, currency: "EUR" } });
    const summary = summarizeStatementsForBatch(mapCamt053StatementsToImportable([broken]));
    expect(summary.balanceMismatch).toBe(true);
  });

  it("has no balance data (and no mismatch) for a tabular-only statement", () => {
    const summary = summarizeStatementsForBatch([mapTabularRowsToImportable([])]);
    expect(summary).toMatchObject({ openingBalanceCents: null, closingBalanceCents: null, balanceMismatch: false });
  });
});
