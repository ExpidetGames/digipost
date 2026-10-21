// Owner: src/modules/payments (decisions/0023-payment-matching.md). Deterministic fake
// `PaymentArbiter` - no randomness, no clock, no network - exactly the same role
// `@/modules/intake/core/fake-intake-classifier.ts` and
// `@/modules/documents/core/fake-document-analyzer.ts` play for their own ports: bound by
// `AI_PROVIDER=fake` (F3b's composition-root wiring), and what every test in this repository
// exercises instead of the real Mistral adapter.
import { findInvoiceNumbers } from "./text-signals";
import type { MatchableDocument } from "./types";
import type { PaymentArbiter, PaymentArbiterInput, PaymentArbiterRawResult } from "./arbiter";

/**
 * Picks the candidate closest in amount to the transaction's paid amount, preferring one
 * whose invoice number appears in the remittance text; returns `bestDocumentId: null` when no
 * candidate is within 25% of the paid amount (mirrors what a real model would reasonably
 * decline to guess at). Deterministic: ties are broken by the candidate's own position in the
 * input array, never by a hidden `Math.random()`/clock read.
 */
export function createFakePaymentArbiter(): PaymentArbiter {
  return {
    async rank(input: PaymentArbiterInput): Promise<PaymentArbiterRawResult> {
      const paidCents = Math.abs(input.transaction.amountCents);
      if (input.candidates.length === 0) {
        return { bestDocumentId: null, confidence: 0, reason: "Keine Kandidaten vorhanden." };
      }

      let best: MatchableDocument | null = null;
      let bestScore = Number.POSITIVE_INFINITY;
      for (const candidate of input.candidates) {
        const amountDiffRatio = paidCents === 0 ? 1 : Math.abs(candidate.openAmountCents - paidCents) / paidCents;
        const invoiceNumberFound = candidate.invoiceNumber !== null && findInvoiceNumbers(input.transaction.remittanceText, [candidate.invoiceNumber]).length > 0;
        const score = invoiceNumberFound ? amountDiffRatio - 1 : amountDiffRatio;
        if (score < bestScore) {
          bestScore = score;
          best = candidate;
        }
      }

      const bestAmountDiffRatio = best === null || paidCents === 0 ? 1 : Math.abs(best.openAmountCents - paidCents) / paidCents;
      if (best === null || bestAmountDiffRatio > 0.25) {
        return { bestDocumentId: null, confidence: 0, reason: "Kein Kandidat passt zum gezahlten Betrag." };
      }

      const invoiceNumberFound = best.invoiceNumber !== null && findInvoiceNumbers(input.transaction.remittanceText, [best.invoiceNumber]).length > 0;
      const confidence = invoiceNumberFound ? 0.9 : Math.max(0, 0.7 - bestAmountDiffRatio);
      const reason = invoiceNumberFound
        ? `Die Rechnungsnummer ${best.invoiceNumber} steht im Verwendungszweck und der Betrag passt.`
        : "Der gezahlte Betrag liegt nahe am offenen Betrag dieses Dokuments.";

      return { bestDocumentId: best.id, confidence, reason };
    },
  };
}
