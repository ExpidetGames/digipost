import { describe, expect, it } from "vitest";

import { isOwnCompany } from "../core/own-company";
import type { OwnCompanyProfile } from "../core/types";

const ownCompany: OwnCompanyProfile = {
  name: "Musterwerk GmbH",
  postalCode: "12345",
  vatId: "DE123456789",
  aliases: [],
  ibans: [],
  domains: [],
  taxNumber: null,
  registerCourt: null,
  registerNumber: null,
};

describe("isOwnCompany", () => {
  it("matches on vat id alone", () => {
    expect(isOwnCompany({ name: "Some Other Spelling GmbH", postalCode: null, vatId: "DE 123 456 789" }, ownCompany)).toBe(true);
  });

  it("matches on name + postal code when the name is a close variant", () => {
    expect(isOwnCompany({ name: "musterwerk", postalCode: "12345", vatId: null }, ownCompany)).toBe(true);
  });

  it("does not match a near-miss name even with the same postal code", () => {
    expect(isOwnCompany({ name: "Musterwerk Handel GmbH", postalCode: "12345", vatId: null }, ownCompany)).toBe(false);
  });

  it("does not match when the postal code differs, regardless of name similarity", () => {
    // A near-variant name, not an exact match to `ownCompany.name` - an EXACT match would hit
    // rule 4 (whole-name equality against the own name itself) unconditionally, which this
    // test is not exercising (that is `own-company.test.ts`'s "matches the own name exactly"
    // case below).
    expect(isOwnCompany({ name: "Musterwerk Vertriebs GmbH", postalCode: "99999", vatId: null }, ownCompany)).toBe(false);
  });

  it("matches the own name exactly, even with no other data at all (rule 4)", () => {
    expect(isOwnCompany({ name: "Musterwerk GmbH", postalCode: "99999", vatId: null }, ownCompany)).toBe(true);
  });

  it("does not match an unrelated company", () => {
    expect(isOwnCompany({ name: "Voellig Anderes Unternehmen AG", postalCode: "99999", vatId: "DE999999999" }, ownCompany)).toBe(false);
  });

  it("never matches when the workspace has not filled in its own company profile yet", () => {
    const emptyProfile: OwnCompanyProfile = {
      name: "Musterwerk GmbH",
      postalCode: null,
      vatId: null,
      aliases: [],
      ibans: [],
      domains: [],
      taxNumber: null,
      registerCourt: null,
      registerNumber: null,
    };
    // A near-variant name (not an exact match to `emptyProfile.name`, which would hit rule 4
    // unconditionally regardless of how empty the rest of the profile is - the workspace's own
    // name is always known, never part of "not filled in yet").
    expect(isOwnCompany({ name: "Musterwerk Vertriebs GmbH", postalCode: "12345", vatId: "DE123456789" }, emptyProfile)).toBe(false);
  });

  // decisions/0034-extended-company-profile.md: the extended profile's new match rules.
  describe("extended profile (decisions/0034)", () => {
    const brandOwnCompany: OwnCompanyProfile = {
      name: "Mustermann Max Karl Konstantin, Erika Maria Beispiel GbR",
      postalCode: "10115",
      vatId: null,
      // Already normalized with `normalizeName`, matching `OwnCompanyProfile`'s own contract.
      aliases: ["musterfirma", "erika maria beispiel gbr"],
      ibans: ["DE89370400440532013000"],
      domains: ["musterfirma.de"],
      taxNumber: null,
      registerCourt: null,
      registerNumber: null,
    };

    it("matches a brand name with no address when it is an alias", () => {
      expect(isOwnCompany({ name: "Musterfirma", postalCode: null, vatId: null }, brandOwnCompany)).toBe(true);
    });

    it("matches a short-form company name when it is an alias", () => {
      expect(isOwnCompany({ name: "Erika Maria Beispiel GbR", postalCode: null, vatId: null }, brandOwnCompany)).toBe(true);
    });

    it("does not match a substring of an alias (whole-name only)", () => {
      const softwareOwnCompany: OwnCompanyProfile = { ...brandOwnCompany, aliases: ["software"] };
      expect(isOwnCompany({ name: "Mobile Software AG", postalCode: null, vatId: null }, softwareOwnCompany)).toBe(false);
    });

    // Deliberately NOT a rule (see `isOwnCompany`'s own doc comment, "Deliberately NOT a
    // rule"): a real customer the model mislabeled with our own IBAN must NOT be treated as
    // "own company" and silently dropped from the contact book. `ownCompany.ibans` is real
    // (the column/validation/UI all exist), it is simply never consulted by this function -
    // `ExtractedContactData` no longer even offers an `iban` field to `isOwnCompany`'s own
    // parameter type, so there is no code path left that could read one here.
    it("does NOT match a real party just because it carries one of our own IBANs", () => {
      expect(isOwnCompany({ name: "Beispielkunde Nord eGbR", postalCode: null, vatId: null }, brandOwnCompany)).toBe(false);
    });

    it("matches on the own domain found in a party's website", () => {
      expect(
        isOwnCompany({ name: "Unbekannt", postalCode: null, vatId: null, website: "https://www.musterfirma.de/impressum" }, brandOwnCompany),
      ).toBe(true);
    });

    it("matches on the own domain found in a party's e-mail address", () => {
      expect(
        isOwnCompany({ name: "Unbekannt", postalCode: null, vatId: null, email: "rechnung@musterfirma.de" }, brandOwnCompany),
      ).toBe(true);
    });

    it("matches on register court + register number, both required", () => {
      const registeredOwnCompany: OwnCompanyProfile = { ...brandOwnCompany, registerCourt: "Amtsgericht Charlottenburg", registerNumber: "HRB 123456" };
      expect(
        isOwnCompany(
          { name: "Unbekannt", postalCode: null, vatId: null, registerCourt: "amtsgericht charlottenburg", registerNumber: "HRB 123456" },
          registeredOwnCompany,
        ),
      ).toBe(true);
    });

    it("does not match register number alone without a matching court", () => {
      const registeredOwnCompany: OwnCompanyProfile = { ...brandOwnCompany, registerCourt: "Amtsgericht Charlottenburg", registerNumber: "HRB 123456" };
      expect(
        isOwnCompany(
          { name: "Unbekannt", postalCode: null, vatId: null, registerCourt: "Amtsgericht Muenchen", registerNumber: "HRB 123456" },
          registeredOwnCompany,
        ),
      ).toBe(false);
    });

    it("never consults free profile text - there is no code path reading it here", () => {
      // `OwnCompanyProfile` has no `profileText` field at all: this is a type-level
      // guarantee, not just a behavioral one - there is nothing for `isOwnCompany` to read
      // even if it wanted to. The one runtime case worth asserting: a party matching on
      // structured data alone still works regardless.
      expect(isOwnCompany({ name: "Musterfirma", postalCode: null, vatId: null }, brandOwnCompany)).toBe(true);
    });
  });
});
