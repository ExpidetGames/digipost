import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse as parseCsvSync } from "csv-parse/sync";
import { describe, expect, it } from "vitest";

import type { ColumnMapping } from "../core/classification";
import { validateMapping } from "../core/mapping-validator";
import { sampleTabular, type TabularSample } from "../core/tabular-sample";

function readFixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");
}

function fullDataRows(text: string, delimiter: string): string[][] {
  const records = parseCsvSync(text, { delimiter, relax_column_count: true, skip_empty_lines: true, bom: true }) as string[][];
  return records.slice(1);
}

function minimalSample(header: string[]): TabularSample {
  return { header, delimiter: ",", quoteChar: '"', encoding: "utf-8", rows: [], rowCount: 0, columns: [], fingerprint: "test" };
}

describe("validateMapping - bank statement shape", () => {
  it("normalizes every row of the Musterbank fixture into bank transactions", () => {
    const text = readFixture("musterbank-statement.csv");
    const sample = sampleTabular(text);
    const rows = fullDataRows(text, ";");
    const mapping: ColumnMapping = {
      bookingDate: "Buchungsdatum",
      valueDate: "Wertstellung",
      amount: "Betrag",
      currency: "Währung",
      counterpartyName: "Empfänger/Auftraggeber",
      counterpartyIban: "IBAN",
      reference: "Verwendungszweck",
    };

    const result = validateMapping(sample, rows, mapping, { mode: "signed_column", column: "Betrag" });

    expect(result.ok).toBe(true);
    if (!result.ok || result.kind !== "bank_transactions") throw new Error("expected bank_transactions");
    expect(result.transactions).toHaveLength(7);
    expect(result.transactions[0]).toMatchObject({
      bookingDate: "2026-08-02",
      amountCents: 25000,
      creditDebit: "credit",
      counterpartyName: "Müller GmbH",
      counterpartyIban: "DE45500105172295759744",
    });
    expect(result.transactions[1]).toMatchObject({ amountCents: -4599, creditDebit: "debit" });
    // The German-thousands value in row 5 ("1.083,68") must parse correctly too.
    expect(result.transactions[4]).toMatchObject({ amountCents: 108368, creditDebit: "credit" });
  });

  it("reports a row-level problem for an unparseable date", () => {
    const sample = minimalSample(["Datum", "Betrag"]);
    const result = validateMapping(sample, [["not-a-date", "10,00"]], { bookingDate: "Datum", amount: "Betrag" }, null);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.problems).toEqual([expect.objectContaining({ rowNumber: 1, field: "bookingDate", code: "unparseable_date" })]);
  });

  it("reports a row-level problem for an unparseable amount", () => {
    const sample = minimalSample(["Datum", "Betrag"]);
    const result = validateMapping(sample, [["01.01.2026", "not a number"]], { bookingDate: "Datum", amount: "Betrag" }, null);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.problems[0]).toMatchObject({ rowNumber: 1, field: "amount", code: "unparseable_amount" });
  });

  it("reports inconsistent_sign when both credit and debit columns are filled in the same row", () => {
    const sample = minimalSample(["Datum", "Soll", "Haben"]);
    const amountSign = { mode: "separate_credit_debit_columns", creditColumn: "Haben", debitColumn: "Soll" } as const;
    const result = validateMapping(sample, [["01.01.2026", "10,00", "5,00"]], { bookingDate: "Datum" }, amountSign);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.problems[0]).toMatchObject({ code: "inconsistent_sign" });
  });

  it("reports inconsistent_sign when neither credit nor debit column is filled", () => {
    const sample = minimalSample(["Datum", "Soll", "Haben"]);
    const amountSign = { mode: "separate_credit_debit_columns", creditColumn: "Haben", debitColumn: "Soll" } as const;
    const result = validateMapping(sample, [["01.01.2026", "", ""]], { bookingDate: "Datum" }, amountSign);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.problems[0]).toMatchObject({ code: "inconsistent_sign" });
  });

  it("normalizes separate credit/debit columns correctly when exactly one is filled", () => {
    const sample = minimalSample(["Datum", "Soll", "Haben"]);
    const amountSign = { mode: "separate_credit_debit_columns", creditColumn: "Haben", debitColumn: "Soll" } as const;
    const result = validateMapping(sample, [["01.01.2026", "10,00", ""], ["02.01.2026", "", "20,00"]], { bookingDate: "Datum" }, amountSign);

    expect(result.ok).toBe(true);
    if (!result.ok || result.kind !== "bank_transactions") throw new Error("expected bank_transactions");
    expect(result.transactions[0]).toMatchObject({ amountCents: -1000, creditDebit: "debit" });
    expect(result.transactions[1]).toMatchObject({ amountCents: 2000, creditDebit: "credit" });
  });

  it("reports inconsistent_sign for an indicator value that matches neither creditValue nor debitValue", () => {
    const sample = minimalSample(["Datum", "Betrag", "Typ"]);
    const amountSign = { mode: "indicator_column", amountColumn: "Betrag", indicatorColumn: "Typ", creditValue: "S", debitValue: "R" } as const;
    const result = validateMapping(sample, [["01.01.2026", "10.00", "X"]], { bookingDate: "Datum" }, amountSign);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.problems[0]).toMatchObject({ code: "inconsistent_sign" });
  });

  it("normalizes an indicator-column amount sign correctly", () => {
    const sample = minimalSample(["Datum", "Betrag", "Typ"]);
    const amountSign = { mode: "indicator_column", amountColumn: "Betrag", indicatorColumn: "Typ", creditValue: "S", debitValue: "R" } as const;
    const result = validateMapping(
      sample,
      [
        ["01.01.2026", "10.00", "S"],
        ["02.01.2026", "10.00", "R"],
      ],
      { bookingDate: "Datum" },
      amountSign,
    );

    expect(result.ok).toBe(true);
    if (!result.ok || result.kind !== "bank_transactions") throw new Error("expected bank_transactions");
    expect(result.transactions[0]).toMatchObject({ amountCents: 1000, creditDebit: "credit" });
    expect(result.transactions[1]).toMatchObject({ amountCents: -1000, creditDebit: "debit" });
  });

  it("fails reconciliation when the mapped sum does not match the expected total", () => {
    const sample = minimalSample(["Datum", "Betrag"]);
    const rows = [["01.01.2026", "10,00"], ["02.01.2026", "-5,00"]];
    const result = validateMapping(sample, rows, { bookingDate: "Datum", amount: "Betrag" }, null, { expectedTotalCents: 1000 });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.problems[0]).toMatchObject({ code: "reconciliation_mismatch" });
  });

  it("passes reconciliation when the mapped sum matches the expected total", () => {
    const sample = minimalSample(["Datum", "Betrag"]);
    const rows = [["01.01.2026", "10,00"], ["02.01.2026", "-5,00"]];
    const result = validateMapping(sample, rows, { bookingDate: "Datum", amount: "Betrag" }, null, { expectedTotalCents: 500 });

    expect(result.ok).toBe(true);
  });
});

