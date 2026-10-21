import { describe, expect, it } from "vitest";

import { resolveAccountByIban } from "../core/account-resolution";

describe("resolveAccountByIban", () => {
  const accounts = [
    { id: "a1", iban: "DE89370400440532013000" },
    { id: "a2", iban: "DE12500105170648489890" },
    { id: "a3", iban: null },
  ];

  it("matches an already-normalized IBAN exactly", () => {
    expect(resolveAccountByIban(accounts, "DE89370400440532013000")).toBe("a1");
  });

  it("matches a differently-formatted IBAN (spaces, lowercase) to the same account", () => {
    expect(resolveAccountByIban(accounts, "de89 3704 0044 0532 0130 00")).toBe("a1");
  });

  it("returns null for an IBAN no account holds", () => {
    expect(resolveAccountByIban(accounts, "DE00000000000000000000")).toBeNull();
  });

  it("returns null for a null/blank candidate IBAN (the pending-account case)", () => {
    expect(resolveAccountByIban(accounts, null)).toBeNull();
    expect(resolveAccountByIban(accounts, "  ")).toBeNull();
  });

  it("never matches an account with no IBAN of its own", () => {
    expect(resolveAccountByIban(accounts, "")).toBeNull();
  });
});
