import { describe, expect, it } from "vitest";

import { parseIntakeClassification } from "../core/classification";

describe("parseIntakeClassification", () => {
  it("parses a valid text classification with no column mapping", () => {
    const result = parseIntakeClassification({ documentKind: "reminder", confidence: 0.9, reason: "Enthält das Wort Mahnung.", platform: null, columnMapping: null, amountSign: null });
    expect(result).toEqual({ documentKind: "reminder", confidence: 0.9, reason: "Enthält das Wort Mahnung.", platform: null, columnMapping: null, amountSign: null });
  });

  it("parses a valid tabular classification with a column mapping validated against the header", () => {
    const header = ["Buchungsdatum", "Betrag", "IBAN"];
    const raw = {
      documentKind: "bank_statement",
      confidence: 0.95,
      reason: "Kontoauszug erkannt.",
      platform: null,
      columnMapping: { bookingDate: "Buchungsdatum", amount: "Betrag", counterpartyIban: "IBAN" },
      amountSign: { mode: "signed_column", column: "Betrag" },
    };
    const result = parseIntakeClassification(raw, header);
    expect(result.columnMapping).toEqual({ bookingDate: "Buchungsdatum", amount: "Betrag", counterpartyIban: "IBAN" });
    expect(result.amountSign).toEqual({ mode: "signed_column", column: "Betrag" });
  });

  it("drops a hallucinated column name from columnMapping (not present in the header)", () => {
    const header = ["Buchungsdatum", "Betrag"];
    const raw = {
      documentKind: "bank_statement",
      confidence: 0.9,
      reason: "Kontoauszug.",
      platform: null,
      columnMapping: { bookingDate: "Buchungsdatum", amount: "Betrag", reference: "Verwendungszweck (erfunden)" },
      amountSign: null,
    };
    const result = parseIntakeClassification(raw, header);
    expect(result.columnMapping).toEqual({ bookingDate: "Buchungsdatum", amount: "Betrag" });
  });

  it("drops amountSign entirely when it references a column not in the header", () => {
    const header = ["Buchungsdatum", "Betrag"];
    const raw = {
      documentKind: "bank_statement",
      confidence: 0.9,
      reason: "Kontoauszug.",
      platform: null,
      columnMapping: null,
      amountSign: { mode: "signed_column", column: "Nicht Vorhanden" },
    };
    expect(parseIntakeClassification(raw, header).amountSign).toBeNull();
  });

  it("drops an unknown semantic field key entirely, even if its column exists", () => {
    const header = ["Buchungsdatum"];
    const raw = {
      documentKind: "bank_statement",
      confidence: 0.9,
      reason: "Kontoauszug.",
      platform: null,
      columnMapping: { notARealSemanticField: "Buchungsdatum" },
      amountSign: null,
    };
    expect(parseIntakeClassification(raw, header).columnMapping).toBeNull();
  });

  it("becomes null (not an empty object) when every mapping entry is dropped", () => {
    const header = ["Buchungsdatum"];
    const raw = { documentKind: "other", confidence: 0.5, reason: "x", platform: null, columnMapping: { amount: "Erfunden" }, amountSign: null };
    expect(parseIntakeClassification(raw, header).columnMapping).toBeNull();
  });

  it("degrades to the safe fallback for a completely malformed response", () => {
    expect(parseIntakeClassification("not even an object")).toEqual({
      documentKind: "other",
      confidence: 0,
      reason: "Die Antwort des Modells konnte nicht ausgewertet werden.",
      platform: null,
      columnMapping: null,
      amountSign: null,
    });
  });

  it("degrades to the safe fallback for an unknown documentKind", () => {
    const result = parseIntakeClassification({ documentKind: "made-up-kind", confidence: 0.9, reason: "x", platform: null, columnMapping: null, amountSign: null });
    expect(result.documentKind).toBe("other");
    expect(result.confidence).toBe(0);
  });

  it("degrades to the safe fallback for confidence out of range", () => {
    const result = parseIntakeClassification({ documentKind: "letter", confidence: 1.5, reason: "x", platform: null, columnMapping: null, amountSign: null });
    expect(result.documentKind).toBe("other");
  });
});