// R2: the tabular mapping path had the same "most specific reference" bug as camt053-parser.ts
// (`endToEndId ?? reference ?? ""`) - a NOTPROVIDED-style placeholder in the EndToEndId column
// would win over a genuinely unique reference column and collapse distinct rows onto one key.
describe("validateMapping - idempotency key, NOTPROVIDED placeholder and collisions (R2)", () => {
  function bankTransactions(rows: string[][], header: string[], mapping: ColumnMapping) {
    const sample = minimalSample(header);
    const result = validateMapping(sample, rows, mapping, null);
    if (!result.ok || result.kind !== "bank_transactions") throw new Error("expected bank_transactions");
    return result.transactions;
  }

  it("gives two same-day, same-amount rows with EndToEndId=NOTPROVIDED but different references different keys", () => {
    const header = ["Datum", "Betrag", "EndToEnd", "Referenz"];
    const mapping: ColumnMapping = { bookingDate: "Datum", amount: "Betrag", endToEndId: "EndToEnd", reference: "Referenz" };
    const rows = [
      ["01.09.2026", "50,00", "NOTPROVIDED", "ASR-100"],
      ["01.09.2026", "50,00", "NOTPROVIDED", "ASR-101"],
    ];
    const [first, second] = bankTransactions(rows, header, mapping);
    expect(first!.endToEndId).toBe("NOTPROVIDED");
    expect(second!.endToEndId).toBe("NOTPROVIDED");
    expect(first!.idempotencyKey).not.toBe(second!.idempotencyKey);
  });

  it("gives two rows identical in every mapped field a distinct key via the occurrence index", () => {
    const header = ["Datum", "Betrag"];
    const mapping: ColumnMapping = { bookingDate: "Datum", amount: "Betrag" };
    const rows = [
      ["01.09.2026", "5,00"],
      ["01.09.2026", "5,00"],
    ];
    const [first, second] = bankTransactions(rows, header, mapping);
    expect(first!.idempotencyKey).not.toBe(second!.idempotencyKey);
  });

  it("is deterministic: validating the same rows twice yields identical keys, in order", () => {
    const header = ["Datum", "Betrag", "EndToEnd"];
    const mapping: ColumnMapping = { bookingDate: "Datum", amount: "Betrag", endToEndId: "EndToEnd" };
    const rows = [
      ["01.09.2026", "50,00", "NOTPROVIDED"],
      ["02.09.2026", "-5,00", "REF-2"],
    ];
    const once = bankTransactions(rows, header, mapping).map((t) => t.idempotencyKey);
    const again = bankTransactions(rows, header, mapping).map((t) => t.idempotencyKey);
    expect(again).toEqual(once);
  });

  it("treats a whitespace/case variant of the placeholder identically to the canonical one", () => {
    const header = ["Datum", "Betrag", "EndToEnd"];
    const mapping: ColumnMapping = { bookingDate: "Datum", amount: "Betrag", endToEndId: "EndToEnd" };
    const canonical = bankTransactions([["01.09.2026", "50,00", "NOTPROVIDED"]], header, mapping)[0]!;
    const variant = bankTransactions([["01.09.2026", "50,00", " notprovided "]], header, mapping)[0]!;
    expect(variant.idempotencyKey).toBe(canonical.idempotencyKey);
  });
});

