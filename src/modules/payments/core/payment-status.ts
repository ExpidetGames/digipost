// Owner: src/modules/payments (decisions/0023-payment-matching.md). Pure derivation of a
// document's own `PaymentStatus` from its open amount and due date - never a stored, freely
// settable field the pipeline could drift out of sync with the actual matches recorded
// against a document (the same "derive, don't duplicate" discipline
// `@/modules/billing`'s quota evaluation already follows for usage figures).
import { PAYMENT_STATUSES, type PaymentStatus } from "./types";

export type DerivePaymentStatusInput = {
  /** The invoice's original total - only used to distinguish "nothing paid yet" (`open`) from
   * "something paid, not everything" (`partially_paid`); magnitude only (a credit note's
   * negative total is compared by absolute value). */
  totalAmountCents: number;
  /** What is still unpaid, `>= 0` (see `MatchableDocument.openAmountCents`'s own doc comment). */
  openAmountCents: number;
  /** ISO `YYYY-MM-DD`, or `null` when the document has no due date. */
  dueDate: string | null;
  /** ISO `YYYY-MM-DD` - injected rather than read from `Date.now()` so this function stays
   * pure and deterministic in tests (this repository's usual "no hidden clock" rule, e.g.
   * `@/modules/intake`'s fakes). */
  todayIso: string;
  /** A human/pipeline override that always wins over the derived state: `"settled"` for a
   * document resolved through `core/settlement.ts`'s platform-payout decomposition rather
   * than a direct transaction match, or `"no_document_needed"` for a document a human marked
   * as never going to be paid through this app (e.g. a bank fee notice, an internal memo
   * miscategorized as an invoice). Neither state is ever derived automatically - both are
   * deliberately outside this function's own "amount vs. due date" logic. */
  manualStatus?: Extract<PaymentStatus, "settled" | "no_document_needed">;
};

/**
 * - `manualStatus`, when given, always wins.
 * - `openAmountCents <= 0` -> `"paid"` (covers an exact match and a skonto-tolerance match
 *   alike - both zero out the open amount from `partialPaymentFor`'s point of view).
 * - Otherwise, when `openAmountCents === totalAmountCents` magnitude (nothing paid at all):
 *   `"overdue"` if `dueDate` is in the past, else `"open"`.
 * - Otherwise (something paid, not everything): `"overdue"` wins over `"partially_paid"` when
 *   the due date has passed - a judgment call (decisions/0023-payment-matching.md records it):
 *   an unpaid remainder past its due date is more urgent information than "some money already
 *   arrived", so overdue is surfaced first; the exact paid/open split is still visible from
 *   `openAmountCents`/`totalAmountCents` themselves, nothing is lost by not having a fourth
 *   combined state.
 */
export function derivePaymentStatus(input: DerivePaymentStatusInput): PaymentStatus {
  if (input.manualStatus) return input.manualStatus;

  if (input.openAmountCents <= 0) return PAYMENT_STATUSES.paid;

  const isOverdue = input.dueDate !== null && input.dueDate < input.todayIso;
  const totalMagnitude = Math.abs(input.totalAmountCents);
  const nothingPaidYet = input.openAmountCents >= totalMagnitude;

  if (isOverdue) return PAYMENT_STATUSES.overdue;
  if (nothingPaidYet) return PAYMENT_STATUSES.open;
  return PAYMENT_STATUSES.partiallyPaid;
}

/**
 * F3b (decisions/0025-payment-matching-wiring.md): `documents.payment_status` is a stored
 * column, recomputed by the matching use case only when a decision actually happens (a
 * confirm/reject/link/unlink, or a matching run) - crossing a due date is not itself an event,
 * so a document sitting untouched at `open`/`partially_paid` would otherwise silently stay that
 * way even after its due date passes. This upgrades the STORED status to `overdue` for DISPLAY
 * (inbox chip, filter, "Offene Posten") purely from the due date and today's date, without a
 * write - the same "derive at read time, do not trust a write that may be stale" rule
 * `derivePaymentStatus` itself already follows for the open/total-vs-due-date case. Only
 * `open`/`partially_paid` can ever be upgraded; `paid`/`overdue`/`settled`/`no_document_needed`/
 * `not_applicable` pass through unchanged (there is nothing left to upgrade, or the status is
 * already a manual/terminal one that a due date must never override).
 */
export function resolveDisplayStatus(status: PaymentStatus, dueDate: string | null, todayIso: string): PaymentStatus {
  if (status !== PAYMENT_STATUSES.open && status !== PAYMENT_STATUSES.partiallyPaid) return status;
  if (dueDate !== null && dueDate < todayIso) return PAYMENT_STATUSES.overdue;
  return status;
}
