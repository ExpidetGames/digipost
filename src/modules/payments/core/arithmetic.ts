// Owner: src/modules/payments (decisions/0023-payment-matching.md). Stage 2 of the three
// fixed stages: pure arithmetic over already-direction-filtered open documents - subset-sum
// search for a collective payment (one transfer covering several invoices) or a partial
// payment (one transfer covering less than one invoice). Never called with mixed-direction
// documents; callers are expected to have already filtered by `core/direction.ts`'s
// `directionMatches` (this file has no transaction to check direction against for the
// subset-sum case, since a collective payment's target is a single lump sum, not a per-
// document comparison).
import type { MatchableDocument } from "./types";

export type SubsetSumOptions = {
  /** Percent tolerance applied to `targetCents` (a collective payment can itself include a
   * skonto discount across the whole batch) - default `0` (exact sum only). */
  tolerancePercent?: number;
  /** Product decision (F3a brief): "findSubsetSums(...) must be fast for 15 items" - the
   * search is a full `2^n` subset enumeration, which is why this is bounded at all. When
   * `openDocuments` exceeds this, only the `maxItems` documents with the SMALLEST
   * `openAmountCents` are considered (deterministic: ties broken by `id`) - the smallest
   * amounts are the ones most likely to compose into a target sum without immediately
   * overshooting it, and this keeps the function's own runtime bounded regardless of how many
   * open documents a contact happens to have. */
  maxItems?: number;
  /** Caps how many solutions are returned (not how many are found while searching -
   * `ambiguous` is still `true` whenever more than one solution exists at all, even if only
   * `maxSolutions` are returned). Default `10`. */
  maxSolutions?: number;
};

export type SubsetSumResult = {
  /** Each solution is a list of document ids whose `openAmountCents` sum to `targetCents`
   * within tolerance. Empty when nothing sums correctly. Ordered by ascending document count
   * (fewer documents first - the simpler explanation), then by the documents' own input
   * order. */
  solutions: string[][];
  /** `true` whenever more than one distinct solution was found, even if `solutions` was
   * truncated to `maxSolutions` - a caller must treat an ambiguous result as "cannot
   * auto-confirm this collective payment", never silently pick `solutions[0]`. */
  ambiguous: boolean;
};

const DEFAULT_MAX_ITEMS = 15;
const DEFAULT_MAX_SOLUTIONS = 10;

/**
 * Exhaustive (bounded) subset-sum search: every one of `openDocuments`' `openAmountCents`
 * combined with every other, checked against `targetCents` within `tolerancePercent`. `2^n`
 * subsets for `n <= maxItems` (default 15, so at most 32768 subsets) - deliberately a full
 * enumeration rather than a smarter DP, since at this bound a plain enumeration already runs
 * in low single-digit milliseconds and stays trivially easy to reason about (every subset is
 * inspected once, nothing is pruned that might hide a legitimate ambiguous case). The empty
 * subset is never a solution, even when `targetCents` is `0`.
 */
export function findSubsetSums(openDocuments: readonly MatchableDocument[], targetCents: number, options: SubsetSumOptions = {}): SubsetSumResult {
  const tolerancePercent = options.tolerancePercent ?? 0;
  const maxItems = options.maxItems ?? DEFAULT_MAX_ITEMS;
  const maxSolutions = options.maxSolutions ?? DEFAULT_MAX_SOLUTIONS;
  const toleranceCents = Math.abs(targetCents) * (tolerancePercent / 100);

  const pool =
    openDocuments.length > maxItems
      ? [...openDocuments].sort((a, b) => a.openAmountCents - b.openAmountCents || a.id.localeCompare(b.id)).slice(0, maxItems)
      : openDocuments;

  const n = pool.length;
  const solutions: string[][] = [];

  for (let mask = 1; mask < 1 << n; mask++) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) sum += pool[i]!.openAmountCents;
    }
    if (Math.abs(sum - targetCents) <= toleranceCents) {
      const ids: string[] = [];
      for (let i = 0; i < n; i++) {
        if (mask & (1 << i)) ids.push(pool[i]!.id);
      }
      solutions.push(ids);
    }
  }

  solutions.sort((a, b) => a.length - b.length);

  return {
    solutions: solutions.slice(0, maxSolutions),
    ambiguous: solutions.length > 1,
  };
}

export type PartialPaymentResult = {
  /** How much of the transaction's paid amount actually applies to this document - equal to
   * the smaller of the paid amount and the document's own open amount (a transaction can
   * never apply more to one document than that document still owes; the rest, if any, is the
   * caller's problem to attribute elsewhere, e.g. a collective payment's other invoices). */
  appliedCents: number;
  /** The document's open amount after applying `appliedCents` - always `>= 0`. */
  remainingOpenCents: number;
};

/** Applies one transaction's paid amount to one document as a partial payment - pure
 * arithmetic, no I/O; F3b is responsible for persisting `remainingOpenCents` back onto the
 * document's own open-amount field. */
export function partialPaymentFor(document: Pick<MatchableDocument, "openAmountCents">, tx: { amountCents: number }): PartialPaymentResult {
  const paidCents = Math.abs(tx.amountCents);
  const appliedCents = Math.min(paidCents, document.openAmountCents);
  return { appliedCents, remainingOpenCents: Math.max(0, document.openAmountCents - appliedCents) };
}

/** `Math.max(0, openAmountCents - appliedCents)` - a document's open amount is never allowed
 * to go negative even if `appliedCents` (e.g. from summing several partial payments over
 * time) ends up slightly overshooting it. */
export function remainingOpenAmount(document: Pick<MatchableDocument, "openAmountCents">, appliedCents: number): number {
  return Math.max(0, document.openAmountCents - appliedCents);
}
