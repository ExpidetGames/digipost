import { describe, expect, it } from "vitest";

import { isLikelyBank } from "../core/bank-detection";
import type { ExtractedContactData } from "../core/types";

function party(overrides: Partial<ExtractedContactData> & Pick<ExtractedContactData, "name">): ExtractedContactData {
  return { ...overrides };
}

describe("isLikelyBank", () => {
  it("matches the MUSTERBANK footer case: a party's name equals another party's stated bankName", () => {
    const invoiceSender = party({ name: "Beispielkunde Nord eGbR", bankName: "MUSTERBANK PAYMENTS", iban: "DE43100000000987654321" });
    const footerParty = party({ name: "MUSTERBANK PAYMENTS" });

    expect(isLikelyBank(footerParty, [invoiceSender, footerParty])).toBe(true);
  });

  it("matches a bare bank party carrying only IBAN/BIC and nothing that makes it a business relationship", () => {
    const bareBank = party({ name: "Some Bank AG", iban: "DE43100000000987654321", bic: "COBADEFFXXX" });

    expect(isLikelyBank(bareBank, [bareBank])).toBe(true);
  });

  it("matches a bank-token name with no address and no VAT id, even without explicit bank fields", () => {
    const sparkasse = party({ name: "Sparkasse Berlin" });

    expect(isLikelyBank(sparkasse, [sparkasse])).toBe(true);
  });

  it("matches a payment-processor-worded name (\"Payments\") with no address and no VAT id", () => {
    const musterbank = party({ name: "MUSTERBANK PAYMENTS" });

    expect(isLikelyBank(musterbank, [musterbank])).toBe(true);
  });

  it("does NOT match \"Deutsche Bank Immobilien GmbH\" when it has a full address and a VAT id", () => {
    const realCompany = party({
      name: "Deutsche Bank Immobilien GmbH",
      addressLine1: "Taunusanlage 12",
      postalCode: "60325",
      city: "Frankfurt am Main",
      vatId: "DE123456789",
    });

    expect(isLikelyBank(realCompany, [realCompany])).toBe(false);
  });

  it("does NOT match a normal customer who happens to carry an IBAN and a full address", () => {
    const customer = party({
      name: "Musterwerk GmbH",
      addressLine1: "Musterstrasse 1",
      postalCode: "12345",
      city: "Berlin",
      iban: "DE89370400440532013000",
    });

    expect(isLikelyBank(customer, [customer])).toBe(false);
  });

  it("does NOT match a bank-token name that also has a full address (a real, differently-purposed business)", () => {
    const bausparkasseWithAddress = party({
      name: "Musterhaus Bausparkasse Service GmbH",
      addressLine1: "Servicestrasse 5",
      postalCode: "10115",
      city: "Berlin",
    });

    expect(isLikelyBank(bausparkasseWithAddress, [bausparkasseWithAddress])).toBe(false);
  });

  it("does NOT match a party with no bank fields, no bank-token name, and no other party naming it as their bank", () => {
    const ordinaryContact = party({ name: "Handwerk Mustermann" });

    expect(isLikelyBank(ordinaryContact, [ordinaryContact])).toBe(false);
  });

  it("does NOT match a real incoming fee invoice FROM a bank: a single party whose name equals its own bankName, WITH an address, no VAT id", () => {
    // A bank's own account-fee invoice: the analyzer's single derived counterparty IS the
    // bank, and it (redundantly but harmlessly) also attributed its own name as its own
    // `bankName`. The address is what proves this is a real business party, not a footer
    // artifact - banks are often VAT-exempt, so the address alone must be enough.
    const musterbankFeeInvoiceSender = party({
      name: "MUSTERBANK PAYMENTS",
      bankName: "MUSTERBANK PAYMENTS",
      addressLine1: "Musterstrasse 1",
      postalCode: "10115",
      city: "Berlin",
      iban: "DE43100000000987654321",
    });

    expect(isLikelyBank(musterbankFeeInvoiceSender, [musterbankFeeInvoiceSender])).toBe(false);
  });

  it("does NOT match a letter from \"Sparkasse Oberland\" with a full letterhead address, even though its own footer restates its name as Bankverbindung", () => {
    const sparkasseLetter = party({
      name: "Sparkasse Oberland",
      bankName: "Sparkasse Oberland",
      addressLine1: "Marktplatz 1",
      postalCode: "83646",
      city: "Bad Toelz",
    });

    expect(isLikelyBank(sparkasseLetter, [sparkasseLetter])).toBe(false);
  });

  it("DOES match a single party whose name equals its own bankName, with NO address, via rule 2 (bare bank fields)", () => {
    // Same self-referential bankName attribution as the fee-invoice case above, but with no
    // address at all: rule 1's self-exclusion means this is NOT caught by rule 1 (there is no
    // OTHER party to blame it on), but rule 2 still catches it on its own merits - a party
    // with nothing but bare bank fields and no address is exactly what rule 2 exists for.
    const bareMusterbankFooter = party({ name: "MUSTERBANK PAYMENTS", bankName: "MUSTERBANK PAYMENTS", iban: "DE43100000000987654321" });

    expect(isLikelyBank(bareMusterbankFooter, [bareMusterbankFooter])).toBe(true);
  });
});
