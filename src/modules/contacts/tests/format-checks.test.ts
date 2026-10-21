import { describe, expect, it } from "vitest";

import { checkContactFormats, isPlausibleVatId, isValidIbanFormat } from "../core/format-checks";
import { CONTACT_FORMAT_WARNING } from "../core/error-codes";

describe("isValidIbanFormat", () => {
  it.each([
    ["DE89 3704 0044 0532 0130 00", true], // well-known valid example IBAN
    ["DE89370400440532013000", true],
    ["GB29 NWBK 6016 1331 9268 19", true],
  ])("%s -> %s", (raw, expected) => {
    expect(isValidIbanFormat(raw)).toBe(expected);
  });

  it.each([
    ["DE89 3704 0044 0532 0130 01", false], // wrong checksum
    ["not an iban", false],
    ["DE12", false],
    ["", false],
  ])("%s -> %s (invalid)", (raw, expected) => {
    expect(isValidIbanFormat(raw)).toBe(expected);
  });
});

describe("isPlausibleVatId", () => {
  it.each([
    ["DE123456789", true],
    ["de 123456789", true],
    ["ATU12345678", true],
    ["FR12345678901", true],
  ])("%s -> %s", (raw, expected) => {
    expect(isPlausibleVatId(raw)).toBe(expected);
  });

  it.each([
    ["DE12345678", false], // only 8 digits
    ["DE1234567890", false], // 10 digits
    ["12345", false],
  ])("%s -> %s (invalid)", (raw, expected) => {
    expect(isPlausibleVatId(raw)).toBe(expected);
  });
});

describe("checkContactFormats", () => {
  it("returns no warnings for blank/absent input", () => {
    expect(checkContactFormats({})).toEqual([]);
    expect(checkContactFormats({ iban: "", vatId: "  " })).toEqual([]);
  });

  it("warns (never throws) on a malformed iban/vat id", () => {
    const warnings = checkContactFormats({ iban: "not an iban", vatId: "DE12345678" });
    expect(warnings).toContain(CONTACT_FORMAT_WARNING.invalidIban);
    expect(warnings).toContain(CONTACT_FORMAT_WARNING.invalidVatId);
  });

  it("returns no warnings for valid values", () => {
    expect(checkContactFormats({ iban: "DE89370400440532013000", vatId: "DE123456789" })).toEqual([]);
  });
});
