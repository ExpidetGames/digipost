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
  /** decisions/0077-arbiter-answer-cache.md: identifies everything about this implementation that
   * can change its answer to the same input (provider, model, prompt). Part of
   * `arbiterCacheKey`, so a model or prompt change asks every question again instead of reusing
   * an answer the new setup never gave. */
  readonly version: string;
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

/** decisions/0077-arbiter-answer-cache.md: bumped whenever `arbiterCacheKey`'s own payload
 * shape changes, so a key computed by older code can never collide with a newer one. */
const ARBITER_CACHE_KEY_FORMAT = 2;

type CanonicalValue = string | number | boolean | null;

/** Plain code-unit order, the same on every runtime and locale (unlike `localeCompare`). */
function compareCodeUnits(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** The object's own primitive fields as `[key, value]` pairs sorted by key, so the hashed form
 * never depends on property order. A `null` or `undefined` field is left out: an absent
 * optional field and an explicit `null` both mean "not known" to the arbiter. */
function canonicalFields(value: object): [string, CanonicalValue][] {
  return Object.entries(value)
    .filter((entry): entry is [string, CanonicalValue] => entry[1] !== null && entry[1] !== undefined)
    .sort(([a], [b]) => compareCodeUnits(a, b));
}

/**
 * Deterministic cache key for one arbiter question (decisions/0025's "AI stage caching",
 * widened by decisions/0077-arbiter-answer-cache.md): the full input `PaymentArbiter.rank`
 * receives, so the same key means the same question and an answer of any kind (a pick, "no
 * match", an unusable answer) can be reused instead of asking again. Hashed:
 * - every field of the transaction, its `id` included (the cache row belongs to that
 *   transaction);
 * - every field of every candidate (`openAmountCents` included, so a partial payment booked
 *   elsewhere, a re-extraction, a kind correction or a contact change asks again), sorted by
 *   id so the preselection order never changes the key; a candidate added or dropped changes
 *   the set and so the key;
 * - `arbiterVersion` (`PaymentArbiter.version`: provider, model, prompt fingerprint).
 * Hashing every field rather than a hand-picked subset means a field a future prompt starts
 * showing is covered without touching this function; the price is an occasional extra question
 * when a field the prompt does not show changes, which is rare.
 */
export function arbiterCacheKey(tx: MatchableTransaction, candidates: readonly MatchableDocument[], arbiterVersion: string): string {
  const sortedCandidates = [...candidates].sort((a, b) => compareCodeUnits(a.id, b.id));
  const payload = JSON.stringify({
    format: ARBITER_CACHE_KEY_FORMAT,
    arbiterVersion,
    transaction: canonicalFields(tx),
    candidates: sortedCandidates.map(canonicalFields),
  });
  return createHash("sha256").update(payload).digest("hex");
}

/** The longest `reason` kept in the answer cache. `validateArbiterResult` only ever shows the
 * first sentence (at most 300 characters), so nothing it reads is lost. */
const MAX_CACHED_REASON_LENGTH = 1000;

/**
 * decisions/0077-arbiter-answer-cache.md: the form an arbiter answer is stored in, so that
 * re-validating the stored answer later gives exactly the result validating the live one did.
 * An answer that does not even have the expected shape is stored as "no pick"
 * (`validateArbiterResult` discards both alike); the confidence is clamped (it is clamped again
 * on validation, which is idempotent) and the reason shortened to what validation can use.
 */
export function toCacheableArbiterAnswer(raw: unknown): PaymentArbiterRawResult {
  const parsed = arbiterRawResultSchema.safeParse(raw);
  if (!parsed.success) return { bestDocumentId: null, confidence: 0, reason: "" };
  return {
    bestDocumentId: parsed.data.bestDocumentId,
    confidence: clamp01(parsed.data.confidence),
    reason: parsed.data.reason.slice(0, MAX_CACHED_REASON_LENGTH),
  };
}
