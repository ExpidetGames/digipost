import { describe, expect, it } from "vitest";

import { detectAmountFormat, GERMAN_AMOUNT_FORMAT, parseAmountToCents, PLAIN_POINT_AMOUNT_FORMAT, US_AMOUNT_FORMAT } from "../core/amount-parsing";

describe("detectAmountFormat", () => {
  it("detects the German thousands format", () => {
    expect(detectAmountFormat(["1.083,68", "250,00", "-45,99"])).toEqual(GERMAN_AMOUNT_FORMAT);
  });

  it("detects the US thousands format", () => {
    expect(detectAmountFormat(["1,083.68", "250.00", "-45.99"])).toEqual(US_AMOUNT_FORMAT);
  });

  it("returns null when nothing matches a known shape", () => {
    expect(detectAmountFormat(["not a number", ""])).toBeNull();
  });
});

describe("parseAmountToCents", () => {
  it("parses a German-formatted amount with thousands separator", () => {
    expect(parseAmountToCents("1.083,68", GERMAN_AMOUNT_FORMAT)).toBe(108368);
  });

  it("parses a negative German-formatted amount", () => {
    expect(parseAmountToCents("-45,99", GERMAN_AMOUNT_FORMAT)).toBe(-4599);
  });

  it("parses a US-formatted amount with thousands separator", () => {
    expect(parseAmountToCents("1,083.68", US_AMOUNT_FORMAT)).toBe(108368);
  });

  it("parses a plain point amount with no thousands separator", () => {
    expect(parseAmountToCents("99.00", PLAIN_POINT_AMOUNT_FORMAT)).toBe(9900);
  });

  it("treats accounting-style parentheses as negative", () => {
    expect(parseAmountToCents("(45,99)", GERMAN_AMOUNT_FORMAT)).toBe(-4599);
  });

  it("strips a currency symbol/code before parsing", () => {
    expect(parseAmountToCents("€ 1.083,68", GERMAN_AMOUNT_FORMAT)).toBe(108368);
    expect(parseAmountToCents("1.083,68 EUR", GERMAN_AMOUNT_FORMAT)).toBe(108368);
  });

  it("returns null for an unparseable value", () => {
    expect(parseAmountToCents("not a number", GERMAN_AMOUNT_FORMAT)).toBeNull();
  });

  it("returns null for an empty value", () => {
    expect(parseAmountToCents("", GERMAN_AMOUNT_FORMAT)).toBeNull();
  });
});
