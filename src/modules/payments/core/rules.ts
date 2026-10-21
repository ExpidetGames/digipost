// Owner: src/modules/payments (decisions/0023-payment-matching.md). Stage 1 of the three
// fixed stages (deterministic rules -> arithmetic -> AI arbiter, in that strict order): a
// pure, deterministic pass matching one transaction against one-invoice-at-a-time candidates
// only (a whole-amount exact or skonto-tolerance match). Partial payments and collective
// (several-invoices-one-transfer) payments are `core/arithmetic.ts`'s job, stage 2 - this file
// never attempts either.
import { normalizeIban } from "@/modules/contacts";

import { directionMatches } from "./direction";
import {
  counterpartyNameSimilarity,
  documentNamesStatementReference,
  extractStatementReferences,
  findInvoiceNumbers,
  hasContradictingInvoiceReference,
  isWholeRemittanceInvoiceNumber,
} from "./text-signals";
import { MATCH_KINDS, MATCH_REASON_CODES, type MatchableDocument, type MatchableTransaction, type MatchKind, type MatchReasonCode, type MatchSuggestion } from "./types";

/** Product decision (F3a brief): "Skonto tolerance default 3 percent (configurable per call;
 * per-contact later)". */
export const DEFAULT_SKONTO_TOLERANCE_PERCENT = 3;

/** Weak-match bar for `counterparty_name_match` as a rules-stage signal - deliberately the
 * same bar `@/modules/contacts/core/matching.ts` uses for its own weak "customer number +
 * name" rule (0.4): a name signal alone is never enough to `autoConfirm` here regardless of
 * this threshold (see `isAutoConfirmMatch`), so a looser bar only risks a slightly-worse
 * SUGGESTION ordering, never a wrong auto-confirmed match. */
export const NAME_MATCH_THRESHOLD = 0.4;

/** decisions/0044: without the invoice number in the remittance text, a debit and a receipt
 * belong together only when they are close in time. */
export const MAX_DAYS_WITHOUT_INVOICE_NUMBER = 45;

/** decisions/0044: amounts are only comparable in the same currency. Automattic bills in USD
 * while the bank debits EUR; comparing the cents directly produced chance "matches". */
export function sameCurrency(tx: Pick<MatchableTransaction, "currency">, doc: Pick<MatchableDocument, "currency">): boolean {
  return (tx.currency ?? "EUR").toUpperCase() === (doc.currency ?? "EUR").toUpperCase();
}

export function dayDistance(isoA: string | null | undefined, isoB: string | null | undefined): number {
  if (!isoA || !isoB) return Number.POSITIVE_INFINITY;
  return Math.abs(Math.round((Date.parse(isoA) - Date.parse(isoB)) / 86_400_000));
}

export type MatchRuleOptions = {
  /** Percent, e.g. `3` for 3%. Applied to the document's OPEN amount (not its original
   * total): a partially-paid invoice's remaining skonto window is naturally smaller in
   * absolute terms once part of it has already been paid at a different rate, and comparing
   * against the still-open amount is what keeps the tolerance meaningful either way. */
  skontoTolerancePercent?: number;
};

/**
 * Paid-less-than-open-amount check: `true` when `paidCents` is within `tolerancePercent` of
 * `openAmountCents`, allowing the paid amount to be LESS than what was owed (a skonto
 * discount), never more. `openAmountCents <= 0` never passes (nothing left to discount off
 * of). Boundary is inclusive: at exactly `tolerancePercent`, this returns `true` - the F3a
 * brief's own worked example (3% default tolerance) expects 2.9% to pass and 3.1% to fail,
 * which this inclusive-at-the-boundary check satisfies either way since neither example lands
 * exactly on 3.0%.
 */
export function isWithinSkontoTolerance(paidCents: number, openAmountCents: number, tolerancePercent: number): boolean {
  if (openAmountCents <= 0) return false;
  const shortfallCents = openAmountCents - paidCents;
  if (shortfallCents < 0) return false;
  const toleranceCents = openAmountCents * (tolerancePercent / 100);
  return shortfallCents <= toleranceCents;
}

export type AutoConfirmInput = {
  invoiceNumberFound: boolean;
  /** `null` when neither an exact nor a skonto-tolerance amount match was found. */
  amountMatchKind: "exact" | "skonto" | null;
  directionOk: boolean;
};

/** Product decision (F3a brief): "Auto-confirm ONLY when the invoice number appears in the
 * remittance text AND the amount matches (exact or within Skonto tolerance). Everything else
 * is a suggestion a human confirms." Kept as its own standalone function (rather than inlined
 * where `matchByRules` builds a suggestion) specifically so it has its own direct unit tests,
 * and so `core/arbiter.ts`'s validation can import the same predicate to prove an AI
 * suggestion can never satisfy it either. */
export function isAutoConfirmMatch(input: AutoConfirmInput): boolean {
  return input.directionOk && input.invoiceNumberFound && input.amountMatchKind !== null;
}

function confidenceFor(kind: "exact" | "skonto", invoiceNumberFound: boolean, secondarySignal: boolean): number {
  if (kind === "exact") {
    if (invoiceNumberFound) return 0.99;
    return secondarySignal ? 0.8 : 0.5;
  }
  if (invoiceNumberFound) return 0.95;
  return secondarySignal ? 0.75 : 0.45;
}

