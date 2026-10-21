// Owner: src/modules/payments (decisions/0023-payment-matching.md). Deterministic candidate
// preselection: bounds an otherwise-unbounded "every open document"/"every recent
// transaction" list down to at most 20 plausible candidates BEFORE the AI arbiter ever runs -
// the arbiter (`core/arbiter.ts`) is a ranker over this preselection, never a searcher over
// the full set (product decision, F3a brief). Two mirrored directions are provided:
// transaction -> candidate documents (the common case, a new bank transaction arrives) and
// document -> candidate transactions (an unmatched/overdue document, looking for whatever
// payment might already have settled it).
import { directionMatches } from "./direction";
import { counterpartyNameSimilarity } from "./text-signals";
import type { MatchableDocument, MatchableTransaction } from "./types";

export const MAX_CANDIDATES = 20;

export type CandidateOptions = {
  /** How many days BEFORE the transaction's booking date a document's own reference date
   * (`dueDate` if present, else `documentDate`) may fall and still be considered - default
   * `60` (an invoice can sit unpaid for a while before its payment finally arrives). */
  windowDaysBefore?: number;
  /** How many days AFTER the transaction's booking date a document's reference date may fall
   * and still be considered - default `5` (a payment occasionally posts a few days before an
   * invoice's own printed date, e.g. a pre-dated invoice mailed after payment was already
   * arranged). */
  windowDaysAfter?: number;
  /** Percent tolerance used only for RANKING (not for exclusion - see this file's own header
   * comment on why a document is never hard-excluded by amount): how close a document's open
   * amount is to the transaction's paid amount contributes to its sort position. Default
   * `20`. */
  amountTolerancePercent?: number;
  /** When `true` (default), a document/transaction sharing an IBAN or a similar counterparty
   * name with the other side is always sorted before one that does not, regardless of date/
   * amount closeness. */
  sameContactFirst?: boolean;
  maxCandidates?: number;
};

const DEFAULTS: Required<CandidateOptions> = {
  windowDaysBefore: 60,
  windowDaysAfter: 5,
  amountTolerancePercent: 20,
  sameContactFirst: true,
  maxCandidates: MAX_CANDIDATES,
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** `dateA - dateB` in whole days (positive when `dateA` is later). Both must be plain ISO
 * `YYYY-MM-DD` strings - `Date`'s own UTC-midnight parsing of a date-only string is exactly
 * what makes this exact and DST-independent. */
function daysBetween(dateA: string, dateB: string): number {
  return Math.round((new Date(dateA).getTime() - new Date(dateB).getTime()) / MS_PER_DAY);
}

function sameCounterparty(
  a: { iban: string | null; name: string | null },
  b: { iban: string | null; name: string | null },
): boolean {
  if (a.iban && b.iban && a.iban.toUpperCase().replace(/\s+/g, "") === b.iban.toUpperCase().replace(/\s+/g, "")) return true;
  return counterpartyNameSimilarity(a.name, b.name) >= 0.4;
}

/**
 * Reasons this file NEVER hard-excludes a document by amount closeness, only by date window
 * and direction: a partial payment is, by definition, for LESS than the document's open
 * amount, and a collective payment's constituent invoices are each individually smaller than
 * the transaction that eventually pays all of them together - excluding "amount doesn't match
 * closely" would systematically throw away exactly the candidates `core/arithmetic.ts`'s
 * subset-sum stage most needs to see. Amount only affects sort order here, never inclusion.
 */
export function selectCandidateDocuments(
  tx: MatchableTransaction,
  documents: readonly MatchableDocument[],
  options: CandidateOptions = {},
): MatchableDocument[] {
  const opts = { ...DEFAULTS, ...options };
  const paidCents = Math.abs(tx.amountCents);

  const eligible = documents.filter((doc) => {
    if (doc.openAmountCents <= 0) return false;
    if (!directionMatches(tx, doc)) return false;
    const referenceDate = doc.dueDate ?? doc.documentDate;
    if (referenceDate === null) return true; // a document with no date at all is never excluded by the window
    const offsetDays = daysBetween(referenceDate, tx.bookingDate);
    return offsetDays >= -opts.windowDaysBefore && offsetDays <= opts.windowDaysAfter;
  });

  const scored = eligible.map((doc) => {
    const sameParty = opts.sameContactFirst && sameCounterparty({ iban: tx.counterpartyIban, name: tx.counterpartyName }, { iban: doc.contactIban, name: doc.contactName });
    const amountDiffRatio = paidCents === 0 ? 1 : Math.abs(doc.openAmountCents - paidCents) / paidCents;
    const referenceDate = doc.dueDate ?? doc.documentDate;
    const dayDistance = referenceDate === null ? Number.MAX_SAFE_INTEGER : Math.abs(daysBetween(referenceDate, tx.bookingDate));
    return { doc, sameParty, score: amountDiffRatio * 100 + dayDistance };
  });

  scored.sort((a, b) => {
    if (a.sameParty !== b.sameParty) return a.sameParty ? -1 : 1;
    if (a.score !== b.score) return a.score - b.score;
    return a.doc.id.localeCompare(b.doc.id);
  });

  return scored.slice(0, opts.maxCandidates).map((entry) => entry.doc);
}

/** The mirrored direction (F3a brief: "plus the mirrored direction for an unmatched
 * document"): starting from a document that has no confirmed payment yet, which transactions
 * are worth showing as candidates? Same window/amount/same-contact logic, applied the other
 * way round. */
export function selectCandidateTransactions(
  document: MatchableDocument,
  transactions: readonly MatchableTransaction[],
  options: CandidateOptions = {},
): MatchableTransaction[] {
  const opts = { ...DEFAULTS, ...options };
  const referenceDate = document.dueDate ?? document.documentDate;

  const eligible = transactions.filter((tx) => {
    if (tx.isPlatformPayout) return false; // never matched directly against an invoice (F4 handles it)
    if (!directionMatches(tx, document)) return false;
    if (referenceDate === null) return true;
    const offsetDays = daysBetween(referenceDate, tx.bookingDate);
    return offsetDays >= -opts.windowDaysBefore && offsetDays <= opts.windowDaysAfter;
  });

  const scored = eligible.map((tx) => {
    const sameParty = opts.sameContactFirst && sameCounterparty({ iban: document.contactIban, name: document.contactName }, { iban: tx.counterpartyIban, name: tx.counterpartyName });
    const paidCents = Math.abs(tx.amountCents);
    const amountDiffRatio = paidCents === 0 ? 1 : Math.abs(document.openAmountCents - paidCents) / paidCents;
    const dayDistance = referenceDate === null ? Number.MAX_SAFE_INTEGER : Math.abs(daysBetween(referenceDate, tx.bookingDate));
    return { tx, sameParty, score: amountDiffRatio * 100 + dayDistance };
  });

  scored.sort((a, b) => {
    if (a.sameParty !== b.sameParty) return a.sameParty ? -1 : 1;
    if (a.score !== b.score) return a.score - b.score;
    return a.tx.id.localeCompare(b.tx.id);
  });

  return scored.slice(0, opts.maxCandidates).map((entry) => entry.tx);
}
