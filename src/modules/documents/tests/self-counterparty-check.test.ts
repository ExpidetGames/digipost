// H2-wave2.md's self-counterparty guard (decisions/0036-guided-extraction.md's wave 2).
import { describe, expect, it } from "vitest";

import type { OwnCompanyProfile } from "@/modules/contacts";

import { isCounterpartySelf } from "../core/self-counterparty-check";

const OWN_COMPANY: OwnCompanyProfile = {
  name: "Muster Werkstatt GmbH",
  postalCode: "10115",
  vatId: "DE111222333",
  aliases: ["musterfirma"],
  ibans: ["DE89370400440532013000"],
  domains: ["muster-werkstatt.de"],
  taxNumber: null,
  registerCourt: null,
  registerNumber: null,
};

describe("isCounterpartySelf", () => {
  it("is true when the counterparty's name equals our own name", () => {
    expect(isCounterpartySelf({ name: "Muster Werkstatt GmbH" }, OWN_COMPANY)).toBe(true);
  });

  it("is true when the counterparty's name equals one of our aliases", () => {
    expect(isCounterpartySelf({ name: "Musterfirma" }, OWN_COMPANY)).toBe(true);
  });

  it("is true when the counterparty's domain equals one of ours", () => {
    expect(isCounterpartySelf({ name: "Irgendeine Firma GmbH", website: "https://muster-werkstatt.de" }, OWN_COMPANY)).toBe(true);
  });

  it("is false for a genuine, unrelated counterparty", () => {
    expect(isCounterpartySelf({ name: "Kunde GmbH" }, OWN_COMPANY)).toBe(false);
  });

  it("strips a matching own IBAN before checking - the IBAN itself never decides", () => {
    // Even though the counterparty happens to carry OUR OWN iban (the model's attribution of
    // an IBAN to a party is unreliable, H-contract.md section 1) it is not otherwise
    // recognizable as us, so it must NOT be flagged.
    expect(isCounterpartySelf({ name: "Kunde GmbH", iban: "DE89370400440532013000" }, OWN_COMPANY)).toBe(false);
  });

  it("strips a matching own VAT id before checking, same reasoning", () => {
    // A genuine business named similarly (but not identically) to us, with our OWN VAT id
    // wrongly attached by the model, must not be flagged as self on the VAT id alone once it
    // is stripped - only if what remains ALSO matches on a real rule.
    expect(isCounterpartySelf({ name: "Kunde GmbH", vatId: "DE111222333" }, OWN_COMPANY)).toBe(false);
  });

  it("still fires on a real own-company signal even after stripping an unrelated own IBAN", () => {
    // The IBAN is stripped (it happens to be ours), but the name still matches - the guard
    // must still fire.
    expect(isCounterpartySelf({ name: "Muster Werkstatt GmbH", iban: "DE89370400440532013000" }, OWN_COMPANY)).toBe(true);
  });

  it("normalizes IBAN comparison (spacing/case) when stripping", () => {
    const result = isCounterpartySelf({ name: "Kunde GmbH", iban: "de89 3704 0044 0532 0130 00" }, OWN_COMPANY);
    expect(result).toBe(false);
  });

  it("never throws when ownCompany has no VAT id or IBANs set", () => {
    const bareOwnCompany: OwnCompanyProfile = { name: "Muster GmbH", postalCode: null, vatId: null, aliases: [], ibans: [], domains: [], taxNumber: null, registerCourt: null, registerNumber: null };
    expect(() => isCounterpartySelf({ name: "Kunde GmbH" }, bareOwnCompany)).not.toThrow();
    expect(isCounterpartySelf({ name: "Kunde GmbH" }, bareOwnCompany)).toBe(false);
  });
});