/**
 * One suggestion per candidate document that has at least one positive signal (invoice number
 * found, an iban match, or a similar counterparty name) AND a whole-amount exact/skonto match
 * against the document's open amount - a candidate with no textual signal at all is skipped
 * even if the amount happens to line up by coincidence (an amount-only "match" with zero
 * corroborating evidence is not a rules-stage suggestion; `core/candidates.ts`/`core/arbiter.ts`
 * exist for the weaker-evidence cases). Every candidate is checked independently; the result
 * is sorted by descending `confidence` (ties broken by the candidate's own input order, which
 * `Array.prototype.sort`'s stability preserves) - never by document id or any other
 * incidental field, so a caller can safely take `matchByRules(...)[0]` as "the best rules-stage
 * suggestion" without an extra sort of its own.
 */
export function matchByRules(tx: MatchableTransaction, candidates: readonly MatchableDocument[], options: MatchRuleOptions = {}): MatchSuggestion[] {
  const tolerancePercent = options.skontoTolerancePercent ?? DEFAULT_SKONTO_TOLERANCE_PERCENT;
  const paidCents = Math.abs(tx.amountCents);
  const statementReferences = extractStatementReferences(tx);
  const suggestions: MatchSuggestion[] = [];

  for (const doc of candidates) {
    if (doc.openAmountCents <= 0) continue;
    if (!directionMatches(tx, doc)) continue; // never cross, no exception
    // decisions/0033: the remittance text explicitly names a DIFFERENT invoice than this
    // candidate's own number - strong negative evidence, vetoed in code before any amount/
    // secondary-signal check below ever gets a chance to build a suggestion out of it.
    if (hasContradictingInvoiceReference(tx.remittanceText, doc.invoiceNumber)) continue;
    if (!sameCurrency(tx, doc)) continue; // decisions/0044: foreign-currency documents are left to the AI stage

    const invoiceNumberFound = doc.invoiceNumber !== null && findInvoiceNumbers(tx.remittanceText, [doc.invoiceNumber]).length > 0;
    const ibanMatches = tx.counterpartyIban !== null && doc.contactIban !== null && normalizeIban(tx.counterpartyIban) === normalizeIban(doc.contactIban);
    const nameMatches = counterpartyNameSimilarity(tx.counterpartyName, doc.contactName) >= NAME_MATCH_THRESHOLD;

    const exactAmount = paidCents === doc.openAmountCents;
    const skontoAmount = !exactAmount && isWithinSkontoTolerance(paidCents, doc.openAmountCents, tolerancePercent);
    let amountMatchKind: "exact" | "skonto" | null = null;
    if (exactAmount) amountMatchKind = "exact";
    else if (skontoAmount) amountMatchKind = "skonto";
    if (amountMatchKind === null) continue; // rules stage only handles a whole-amount match

    // decisions/0040: a remittance text that is nothing but the invoice number counts as the
    // invoice signal, but only with an amount exact to the cent (never skonto).
    const wholeRemittanceIsNumber = amountMatchKind === "exact" && isWholeRemittanceInvoiceNumber(tx.remittanceText, doc.invoiceNumber);
    // decisions/0071: a card charge's descriptor reference printed on the receipt identifies that
    // one receipt, the way an invoice number in the remittance text does - with the exact amount.
    const statementReferenceFound = amountMatchKind === "exact" && documentNamesStatementReference(doc.referenceText, statementReferences);
    const invoiceNumberSignal = invoiceNumberFound || wholeRemittanceIsNumber;
    const invoiceSignal = invoiceNumberSignal || statementReferenceFound;

    const reasons: MatchReasonCode[] = [];
    if (invoiceNumberSignal) reasons.push(MATCH_REASON_CODES.invoiceNumberInRemittance);
    if (statementReferenceFound) reasons.push(MATCH_REASON_CODES.statementReferenceInDocument);
    if (amountMatchKind === "exact") reasons.push(MATCH_REASON_CODES.amountExact);
    else reasons.push(MATCH_REASON_CODES.amountWithinSkonto);
    if (ibanMatches) reasons.push(MATCH_REASON_CODES.ibanMatch);
    if (nameMatches) reasons.push(MATCH_REASON_CODES.counterpartyNameMatch);

    if (!invoiceSignal && !ibanMatches && !nameMatches) continue; // amount alone is not a rules-stage signal
    const referenceDate = doc.documentDate ?? doc.dueDate;
    if (!invoiceSignal && referenceDate && dayDistance(referenceDate, tx.bookingDate) > MAX_DAYS_WITHOUT_INVOICE_NUMBER) continue;

    const kind: MatchKind = amountMatchKind === "exact" ? MATCH_KINDS.exact : MATCH_KINDS.skonto;
    const confidence = confidenceFor(amountMatchKind, invoiceSignal, ibanMatches || nameMatches);
    const autoConfirm = isAutoConfirmMatch({ invoiceNumberFound: invoiceSignal, amountMatchKind, directionOk: true });

    suggestions.push({ documentIds: [doc.id], transactionIds: [tx.id], kind, confidence, autoConfirm, reasons });
  }

  return suggestions.sort((a, b) => b.confidence - a.confidence);
}
