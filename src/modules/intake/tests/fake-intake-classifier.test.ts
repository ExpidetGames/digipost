import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { createFakeIntakeClassifier } from "../core/fake-intake-classifier";
import { sampleTabular } from "../core/tabular-sample";

function readFixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");
}

describe("createFakeIntakeClassifier", () => {
  const classifier = createFakeIntakeClassifier();

  it("recognizes a Stripe payout report by its header signature", async () => {
    const sample = sampleTabular(readFixture("stripe-payout.csv"));
    const result = await classifier.classify({ kind: "tabular", sample });

    expect(result.documentKind).toBe("payout_report");
    expect(result.platform).toBe("stripe");
    expect(result.columnMapping).toMatchObject({ payoutId: "automatic_payout_id", net: "net" });
    expect(result.amountSign).toEqual({ mode: "signed_column", column: "net" });
  });

  it("recognizes an Apple financial report by its header signature, with an indicator-column amount sign", async () => {
    const sample = sampleTabular(readFixture("apple-financial-report.tsv"));
    const result = await classifier.classify({ kind: "tabular", sample });

    expect(result.documentKind).toBe("platform_settlement");
    expect(result.platform).toBe("apple");
    expect(result.amountSign).toEqual({
      mode: "indicator_column",
      amountColumn: "Extended Partner Share",
      indicatorColumn: "Sales or Return",
      creditValue: "S",
      debitValue: "R",
    });
  });

  it("recognizes a Sparkasse-style bank statement by its header signature", async () => {
    const sample = sampleTabular(readFixture("sparkasse-statement.csv"));
    const result = await classifier.classify({ kind: "tabular", sample });

    expect(result.documentKind).toBe("bank_statement");
    expect(result.platform).toBeNull();
    expect(result.columnMapping).toMatchObject({ bookingDate: "Buchungstag", amount: "Betrag" });
  });

  it("recognizes a Musterbank-style bank statement by its header signature", async () => {
    const sample = sampleTabular(readFixture("musterbank-statement.csv"));
    const result = await classifier.classify({ kind: "tabular", sample });

    expect(result.documentKind).toBe("bank_statement");
    expect(result.columnMapping).toMatchObject({ bookingDate: "Buchungsdatum", amount: "Betrag", counterpartyIban: "IBAN" });
  });

  it("falls back to 'other' with low confidence for an unrecognized tabular layout", async () => {
    const sample = sampleTabular("Spalte1,Spalte2\nfoo,bar\n");
    const result = await classifier.classify({ kind: "tabular", sample });

    expect(result.documentKind).toBe("other");
    expect(result.confidence).toBeLessThan(0.5);
  });

  it("classifies German OCR text via keyword rules", async () => {
    expect((await classifier.classify({ kind: "text", text: "Erste Mahnung: Bitte begleichen Sie den offenen Betrag." })).documentKind).toBe("reminder");
    expect((await classifier.classify({ kind: "text", text: "Rechnungsnummer 4711, Telekom Deutschland GmbH" })).documentKind).toBe("incoming_invoice");
    expect((await classifier.classify({ kind: "text", text: "Kassenbon vom 01.08.2026" })).documentKind).toBe("receipt");
    expect((await classifier.classify({ kind: "text", text: "Mietvertrag zwischen den Parteien" })).documentKind).toBe("contract");
    expect((await classifier.classify({ kind: "text", text: "Bescheid des Finanzamts Muenchen" })).documentKind).toBe("authority_letter");
  });

  it("falls back to 'letter' for text with no recognized keyword", async () => {
    const result = await classifier.classify({ kind: "text", text: "Liebe Gruesse aus dem Urlaub" });
    expect(result.documentKind).toBe("letter");
    expect(result.confidence).toBeLessThan(0.5);
  });

  it("is deterministic across repeated calls", async () => {
    const sample = sampleTabular(readFixture("stripe-payout.csv"));
    const first = await classifier.classify({ kind: "tabular", sample });
    const second = await classifier.classify({ kind: "tabular", sample });
    expect(first).toEqual(second);
  });
});
