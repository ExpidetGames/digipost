import { describe, expect, it } from "vitest";

import { derivePaymentStatus, resolveDisplayStatus } from "../core/payment-status";
import { PAYMENT_STATUSES } from "../core/types";

const TODAY = "2026-09-20";

describe("derivePaymentStatus", () => {
  const cases: Array<{
    name: string;
    totalAmountCents: number;
    openAmountCents: number;
    dueDate: string | null;
    expected: string;
  }> = [
    { name: "nothing paid, no due date -> open", totalAmountCents: 10_000, openAmountCents: 10_000, dueDate: null, expected: PAYMENT_STATUSES.open },
    { name: "nothing paid, due date in the future -> open", totalAmountCents: 10_000, openAmountCents: 10_000, dueDate: "2026-12-01", expected: PAYMENT_STATUSES.open },
    { name: "nothing paid, due date in the past -> overdue", totalAmountCents: 10_000, openAmountCents: 10_000, dueDate: "2026-01-01", expected: PAYMENT_STATUSES.overdue },
    { name: "nothing paid, due date is today -> open (not yet overdue)", totalAmountCents: 10_000, openAmountCents: 10_000, dueDate: TODAY, expected: PAYMENT_STATUSES.open },
    { name: "fully paid (open 0), overdue due date is irrelevant -> paid", totalAmountCents: 10_000, openAmountCents: 0, dueDate: "2026-01-01", expected: PAYMENT_STATUSES.paid },
    { name: "overpaid slightly negative-equivalent open (0) -> paid", totalAmountCents: 10_000, openAmountCents: 0, dueDate: null, expected: PAYMENT_STATUSES.paid },
    { name: "partially paid, not yet due -> partially_paid", totalAmountCents: 10_000, openAmountCents: 4_000, dueDate: "2026-12-01", expected: PAYMENT_STATUSES.partiallyPaid },
    { name: "partially paid, no due date -> partially_paid", totalAmountCents: 10_000, openAmountCents: 4_000, dueDate: null, expected: PAYMENT_STATUSES.partiallyPaid },
    { name: "partially paid AND overdue -> overdue wins", totalAmountCents: 10_000, openAmountCents: 4_000, dueDate: "2026-01-01", expected: PAYMENT_STATUSES.overdue },
    { name: "credit note (negative total), fully settled -> paid", totalAmountCents: -5_000, openAmountCents: 0, dueDate: null, expected: PAYMENT_STATUSES.paid },
    { name: "credit note (negative total), nothing applied yet, overdue -> overdue", totalAmountCents: -5_000, openAmountCents: 5_000, dueDate: "2026-01-01", expected: PAYMENT_STATUSES.overdue },
  ];

  it.each(cases)("$name", ({ totalAmountCents, openAmountCents, dueDate, expected }) => {
    expect(derivePaymentStatus({ totalAmountCents, openAmountCents, dueDate, todayIso: TODAY })).toBe(expected);
  });

  it("a manualStatus of settled always wins over the derived state", () => {
    expect(
      derivePaymentStatus({ totalAmountCents: 10_000, openAmountCents: 10_000, dueDate: "2026-01-01", todayIso: TODAY, manualStatus: "settled" }),
    ).toBe(PAYMENT_STATUSES.settled);
  });

  it("a manualStatus of no_document_needed always wins over the derived state", () => {
    expect(
      derivePaymentStatus({ totalAmountCents: 10_000, openAmountCents: 0, dueDate: null, todayIso: TODAY, manualStatus: "no_document_needed" }),
    ).toBe(PAYMENT_STATUSES.noDocumentNeeded);
  });
});

describe("resolveDisplayStatus", () => {
  it("upgrades a stored open status to overdue once the due date has passed", () => {
    expect(resolveDisplayStatus(PAYMENT_STATUSES.open, "2026-01-01", TODAY)).toBe(PAYMENT_STATUSES.overdue);
  });

  it("upgrades a stored partially_paid status to overdue once the due date has passed", () => {
    expect(resolveDisplayStatus(PAYMENT_STATUSES.partiallyPaid, "2026-01-01", TODAY)).toBe(PAYMENT_STATUSES.overdue);
  });

  it("leaves open as-is when the due date has not passed yet", () => {
    expect(resolveDisplayStatus(PAYMENT_STATUSES.open, "2026-12-01", TODAY)).toBe(PAYMENT_STATUSES.open);
  });

  it("leaves open as-is when there is no due date at all", () => {
    expect(resolveDisplayStatus(PAYMENT_STATUSES.open, null, TODAY)).toBe(PAYMENT_STATUSES.open);
  });

  it("never touches a terminal or manual status even with a past due date", () => {
    for (const status of [PAYMENT_STATUSES.paid, PAYMENT_STATUSES.settled, PAYMENT_STATUSES.noDocumentNeeded, PAYMENT_STATUSES.notApplicable] as const) {
      expect(resolveDisplayStatus(status, "2026-01-01", TODAY)).toBe(status);
    }
  });

  it("never downgrades an already-overdue status", () => {
    expect(resolveDisplayStatus(PAYMENT_STATUSES.overdue, "2026-12-01", TODAY)).toBe(PAYMENT_STATUSES.overdue);
  });
});