describe("validateMapping - settlement/payout report shape", () => {
  it("normalizes every row of the Stripe fixture into settlement lines", () => {
    const text = readFixture("stripe-payout.csv");
    const sample = sampleTabular(text);
    const rows = fullDataRows(text, ",");
    const mapping: ColumnMapping = {
      gross: "gross",
      fee: "fee",
      net: "net",
      payoutId: "automatic_payout_id",
      customerEmail: "customer_email",
      customerName: "customer_name",
      invoiceNumber: "payment_metadata[invoice_number]",
      chargeId: "charge_id",
    };

    const result = validateMapping(sample, rows, mapping, { mode: "signed_column", column: "net" });

    expect(result.ok).toBe(true);
    if (!result.ok || result.kind !== "settlement_lines") throw new Error("expected settlement_lines");
    expect(result.lines).toHaveLength(5);
    expect(result.lines[0]).toMatchObject({ grossCents: 9900, feeCents: 317, netCents: 9583, payoutId: "po_1AbCdEfGhPayout01", customerEmail: "anna.beispiel@example.com" });
    expect(result.lines[2]).toMatchObject({ grossCents: -4900, netCents: -4900 });
  });

  it(
    "F4 review finding (a), decisions/0027-hardening-and-deletion.md: a mapping with " +
      "bookingDate AND a settlement field (gross/fee/net) is classified as settlement_lines, " +
      "never misclassified as a bank statement (bookingDate alone is not a bank-shape signal)",
    () => {
      const sample = minimalSample(["Datum", "Brutto", "Gebühr", "Netto", "Auszahlungs-ID"]);
      const mapping: ColumnMapping = { bookingDate: "Datum", gross: "Brutto", fee: "Gebühr", net: "Netto", payoutId: "Auszahlungs-ID" };
      const rows = [["01.01.2026", "100.00", "3.00", "97.00", "po_1"]];

      const result = validateMapping(sample, rows, mapping, null);

      expect(result.ok).toBe(true);
      if (!result.ok || result.kind !== "settlement_lines") throw new Error("expected settlement_lines, not bank_transactions");
      expect(result.lines).toEqual([expect.objectContaining({ bookingDate: "2026-01-01", grossCents: 10000, feeCents: 300, netCents: 9700 })]);
    },
  );

  it(
    "F4 review finding (a), decisions/0027-hardening-and-deletion.md: an indicator-column " +
      "amount sign is applied to BOTH gross and net (never fee, always positive) for a " +
      "settlement-shaped mapping, not only for a bank-shaped one",
    () => {
      const sample = minimalSample(["Datum", "Brutto", "Gebühr", "Netto", "Typ"]);
      const mapping: ColumnMapping = { bookingDate: "Datum", gross: "Brutto", fee: "Gebühr", net: "Netto" };
      const amountSign = { mode: "indicator_column", amountColumn: "Brutto", indicatorColumn: "Typ", creditValue: "Sale", debitValue: "Return" } as const;
      const rows = [
        ["01.01.2026", "100.00", "3.00", "97.00", "Sale"],
        ["02.01.2026", "50.00", "1.50", "48.50", "Return"],
      ];

      const result = validateMapping(sample, rows, mapping, amountSign);

      expect(result.ok).toBe(true);
      if (!result.ok || result.kind !== "settlement_lines") throw new Error("expected settlement_lines");
      expect(result.lines[0]).toMatchObject({ grossCents: 10000, feeCents: 300, netCents: 9700 });
      // A "Return" row: gross/net both flip negative; fee is never sign-adjusted by the
      // indicator (it is not one of `applyRowSign`'s two callers).
      expect(result.lines[1]).toMatchObject({ grossCents: -5000, feeCents: 150, netCents: -4850 });
    },
  );
});
