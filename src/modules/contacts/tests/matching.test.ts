import { describe, expect, it } from "vitest";

import { MATCH_RULES, normalizeExtractedForMatching, pickBestMatch } from "../core/matching";
import type { ContactMatchCandidate } from "../core/types";

function candidate(overrides: Partial<ContactMatchCandidate> & Pick<ContactMatchCandidate, "id">): ContactMatchCandidate {
  return {
    nameNormalized: "unrelated",
    postalCode: null,
    vatIdNormalized: null,
    registerCourt: null,
    registerNumber: null,
    ibanNormalized: null,
    customerNumber: null,
    ...overrides,
  };
}

describe("pickBestMatch", () => {
  it("rule 1: matches on vat_id_normalized, strong", () => {
    const candidates = [candidate({ id: "a", vatIdNormalized: "DE123456789" })];
    const extracted = normalizeExtractedForMatching({ name: "Anything GmbH", vatId: "DE 123 456 789" });

    expect(pickBestMatch(extracted, candidates)).toEqual({ contactId: "a", strength: "strong", rule: MATCH_RULES.vatId });
  });

  it("rule 2: matches on register court + number, strong, even without a vat id", () => {
    const candidates = [candidate({ id: "a", registerCourt: "Amtsgericht Musterstadt", registerNumber: "HRB 12345" })];
    const extracted = normalizeExtractedForMatching({
      name: "Anything GmbH",
      registerCourt: "Amtsgericht Musterstadt",
      registerNumber: "HRB 12345",
    });

    expect(pickBestMatch(extracted, candidates)).toEqual({ contactId: "a", strength: "strong", rule: MATCH_RULES.register });
  });

  it("rule 2 requires both register court AND number", () => {
    const candidates = [candidate({ id: "a", registerCourt: "Amtsgericht Musterstadt", registerNumber: "HRB 12345" })];
    const extracted = normalizeExtractedForMatching({ name: "Anything GmbH", registerCourt: "Amtsgericht Musterstadt" });

    expect(pickBestMatch(extracted, candidates)).toBeNull();
  });

  it("rule 3: matches on iban_normalized when exactly one candidate shares it, strong", () => {
    const candidates = [candidate({ id: "a", ibanNormalized: "DE12345678901234567890" })];
    const extracted = normalizeExtractedForMatching({ name: "Anything GmbH", iban: "DE12 3456 7890 1234 5678 90" });

    expect(pickBestMatch(extracted, candidates)).toEqual({ contactId: "a", strength: "strong", rule: MATCH_RULES.iban });
  });

  it("rule 3 is ambiguous (no match) when two candidates share the same iban", () => {
    const candidates = [
      candidate({ id: "a", ibanNormalized: "DE12345678901234567890" }),
      candidate({ id: "b", ibanNormalized: "DE12345678901234567890" }),
    ];
    const extracted = normalizeExtractedForMatching({ name: "Anything GmbH", iban: "DE12345678901234567890" });

    expect(pickBestMatch(extracted, candidates)).toBeNull();
  });

  it("rule 4: matches on customer number plus a similar normalized name, weak", () => {
    const candidates = [candidate({ id: "a", customerNumber: "K-4711", nameNormalized: "musterwerk" })];
    const extracted = normalizeExtractedForMatching({ name: "Musterwerk GmbH", customerNumber: "K-4711" });

    expect(pickBestMatch(extracted, candidates)).toEqual({
      contactId: "a",
      strength: "weak",
      rule: MATCH_RULES.customerNumberAndName,
    });
  });

  it("rule 4 does not match on customer number alone when the name is unrelated", () => {
    const candidates = [candidate({ id: "a", customerNumber: "K-4711", nameNormalized: "voellig anderes unternehmen" })];
    const extracted = normalizeExtractedForMatching({ name: "Musterwerk GmbH", customerNumber: "K-4711" });

    expect(pickBestMatch(extracted, candidates)).toBeNull();
  });

  it("rule 5: matches on exact normalized name + postal code, weak", () => {
    const candidates = [candidate({ id: "a", nameNormalized: "musterwerk", postalCode: "12345" })];
    const extracted = normalizeExtractedForMatching({ name: "Musterwerk GmbH", postalCode: "12345" });

    expect(pickBestMatch(extracted, candidates)).toEqual({
      contactId: "a",
      strength: "weak",
      rule: MATCH_RULES.nameAndPostalCode,
    });
  });

  it("rule 5 requires an exact postal code match, not just a similar name", () => {
    const candidates = [candidate({ id: "a", nameNormalized: "musterwerk", postalCode: "12345" })];
    const extracted = normalizeExtractedForMatching({ name: "Musterwerk GmbH", postalCode: "99999" });

    expect(pickBestMatch(extracted, candidates)).toBeNull();
  });

  it("rule 6: matches on normalized name alone, weak, when the extraction has no postal code and exactly one candidate shares the name", () => {
    const candidates = [candidate({ id: "a", nameNormalized: "musterfirma" })];
    const extracted = normalizeExtractedForMatching({ name: "Musterfirma" });

    expect(pickBestMatch(extracted, candidates)).toEqual({
      contactId: "a",
      strength: "weak",
      rule: MATCH_RULES.nameOnlyUnique,
    });
  });

  it("rule 6 is ambiguous (no match) when two candidates share the same name and neither has a postal code to disambiguate", () => {
    const candidates = [candidate({ id: "a", nameNormalized: "musterfirma" }), candidate({ id: "b", nameNormalized: "musterfirma" })];
    const extracted = normalizeExtractedForMatching({ name: "Musterfirma" });

    expect(pickBestMatch(extracted, candidates)).toBeNull();
  });

  it("rule 6 never fires when the extraction DOES carry a postal code (rule 5 is the one that applies there)", () => {
    const candidates = [candidate({ id: "a", nameNormalized: "musterfirma", postalCode: "99999" })];
    const extracted = normalizeExtractedForMatching({ name: "Musterfirma", postalCode: "12345" });

    // Rule 5 requires an exact postal code match (it does not), and rule 6 is skipped
    // entirely because the extraction has a postal code - no match, not a guess.
    expect(pickBestMatch(extracted, candidates)).toBeNull();
  });

  it("returns null (new contact) when nothing matches", () => {
    const candidates = [candidate({ id: "a" })];
    const extracted = normalizeExtractedForMatching({ name: "Ganz Neue Firma GmbH" });

    expect(pickBestMatch(extracted, candidates)).toBeNull();
  });

  it("tries rules strongest first: a vat id match wins even if a weaker rule would also match a different candidate", () => {
    const candidates = [
      candidate({ id: "weak-match", nameNormalized: "musterwerk", postalCode: "12345" }),
      candidate({ id: "strong-match", vatIdNormalized: "DE123456789", nameNormalized: "different name" }),
    ];
    const extracted = normalizeExtractedForMatching({ name: "Musterwerk GmbH", postalCode: "12345", vatId: "DE123456789" });

    expect(pickBestMatch(extracted, candidates)).toEqual({ contactId: "strong-match", strength: "strong", rule: MATCH_RULES.vatId });
  });
});
