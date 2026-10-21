// Owner: src/modules/payments (decisions/0023-payment-matching.md,
// decisions/0069-a-credit-note-is-money-coming-back.md). The single place "never cross" is
// checked: every stage in this module (`rules.ts`, `candidates.ts`, `arbiter.ts`'s validation,
// `safety.ts`) calls this one function rather than re-deriving the same condition, so the
// discipline can never quietly drift between stages.
//
// The question is NOT "who sent the document" but "which way does the money move". For almost
// every document the two agree: an invoice we received is money going out, one we issued is
// money coming in. A CREDIT NOTE flips it without changing who sent it - a supplier's credit
// note still arrives from the supplier (`direction: "incoming"`) while the money comes back to
// us. The signal for that is already in the data: a credit note's total is negative
// (decisions/0021-extraction-direction-and-invoice-fields.md).
import type { MatchableDocument, MatchableTransaction } from "./types";

/** A zero-amount transaction matches nothing - there is no direction to check it against, and
 * a genuine zero-value bank entry (a balance-only line, a reversal netting to zero) has no
 * money to reconcile against any invoice anyway. */
export function directionMatches(
  tx: Pick<MatchableTransaction, "amountCents">,
  doc: Pick<MatchableDocument, "direction" | "totalAmountCents">,
): boolean {
  if (tx.amountCents === 0) return false;
  // Exclusive or: "we issued it" and "it is a credit note" each flip the direction of the
  // money, and both together flip it back (a credit note we issued to a customer is money
  // going out).
  const expectsMoneyIn = (doc.direction === "outgoing") !== doc.totalAmountCents < 0;
  return expectsMoneyIn ? tx.amountCents > 0 : tx.amountCents < 0;
}
