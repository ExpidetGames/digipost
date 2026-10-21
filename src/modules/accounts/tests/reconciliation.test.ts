import { describe, expect, it } from "vitest";

import { computeBalanceMismatch } from "../core/reconciliation";

describe("computeBalanceMismatch", () => {
  it("is false when opening + sum of transactions equals closing", () => {
    expect(computeBalanceMismatch({ openingBalanceCents: 10000, closingBalanceCents: 15000, transactionAmountCents: [5000] })).toBe(false);
  });

  it("is true when opening + sum of transactions does not equal closing", () => {
    expect(computeBalanceMismatch({ openingBalanceCents: 10000, closingBalanceCents: 16000, transactionAmountCents: [5000] })).toBe(true);
  });

  it("handles a mix of credits and debits", () => {
    expect(computeBalanceMismatch({ openingBalanceCents: 0, closingBalanceCents: -500, transactionAmountCents: [1000, -1500] })).toBe(false);
  });

  it("is false (never a reason to reject) when either balance is missing", () => {
    expect(computeBalanceMismatch({ openingBalanceCents: null, closingBalanceCents: 15000, transactionAmountCents: [5000] })).toBe(false);
    expect(computeBalanceMismatch({ openingBalanceCents: 10000, closingBalanceCents: null, transactionAmountCents: [5000] })).toBe(false);
  });

  it("is false for an empty transaction list whose balances already agree", () => {
    expect(computeBalanceMismatch({ openingBalanceCents: 10000, closingBalanceCents: 10000, transactionAmountCents: [] })).toBe(false);
  });
});
