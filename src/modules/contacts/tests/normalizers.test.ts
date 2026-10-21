import { describe, expect, it } from "vitest";

import { nameSimilarity, normalizeIban, normalizeName, normalizePlainText, normalizeVatId } from "../core/normalizers";

describe("normalizeVatId", () => {
  it.each([
    ["DE 123 456 789", "DE123456789"],
    ["de123456789", "DE123456789"],
    ["  DE123456789  ", "DE123456789"],
  ])("%s -> %s", (raw, expected) => {
    expect(normalizeVatId(raw)).toBe(expected);
  });
});

describe("normalizeIban", () => {
  it.each([
    ["DE12 3456 7890 1234 5678 90", "DE12345678901234567890"],
    ["de12345678901234567890", "DE12345678901234567890"],
  ])("%s -> %s", (raw, expected) => {
    expect(normalizeIban(raw)).toBe(expected);
  });
});

describe("normalizeName", () => {
  it.each([
    ["Musterwerk GmbH", "musterwerk"],
    ["musterwerk", "musterwerk"],
    ["MUSTERWERK", "musterwerk"],
    ["Musterwerk GmbH & Co. KG", "musterwerk"],
    ["Müller & Söhne GmbH", "müller söhne"],
    ["Bäckerei Schäfer e. K.", "bäckerei schäfer"],
    ["Schmidt AG", "schmidt"],
    ["Schmidt UG", "schmidt"],
    ["  Extra   Spaces   GmbH  ", "extra spaces"],
    ["Kein Rechtsform Suffix", "kein rechtsform suffix"],
  ])("%s -> %s", (raw, expected) => {
    expect(normalizeName(raw)).toBe(expected);
  });

  it("keeps German umlauts and ß intact", () => {
    expect(normalizeName("Straße")).toBe("straße");
    expect(normalizeName("Grün GmbH")).toBe("grün");
  });
});

describe("normalizePlainText", () => {
  it("lowercases, trims, and collapses whitespace", () => {
    expect(normalizePlainText("  Musterstraße   1  ")).toBe("musterstraße 1");
    expect(normalizePlainText("MUSTERSTRASSE 1")).toBe("musterstrasse 1");
  });
});

describe("nameSimilarity", () => {
  it("is 1 for identical normalized names", () => {
    expect(nameSimilarity("musterwerk", "musterwerk")).toBe(1);
  });

  it("is 0 when one side is empty and the other is not", () => {
    expect(nameSimilarity("", "musterwerk")).toBe(0);
    expect(nameSimilarity("musterwerk", "")).toBe(0);
  });

  it("scores a real near-miss below a full match", () => {
    const similarity = nameSimilarity("musterwerk", "musterwerk handel");
    expect(similarity).toBeGreaterThan(0);
    expect(similarity).toBeLessThan(1);
  });

  it("is 0 for completely unrelated names", () => {
    expect(nameSimilarity("musterwerk", "ganz anderes unternehmen")).toBe(0);
  });
});
