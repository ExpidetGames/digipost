// Owner: src/modules/payments (decisions/0023-payment-matching.md). Stage 3, the AI arbiter -
// a RANKER over a deterministically preselected, already-bounded candidate list
// (`core/candidates.ts`, max 20), never a searcher: it is only ever asked "which of these
// already-plausible documents is this transaction most likely for", never "find me the
// document". Everything the model returns is re-verified here, in code, before it becomes a
// `MatchSuggestion` - the same "AI proposes, code verifies" contract
// decisions/0020-universal-intake.md established for the intake classifier and
// decisions/0021-extraction-direction-and-invoice-fields.md established for extraction:
// - a `bestDocumentId` naming anything not in `candidates` is rejected outright (hallucination
//   guard - `parseIntakeClassification`'s own "drop what wasn't in the header" is the direct
//   precedent this mirrors).
// - the picked document's direction is re-checked against the transaction
//   (`core/direction.ts`) even though the candidates were already direction-filtered upstream
//   - an arbiter implementation must never be trusted to have received an already-correct
//   list, only verified to have picked correctly from whatever it was actually given.
// - the result can NEVER set `autoConfirm: true`, regardless of the model's own confidence -
//   `isAutoConfirmMatch` (`core/rules.ts`) is never even consulted here; `autoConfirm` is
//   hardcoded `false` on every AI-stage suggestion, structurally, not by convention.
// - decisions/0033-contradicting-invoice-number-vetoes-a-match.md: a pick whose own invoice
//   number CONTRADICTS a reference the remittance text explicitly names is rejected outright,
//   regardless of confidence - a model noticing and then talking itself past a contradiction
//   (the observed defect this ADR fixes) must never be trusted to make that call itself.
import { createHash } from "node:crypto";

import { z } from "zod";

import { normalizeIban } from "@/modules/contacts";

import { directionMatches } from "./direction";
import { DEFAULT_SKONTO_TOLERANCE_PERCENT, isWithinSkontoTolerance, NAME_MATCH_THRESHOLD, sameCurrency } from "./rules";
import { counterpartyNameSimilarity, findInvoiceNumbers, hasContradictingInvoiceReference } from "./text-signals";
import { MATCH_KINDS, MATCH_REASON_CODES, type MatchableDocument, type MatchableTransaction, type MatchSuggestion } from "./types";

/** Product decision (F3a brief): "a ranker over deterministically preselected candidates (max
 * 20), never a searcher" - enforced here, not merely documented, so a caller that forgets to
 * bound its own candidate list before calling an arbiter implementation fails loudly instead
 * of silently paying for (and trusting) an unbounded search. */
export const MAX_ARBITER_CANDIDATES = 20;

export type PaymentArbiterInput = {
  transaction: MatchableTransaction;
  /** Already preselected, e.g. by `core/candidates.ts`'s `selectCandidateDocuments` - never
   * more than `MAX_ARBITER_CANDIDATES` entries. */
  candidates: readonly MatchableDocument[];
};

/** The arbiter's own raw answer, exactly as an adapter (real or fake) returns it - not yet
 * validated. `bestDocumentId: null` means "none of the candidates looks right". */
export type PaymentArbiterRawResult = {
  bestDocumentId: string | null;
  /** `0..1`, the model's own stated confidence - re-clamped by `validateArbiterResult`, never
   * trusted to already be in range. */
  confidence: number;
  /** German, one sentence. */
  reason: string;
};

export interface PaymentArbiter {
  rank(input: PaymentArbiterInput): Promise<PaymentArbiterRawResult>;
}

const arbiterRawResultSchema = z.object({
  bestDocumentId: z.string().nullable(),
  confidence: z.number(),
  reason: z.string(),
});

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Truncates to the first sentence-ending punctuation within a sane length, or the whole
 * string trimmed to 300 characters when none is found - never lets a runaway or
 * multi-sentence model response through as-is (the F3a brief's "a German one-sentence
 * explanation" is a constraint on what is STORED and shown, not merely on what is asked
 * for). */
function firstSentenceOnly(text: string): string {
  const trimmed = text.trim();
  const match = /^[^.!?]{1,300}[.!?]/.exec(trimmed);
  return (match ? match[0] : trimmed.slice(0, 300)).trim();
}

/**
 * Validates one raw arbiter answer against the exact `candidates` it was given, and turns it
 * into a `MatchSuggestion` - or `null` when the answer must be discarded entirely (an
 * unparseable shape, a `bestDocumentId` not present in `candidates`, a `null` pick, or a pick
 * whose direction contradicts the transaction). A discarded result is not an error: it means
 * "the AI arbiter found nothing safe to suggest", which is a normal, expected outcome the
 * caller falls back on (no suggestion at all, left for manual review) rather than something to
 * retry or alert on.
 */
