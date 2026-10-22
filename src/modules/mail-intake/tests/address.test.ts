import { describe, expect, it } from "vitest";

import {
  collectInboundTokens,
  extractEmailAddress,
  formatInboundAddress,
  generateInboundToken,
  INBOUND_TOKEN_ALPHABET,
  INBOUND_TOKEN_LENGTH,
  isValidInboundToken,
  parseInboundRecipient,
} from "@/modules/mail-intake";

const DOMAIN = "inbox-test.resend.app";
const TOKEN = "abcdefghjkmnpqrstvwx";

describe("generateInboundToken", () => {
  it("is 20 characters from the lookalike-free alphabet", () => {
    for (let i = 0; i < 50; i++) {
      const token = generateInboundToken();
      expect(token).toHaveLength(INBOUND_TOKEN_LENGTH);
      expect(isValidInboundToken(token)).toBe(true);
      expect(token).not.toMatch(/[ilou01]/);
    }
  });

  it("carries at least 80 bits of entropy", () => {
    expect(INBOUND_TOKEN_LENGTH * Math.log2(INBOUND_TOKEN_ALPHABET.length)).toBeGreaterThanOrEqual(80);
  });

  it("discards biased bytes (rejection sampling) instead of folding them in", () => {
    let call = 0;
    // First call: only bytes >= 240 (all rejected), then a run of zeros.
    const token = generateInboundToken((length) => new Uint8Array(length).fill(call++ === 0 ? 250 : 0));
    expect(token).toBe("a".repeat(INBOUND_TOKEN_LENGTH));
  });

  it("does not repeat across calls", () => {
    const tokens = new Set(Array.from({ length: 200 }, () => generateInboundToken()));
    expect(tokens.size).toBe(200);
  });
});

describe("formatInboundAddress", () => {
  it("builds post-<token>@<domain>, lowercasing the domain", () => {
    expect(formatInboundAddress(TOKEN, "Inbox-Test.Resend.App")).toBe(`post-${TOKEN}@${DOMAIN}`);
  });
});

describe("extractEmailAddress", () => {
  it("reads a bare address or a display-name form, lowercased", () => {
    expect(extractEmailAddress("Info@Muster.de")).toBe("info@muster.de");
    expect(extractEmailAddress('"Muster GmbH" <Info@Muster.de>')).toBe("info@muster.de");
  });

  it("returns null for something that is not an address", () => {
    expect(extractEmailAddress("Muster GmbH")).toBeNull();
    expect(extractEmailAddress("@muster.de")).toBeNull();
    expect(extractEmailAddress("info@")).toBeNull();
  });
});

describe("parseInboundRecipient", () => {
  it("accepts exactly post-<token> on the configured domain, case-insensitively", () => {
    expect(parseInboundRecipient(`post-${TOKEN}@${DOMAIN}`, DOMAIN)).toBe(TOKEN);
    expect(parseInboundRecipient(`POST-${TOKEN.toUpperCase()}@inbox-test.resend.app`, DOMAIN)).toBe(TOKEN);
    expect(parseInboundRecipient(`Digipost <post-${TOKEN}@${DOMAIN}>`, DOMAIN)).toBe(TOKEN);
  });

  it("rejects a foreign domain, a subdomain, or a lookalike domain", () => {
    expect(parseInboundRecipient(`post-${TOKEN}@example.de`, DOMAIN)).toBeNull();
    expect(parseInboundRecipient(`post-${TOKEN}@x.${DOMAIN}`, DOMAIN)).toBeNull();
    expect(parseInboundRecipient(`post-${TOKEN}@${DOMAIN}.evil.de`, DOMAIN)).toBeNull();
  });

  it("rejects a malformed local part", () => {
    expect(parseInboundRecipient(`${TOKEN}@${DOMAIN}`, DOMAIN)).toBeNull();
    expect(parseInboundRecipient(`post-${TOKEN.slice(1)}@${DOMAIN}`, DOMAIN)).toBeNull();
    expect(parseInboundRecipient(`post-${TOKEN}x@${DOMAIN}`, DOMAIN)).toBeNull();
    expect(parseInboundRecipient(`post-${TOKEN.slice(0, 19)}l@${DOMAIN}`, DOMAIN)).toBeNull();
    expect(parseInboundRecipient(`post-${TOKEN}+rechnung@${DOMAIN}`, DOMAIN)).toBeNull();
    expect(parseInboundRecipient(`info@${DOMAIN}`, DOMAIN)).toBeNull();
  });
});

describe("collectInboundTokens", () => {
  it("keeps distinct valid tokens in order and drops everything else", () => {
    const other = "zyxwvtsrqpnmkjhgfedc";
    expect(
      collectInboundTokens([`a@example.de`, `post-${TOKEN}@${DOMAIN}`, `post-${other}@${DOMAIN}`, `POST-${TOKEN}@${DOMAIN}`], DOMAIN),
    ).toEqual([TOKEN, other]);
    expect(collectInboundTokens([`post-${TOKEN}@example.de`], DOMAIN)).toEqual([]);
  });
});
