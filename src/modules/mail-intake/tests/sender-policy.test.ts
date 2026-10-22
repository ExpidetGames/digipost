import { describe, expect, it } from "vitest";

import { isSenderAllowed, isSenderAuthenticated, normalizeAllowedSenderEntry } from "@/modules/mail-intake";

describe("normalizeAllowedSenderEntry", () => {
  it("normalizes an address", () => {
    expect(normalizeAllowedSenderEntry(" Rechnung@Lieferant.DE ")).toEqual({ kind: "email", value: "rechnung@lieferant.de" });
  });

  it("normalizes the domain forms", () => {
    expect(normalizeAllowedSenderEntry("lieferant.de")).toEqual({ kind: "domain", value: "lieferant.de" });
    expect(normalizeAllowedSenderEntry("@lieferant.de")).toEqual({ kind: "domain", value: "lieferant.de" });
    expect(normalizeAllowedSenderEntry("*@Lieferant.de")).toEqual({ kind: "domain", value: "lieferant.de" });
  });

  it("rejects what is neither", () => {
    for (const input of ["", "lieferant", "http://lieferant.de", "a b@lieferant.de", "rechnung@", "@", "foo@bar"]) {
      expect(normalizeAllowedSenderEntry(input), input).toBeNull();
    }
  });
});

describe("isSenderAllowed", () => {
  const entries = [
    { kind: "email" as const, value: "rechnung@lieferant.de" },
    { kind: "domain" as const, value: "steuerberater.de" },
  ];

  it("lets anyone through under the anyone policy", () => {
    expect(isSenderAllowed({ policy: "anyone", from: "spam@example.com", entries: [], memberEmails: [] })).toBe(true);
  });

  it("allows workspace members implicitly under the allowlist policy", () => {
    expect(isSenderAllowed({ policy: "allowlist", from: "Chef <Chef@Firma.de>", entries: [], memberEmails: ["chef@firma.de"] })).toBe(true);
  });

  it("matches an exact address entry", () => {
    expect(isSenderAllowed({ policy: "allowlist", from: "Rechnung@Lieferant.de", entries, memberEmails: [] })).toBe(true);
    expect(isSenderAllowed({ policy: "allowlist", from: "info@lieferant.de", entries, memberEmails: [] })).toBe(false);
  });

  it("matches a domain entry and its subdomains, never a lookalike", () => {
    expect(isSenderAllowed({ policy: "allowlist", from: "kanzlei@steuerberater.de", entries, memberEmails: [] })).toBe(true);
    expect(isSenderAllowed({ policy: "allowlist", from: "x@mail.steuerberater.de", entries, memberEmails: [] })).toBe(true);
    expect(isSenderAllowed({ policy: "allowlist", from: "x@evilsteuerberater.de", entries, memberEmails: [] })).toBe(false);
    expect(isSenderAllowed({ policy: "allowlist", from: "x@steuerberater.de.evil.com", entries, memberEmails: [] })).toBe(false);
  });

  it("rejects an unparsable sender under the allowlist policy", () => {
    expect(isSenderAllowed({ policy: "allowlist", from: "nobody", entries, memberEmails: [] })).toBe(false);
  });
});

describe("isSenderAuthenticated", () => {
  it("trusts DMARC pass on its own", () => {
    expect(isSenderAuthenticated({ dmarc: "pass", spf: null, dkim: null })).toBe(true);
    expect(isSenderAuthenticated({ dmarc: "PASS", spf: "fail", dkim: "fail" })).toBe(true);
  });

  it("refuses any DMARC verdict other than pass/none, whatever SPF and DKIM say", () => {
    expect(isSenderAuthenticated({ dmarc: "fail", spf: "pass", dkim: "pass" })).toBe(false);
    expect(isSenderAuthenticated({ dmarc: "temperror", spf: "pass", dkim: "pass" })).toBe(false);
  });

  it("without DMARC, needs both SPF and DKIM to pass", () => {
    expect(isSenderAuthenticated({ dmarc: null, spf: "pass", dkim: "pass" })).toBe(true);
    expect(isSenderAuthenticated({ dmarc: "none", spf: "pass", dkim: "pass" })).toBe(true);
    expect(isSenderAuthenticated({ dmarc: "none", spf: "pass", dkim: "fail" })).toBe(false);
    expect(isSenderAuthenticated({ dmarc: null, spf: null, dkim: "pass" })).toBe(false);
  });

  it("fails closed without any authentication data", () => {
    expect(isSenderAuthenticated(null)).toBe(false);
    expect(isSenderAuthenticated({ dmarc: null, spf: null, dkim: null })).toBe(false);
  });
});