export function validateArbiterResult(raw: unknown, input: PaymentArbiterInput): MatchSuggestion | null {
  if (input.candidates.length > MAX_ARBITER_CANDIDATES) {
    throw new Error(`Payment arbiter called with ${input.candidates.length} candidates, more than the max of ${MAX_ARBITER_CANDIDATES}`);
  }

  const parsed = arbiterRawResultSchema.safeParse(raw);
  if (!parsed.success) return null;
  const { bestDocumentId, confidence, reason } = parsed.data;
  if (bestDocumentId === null) return null;

  const picked = input.candidates.find((candidate) => candidate.id === bestDocumentId);
  if (!picked) return null; // hallucinated id: never trusted, not even as a low-confidence suggestion
  if (!directionMatches(input.transaction, picked)) return null; // re-checked, never assumed from the candidate list alone
  // decisions/0033: the remittance text explicitly names a DIFFERENT invoice than the one the
  // model picked - strong negative evidence, vetoed here regardless of the model's own stated
  // confidence or explanation (the observed defect: the model noticed this exact contradiction
  // in its own reasoning and suggested the match anyway).
  if (hasContradictingInvoiceReference(input.transaction.remittanceText, picked.invoiceNumber)) return null;
  if (picked.openAmountCents <= 0) return null;
  // decisions/0039: the model's pick must rest on at least one fact the code can verify itself.
  // Observed with ministral-8b: 5 of 47 unrelated credits were paired with an invoice on invented
  // grounds ("GG könnte auf Generalbau hindeuten", "199,99 EUR ist sehr nah an 280,00 EUR").
  if (!hasHardEvidence(input.transaction, picked)) return null;

  return {
    documentIds: [picked.id],
    transactionIds: [input.transaction.id],
    kind: MATCH_KINDS.ai,
    confidence: clamp01(confidence),
    autoConfirm: false, // structurally never true for an AI-stage suggestion
    reasons: [MATCH_REASON_CODES.aiRanked],
    aiExplanation: firstSentenceOnly(reason),
  };
}

/** At least one verifiable fact links the transaction to the document: an exact or skonto-range
 * amount, the invoice number in the remittance text, the same IBAN, or a similar counterparty
 * name. A partial payment therefore still needs one of the textual signals. */
export function hasHardEvidence(tx: MatchableTransaction, doc: MatchableDocument): boolean {
  const paidCents = Math.abs(tx.amountCents);
  const same = sameCurrency(tx, doc);
  if (same && (paidCents === doc.openAmountCents || isWithinSkontoTolerance(paidCents, doc.openAmountCents, DEFAULT_SKONTO_TOLERANCE_PERCENT))) return true;
  if (doc.invoiceNumber && findInvoiceNumbers(tx.remittanceText, [doc.invoiceNumber]).length > 0) return true;
  // decisions/0044: a name or IBAN only counts together with a plausible amount. Same currency:
  // a partial payment, never more than is open (observed: a 45,20 EUR IONOS debit picked for a
  // 3,50 EUR IONOS invoice). Foreign currency: within 25 % of the open amount, room for the rate.
  const amountPlausible = same ? paidCents < doc.openAmountCents : Math.abs(paidCents - doc.openAmountCents) <= doc.openAmountCents * FOREIGN_CURRENCY_TOLERANCE;
  if (!amountPlausible) return false;
  if (tx.counterpartyIban && doc.contactIban && normalizeIban(tx.counterpartyIban) === normalizeIban(doc.contactIban)) return true;
  return counterpartyNameSimilarity(tx.counterpartyName, doc.contactName) >= NAME_MATCH_THRESHOLD;
}

/** decisions/0044: how far a foreign-currency document's amount may differ from the debit. */
const FOREIGN_CURRENCY_TOLERANCE = 0.25;

/** Deterministic cache key for one (transaction, candidate set) pair - F3b's own job to use
 * this as a lookup key before ever calling `PaymentArbiter.rank` again for the same pairing
 * (product decision, F3a brief: avoid repeated calls). Only the fields that could plausibly
 * change the arbiter's own answer are hashed (not the transaction's `id` itself, so the same
 * economic transaction re-imported under a different row id - should that ever happen - still
 * hits the same cache entry); `candidateIds` is sorted first so preselection order never
 * affects the key. */
export function arbiterCacheKey(
  tx: Pick<MatchableTransaction, "amountCents" | "bookingDate" | "remittanceText" | "counterpartyName" | "counterpartyIban" | "currency">,
  candidateIds: readonly string[],
): string {
  const payload = JSON.stringify({
    amountCents: tx.amountCents,
    bookingDate: tx.bookingDate,
    remittanceText: tx.remittanceText,
    counterpartyName: tx.counterpartyName,
    counterpartyIban: tx.counterpartyIban,
    currency: tx.currency,
    candidateIds: [...candidateIds].sort(),
  });
  return createHash("sha256").update(payload).digest("hex");
}
