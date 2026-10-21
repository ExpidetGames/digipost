import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { sampleTabular } from "../core/tabular-sample";

function readFixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");
}

describe("sampleTabular", () => {
  it("detects the semicolon delimiter and German amount format for the Musterbank fixture", () => {
    const sample = sampleTabular(readFixture("musterbank-statement.csv"));

    expect(sample.delimiter).toBe(";");
    expect(sample.header).toEqual(["Buchungsdatum", "Wertstellung", "Betrag", "Währung", "Empfänger/Auftraggeber", "IBAN", "Verwendungszweck"]);
    expect(sample.rowCount).toBe(7);
    expect(sample.rows.length).toBeLessThanOrEqual(10);

    const amountColumn = sample.columns.find((c) => c.name === "Betrag")!;
    expect(amountColumn.type).toBe("amount");
    expect(amountColumn.amountFormat).toEqual({ decimalSeparator: ",", thousandsSeparator: "." });

    const dateColumn = sample.columns.find((c) => c.name === "Buchungsdatum")!;
    expect(dateColumn.type).toBe("date");
    expect(dateColumn.dateFormat).toBe("DD.MM.YYYY");

    const ibanColumn = sample.columns.find((c) => c.name === "IBAN")!;
    expect(ibanColumn.type).toBe("iban");
  });

  it("detects the comma delimiter for the Stripe payout fixture", () => {
    const sample = sampleTabular(readFixture("stripe-payout.csv"));

    expect(sample.delimiter).toBe(",");
    expect(sample.header).toContain("balance_transaction_id");
    expect(sample.header).toContain("automatic_payout_id");
    expect(sample.rowCount).toBe(5);

    const createdColumn = sample.columns.find((c) => c.name === "created_utc")!;
    expect(createdColumn.type).toBe("date");
    expect(createdColumn.dateFormat).toBe("YYYY-MM-DDTHH:mm:ss");
  });

  it("detects the tab delimiter for the Apple financial report fixture", () => {
    const sample = sampleTabular(readFixture("apple-financial-report.tsv"));

    expect(sample.delimiter).toBe("\t");
    expect(sample.header).toContain("Vendor Identifier");
    expect(sample.header).toContain("Partner Share");
    expect(sample.rowCount).toBe(4);
  });

  it("detects quoted fields for the Sparkasse fixture", () => {
    const sample = sampleTabular(readFixture("sparkasse-statement.csv"));

    expect(sample.delimiter).toBe(";");
    expect(sample.header).toContain("Auftragskonto");
    expect(sample.header).toContain("Glaeubiger ID");
    expect(sample.rowCount).toBe(4);
  });

  it("computes the same fingerprint for the same header/delimiter/column-count and a different one otherwise", () => {
    const a = sampleTabular("h1,h2\n1,2\n");
    const b = sampleTabular("h1,h2\n9,9\n9,9\n"); // same header/delimiter, different data
    const c = sampleTabular("h1,h2,h3\n1,2,3\n"); // different column count

    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.fingerprint).not.toBe(c.fingerprint);
  });

  it("caps the sample at maxSampleRows while rowCount reflects the whole file", () => {
    const header = "a,b\n";
    const rows = Array.from({ length: 25 }, (_, i) => `${i},${i}`).join("\n");
    const sample = sampleTabular(header + rows, { maxSampleRows: 5 });

    expect(sample.rows).toHaveLength(5);
    expect(sample.rowCount).toBe(25);
  });
});
