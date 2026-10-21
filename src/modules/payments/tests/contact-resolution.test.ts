// decisions/0068-supplier-clearing-accounts.md: resolving a bank charge's counterparty to a
// contact, built only from the learned payment names of decisions/0047 and the card-merchant
// tolerance of decisions/0046. The real data this was written against: Meta's twelve invoices
// are filed under "Meta Platforms Ireland Limited" while its card debits read
// "FACEBK *QX7MNP41KD,fb.me/ads" - nothing in the name connects the two, so without a learned
// payment name the charge MUST stay unresolved (the safe failure).
import { describe, expect, it } from "vitest";

import { aliasKeyForCounterparty, resolveContactForCounterparty, type ContactAliasMap } from "@/modules/payments";

const META = { id: "contact-meta", name: "Meta Platforms Ireland Limited" };
const IONOS = { id: "contact-ionos", name: "IONOS SE" };
const NO_ALIASES: ContactAliasMap = new Map();

describe("resolveContactForCounterparty", () => {
  it("resolves a card debit through a learned payment name, ignoring the per-payment reference", () => {
    const aliases: ContactAliasMap = new Map([[aliasKeyForCounterparty("FACEBK"), META.id]]);

    expect(resolveContactForCounterparty("FACEBK *QX7MNP41KD,fb.me/ads", [META, IONOS], aliases)).toBe(META.id);
    expect(resolveContactForCounterparty("FACEBK *ZK3L8RT6YB,fb.me/ads", [META, IONOS], aliases)).toBe(META.id);
  });

  it("resolves by the contact's own name with the card-merchant tolerance", () => {
    expect(resolveContactForCounterparty("IONOS SE,MONTABAUR", [META, IONOS], NO_ALIASES)).toBe(IONOS.id);
  });

  it("resolves nothing for a merchant name that matches no contact", () => {
    expect(resolveContactForCounterparty("FACEBK *QX7MNP41KD,fb.me/ads", [META, IONOS], NO_ALIASES)).toBeNull();
  });

  it("resolves nothing for a missing counterparty name", () => {
    expect(resolveContactForCounterparty(null, [META, IONOS], NO_ALIASES)).toBeNull();
    expect(resolveContactForCounterparty("", [META, IONOS], NO_ALIASES)).toBeNull();
  });

  it("resolves nothing when two contacts are equally similar", () => {
    const first = { id: "c1", name: "Bauwerk Bau" };
    const second = { id: "c2", name: "Bauwerk Bau" };

    expect(resolveContactForCounterparty("Bauwerk Bau", [first, second], NO_ALIASES)).toBeNull();
  });

  it("prefers a learned payment name over any name similarity", () => {
    const aliases: ContactAliasMap = new Map([[aliasKeyForCounterparty("IONOS SE"), META.id]]);

    expect(resolveContactForCounterparty("IONOS SE,MONTABAUR", [META, IONOS], aliases)).toBe(META.id);
  });
});
