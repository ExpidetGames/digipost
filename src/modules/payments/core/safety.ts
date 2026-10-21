// Owner: src/modules/payments (decisions/0023-payment-matching.md). Safety checks: signals
// worth surfacing to a human even outside the normal suggestion flow - two payments that both
// look like they paid the same invoice (possible duplicate/fraud, or simply an accidental
// double transfer), and a reminder (Mahnung) that arrived for an invoice already paid before
// the reminder was even scanned.
import { directionMatches } from "./direction";
import { findInvoiceNumbers } from "./text-signals";
import type { MatchableDocument, MatchableTransaction } from "./types";

export type DuplicatePaymentWarning = {
  documentId: string;
  invoiceNumber: string;
  /** Every transaction (2 or more) whose remittance text named this document's invoice
   * number, in the same direction as the document. */
  transactionIds: string[];
};

/**
 * For every document that has an invoice number, finds every direction-compatible
 * transaction whose remittance text names that invoice number (`findInvoiceNumbers`); a
 * document named by 2+ such transactions is flagged - two payments for one invoice is either
 * an accidental double transfer or, in the specific case of a changed payment channel, a sign
 * worth a human's attention (mirrors decisions/0019-contacts.md's own invoice-fraud framing
 * for a changed IBAN: this function does not itself decide fraud, it only surfaces the
 * pattern). A document with no invoice number is never checked - there is nothing to key the
 * duplicate detection on.
 */
export function detectDuplicatePayment(documents: readonly MatchableDocument[], transactions: readonly MatchableTransaction[]): DuplicatePaymentWarning[] {
  const warnings: DuplicatePaymentWarning[] = [];
  for (const doc of documents) {
    if (!doc.invoiceNumber) continue;
    const matchingTransactionIds = transactions
      .filter((tx) => directionMatches(tx, doc) && findInvoiceNumbers(tx.remittanceText, [doc.invoiceNumber!]).length > 0)
      .map((tx) => tx.id);
    if (matchingTransactionIds.length > 1) {
      warnings.push({ documentId: doc.id, invoiceNumber: doc.invoiceNumber, transactionIds: matchingTransactionIds });
    }
  }
  return warnings;
}

/**
 * `true` when a reminder's own invoice number and contact already point at a document (in the
 * given list) whose open amount is `0` - i.e. the underlying invoice was already fully paid
 * before this reminder ever arrived (a Mahnung sent right before a payment posted, or one
 * scanned late after the fact). A reminder with no invoice number, or no contact, can never
 * be resolved this way (returns `false`) - there is nothing reliable to key the lookup on, and
 * guessing would risk silently dismissing a genuinely unpaid reminder.
 */
export function reminderAlreadyPaid(
  reminder: Pick<MatchableDocument, "invoiceNumber" | "contactId">,
  documents: readonly MatchableDocument[],
): boolean {
  if (!reminder.invoiceNumber || !reminder.contactId) return false;
  return documents.some((doc) => doc.invoiceNumber === reminder.invoiceNumber && doc.contactId === reminder.contactId && doc.openAmountCents <= 0);
}
