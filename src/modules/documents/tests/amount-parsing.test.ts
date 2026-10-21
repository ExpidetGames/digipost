// C2 (decisions/0021-extraction-direction-and-invoice-fields.md): amount/currency parsing
// never trusts the model's own arithmetic - these are the concrete formats the model is
// asked to reproduce verbatim from the printed document.
import { describe, expect, it } from "vitest";

import { inferCurrency, parseGermanAmountToCents } from "../core/amount-parsing";

describe("parseGermanAmountToCents", () => {
  it.each([
    ["1.083,68", 108368],
    ["1,083.68", 108368],
    ["1083.68", 108368],
    ["EUR 12", 1200],
    ["12", 1200],
    ["12,5", 1250],
    ["1.083", 108300], // thousands separator, no decimal part
    ["49,99 EUR", 4999],
  ])("parses %s to %i cents", (raw, expected) => {
    expect(parseGermanAmountToCents(raw)).toBe(expected);
  });

  it.each([
    ["-49,99", -4999],
    ["49,99-", -4999],
    ["(49,99)", -4999],
  ])("parses a negative/credit-note amount %s to %i cents", (raw, expected) => {
    expect(parseGermanAmountToCents(raw)).toBe(expected);
  });

  it("returns null for an empty, whitespace-only, or absent input", () => {
    expect(parseGermanAmountToCents(null)).toBeNull();
    expect(parseGermanAmountToCents(undefined)).toBeNull();
    expect(parseGermanAmountToCents("")).toBeNull();
    expect(parseGermanAmountToCents("   ")).toBeNull();
  });

  it("returns null for text with no digits at all", () => {
    expect(parseGermanAmountToCents("EUR")).toBeNull();
    expect(parseGermanAmountToCents("kostenlos")).toBeNull();
  });
});

describe("inferCurrency", () => {
  it("prefers a plausible ISO code from the model over the raw text", () => {
    expect(inferCurrency("49.99", "usd")).toBe("USD");
  });

  it("falls back to EUR when a euro sign/word is present and the model gave nothing usable", () => {
    expect(inferCurrency("49,99 €", undefined)).toBe("EUR");
    expect(inferCurrency("49,99 EUR", null)).toBe("EUR");
    expect(inferCurrency("49,99 Euro", "")).toBe("EUR");
  });

  it("returns null when neither the model nor the raw text gives a usable currency", () => {
    expect(inferCurrency("49.99", null)).toBeNull();
    expect(inferCurrency(null, null)).toBeNull();
  });

  it("rejects an implausible model currency (not 3 letters)", () => {
    expect(inferCurrency("49.99", "dollars")).toBeNull();
  });
});
