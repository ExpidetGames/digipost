// decisions/0069-a-credit-note-is-money-coming-back.md. The owner's own case: Musterbank pays a
// cashback and sends a document about it. The document arrives from Musterbank (`incoming`) and
// its total is negative, while the money comes IN. Before this, the gate read the direction
// alone, so two exact pairings (same day, same cent, same counterparty) were invisible to
// every matching stage.
import { describe, expect, it } from "vitest";

import { directionMatches } from "../core/direction";

const incoming = (totalAmountCents: number) => ({ direction: "incoming" as const, totalAmountCents });
const outgoing = (totalAmountCents: number) => ({ direction: "outgoing" as const, totalAmountCents });
const moneyOut = { amountCents: -7471 };
const moneyIn = { amountCents: 7471 };

describe("directionMatches", () => {
  it("pairs a supplier invoice with money going out", () => {
    expect(directionMatches(moneyOut, incoming(7471))).toBe(true);
    expect(directionMatches(moneyIn, incoming(7471))).toBe(false);
  });

  it("pairs our own invoice with money coming in", () => {
    expect(directionMatches(moneyIn, outgoing(7471))).toBe(true);
    expect(directionMatches(moneyOut, outgoing(7471))).toBe(false);
  });

  it("pairs a supplier's credit note with money coming back to us", () => {
    expect(directionMatches(moneyIn, incoming(-7471))).toBe(true);
    expect(directionMatches(moneyOut, incoming(-7471))).toBe(false);
  });

  it("pairs a credit note we issued with money going out again", () => {
    expect(directionMatches(moneyOut, outgoing(-7471))).toBe(true);
    expect(directionMatches(moneyIn, outgoing(-7471))).toBe(false);
  });

  it("never matches a zero-amount transaction", () => {
    expect(directionMatches({ amountCents: 0 }, incoming(7471))).toBe(false);
    expect(directionMatches({ amountCents: 0 }, incoming(-7471))).toBe(false);
    expect(directionMatches({ amountCents: 0 }, outgoing(7471))).toBe(false);
  });

  it("treats a zero-total document as an ordinary one, never as a credit note", () => {
    expect(directionMatches(moneyOut, incoming(0))).toBe(true);
    expect(directionMatches(moneyIn, incoming(0))).toBe(false);
  });
});
