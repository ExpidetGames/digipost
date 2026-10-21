import { describe, expect, it } from "vitest";

import { applyAliases, filterRejectedPairs, learnAliasFromConfirmation, matchesLearnedChannel, rejectedPairKey } from "../core/learning";
import { MATCH_KINDS, type MatchSuggestion } from "../core/types";

function suggestion(overrides: Partial<MatchSuggestion> = {}): MatchSuggestion {
  return {
    documentIds: ["doc-1"],
    transactionIds: ["tx-1"],
    kind: MATCH_KINDS.exact,
    confidence: 0.9,
    autoConfirm: true,
    reasons: [],
    ...overrides,
  };
}

describe("applyAliases / learnAliasFromConfirmation", () => {
  it("returns null when no alias is known for the name", () => {
    expect(applyAliases("Musterwerk GmbH", new Map())).toBeNull();
  });

  it("returns null for a null/undefined counterparty name", () => {
    expect(applyAliases(null, new Map([["musterwerk", "contact-1"]]))).toBeNull();
    expect(applyAliases(undefined, new Map([["musterwerk", "contact-1"]]))).toBeNull();
  });

  it("learns an alias and then applies it, matching on the normalized name", () => {
    const learned = learnAliasFromConfirmation("Musterwerk GmbH", "contact-1", new Map());
    expect(applyAliases("musterwerk", learned)).toBe("contact-1");
    expect(applyAliases("MUSTERWERK GMBH", learned)).toBe("contact-1");
  });

  it("does not mutate the original map (pure transform)", () => {
    const original = new Map<string, string>();
    const learned = learnAliasFromConfirmation("Musterwerk GmbH", "contact-1", original);
    expect(original.size).toBe(0);
    expect(learned.size).toBe(1);
  });

  it("overwrites an existing alias for the same normalized name", () => {
    const first = learnAliasFromConfirmation("Musterwerk GmbH", "contact-old", new Map());
    const second = learnAliasFromConfirmation("Musterwerk GmbH", "contact-new", first);
    expect(applyAliases("Musterwerk GmbH", second)).toBe("contact-new");
  });
});

describe("filterRejectedPairs", () => {
  it("drops a suggestion whose document/transaction pair was rejected", () => {
    const rejected = new Set([rejectedPairKey("doc-1", "tx-1")]);
    expect(filterRejectedPairs([suggestion()], rejected)).toEqual([]);
  });

  it("keeps a suggestion whose pair was not rejected", () => {
    const rejected = new Set([rejectedPairKey("doc-2", "tx-2")]);
    expect(filterRejectedPairs([suggestion()], rejected)).toEqual([suggestion()]);
  });

  it("drops a collective suggestion if any of its document/transaction pairs was rejected", () => {
    const collective = suggestion({ documentIds: ["doc-1", "doc-2"], transactionIds: ["tx-1"], kind: MATCH_KINDS.collective, autoConfirm: false });
    const rejected = new Set([rejectedPairKey("doc-2", "tx-1")]);
    expect(filterRejectedPairs([collective], rejected)).toEqual([]);
  });

  it("returns an empty array unchanged", () => {
    expect(filterRejectedPairs([], new Set())).toEqual([]);
  });
});

describe("matchesLearnedChannel", () => {
  it("returns true when the counterparty iban matches the contact's learned channel", () => {
    const channels = new Map([["contact-1", { iban: "DE12 3456 7890 1234 5678 90" }]]);
    expect(matchesLearnedChannel("contact-1", "DE12345678901234567890", channels)).toBe(true);
  });

  it("returns false when no channel is learned for the contact", () => {
    expect(matchesLearnedChannel("contact-1", "DE12345678901234567890", new Map())).toBe(false);
  });

  it("returns false when the iban is null", () => {
    const channels = new Map([["contact-1", { iban: "DE12345678901234567890" }]]);
    expect(matchesLearnedChannel("contact-1", null, channels)).toBe(false);
  });

  it("returns false when the iban does not match the learned channel", () => {
    const channels = new Map([["contact-1", { iban: "DE12345678901234567890" }]]);
    expect(matchesLearnedChannel("contact-1", "DE99999999999999999999", channels)).toBe(false);
  });
});
