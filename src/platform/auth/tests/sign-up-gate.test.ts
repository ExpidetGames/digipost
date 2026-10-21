import { describe, expect, it } from "vitest";

import { mayCreateAccount, mayReceiveMagicLink, parseBootstrapEmails } from "../server/sign-up-gate";

// decisions/0074-sign-up-by-invitation-only.md
const none = { hasAccount: false, hasPendingInvitation: false };
const member = { hasAccount: true, hasPendingInvitation: false };
const invited = { hasAccount: false, hasPendingInvitation: true };

describe("parseBootstrapEmails", () => {
  it("splits, trims and lowercases, dropping empty entries", () => {
    expect([...parseBootstrapEmails(" Admin@Example.com, ,second@example.com ")]).toEqual(["admin@example.com", "second@example.com"]);
  });

  it("is empty when unset", () => {
    expect(parseBootstrapEmails(undefined).size).toBe(0);
    expect(parseBootstrapEmails("").size).toBe(0);
  });
});

describe("mayCreateAccount", () => {
  it("allows an invited address", () => {
    expect(mayCreateAccount("neu@example.com", invited, new Set())).toBe(true);
  });

  it("allows a bootstrap address, case-insensitively", () => {
    expect(mayCreateAccount("Admin@Example.com", none, parseBootstrapEmails("admin@example.com"))).toBe(true);
  });

  it("refuses everyone else", () => {
    expect(mayCreateAccount("fremd@example.com", none, parseBootstrapEmails("admin@example.com"))).toBe(false);
  });
});

describe("mayReceiveMagicLink", () => {
  it("mails an existing account", () => {
    expect(mayReceiveMagicLink("mitglied@example.com", member, new Set())).toBe(true);
  });

  it("mails an invited address", () => {
    expect(mayReceiveMagicLink("neu@example.com", invited, new Set())).toBe(true);
  });

  it("does not mail an address with neither", () => {
    expect(mayReceiveMagicLink("fremd@example.com", none, new Set())).toBe(false);
  });
});
