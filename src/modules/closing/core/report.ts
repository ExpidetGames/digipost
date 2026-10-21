// Owner: src/modules/closing (decisions/0066-abschluss-check-and-export.md). The completeness
// check's pure shape: five gaps, each a count with a link into the list that closes it, plus
// the period's own totals so "no gaps" can never be mistaken for "no data".
//
// Every count arrives already computed by SQL (`ClosingUseCases`) - this file only decides
// what the check LOOKS like, never what it measures. No clock, no I/O.
import { dateRangeSearchParams } from "@/shared/date-range";

import type { ClosingPeriod } from "./period";

export const CLOSING_CHECK_KEYS = [
  /** Transactions in the period that are still unmatched - exactly
   * `TransactionRepository.listUnmatched`'s own conditions (not confirmed, not "kein Beleg
   * nötig", not on a clearing account), plus the period. */
  "unmatchedTransactions",
  /** Documents in the period whose EFFECTIVE payment status (the shared SQL `CASE`, so a
   * stored `open` past its due date counts as `overdue` here too) is open or overdue. */
  "documentsWithoutPayment",
  /** Documents in the period still waiting for a human to confirm their tabular import. */
  "pendingConfirmation",
  /** Documents in the period whose processing failed. */
  "failedProcessing",
  /** Matching suggestions awaiting a decision on a transaction in the period. */
  "openSuggestions",
] as const;
export type ClosingCheckKey = (typeof CLOSING_CHECK_KEYS)[number];

export type ClosingCheckCounts = Record<ClosingCheckKey, number>;

export type ClosingPeriodTotals = {
  documents: number;
  transactions: number;
};

export type ClosingCheckItem = {
  key: ClosingCheckKey;
  count: number;
  /** The existing filtered list that resolves this gap, narrowed to THIS period by the same
   * `?from=`/`?to=` date range the three target pages now accept
   * (decisions/0066-abschluss-check-and-export.md). A count that opened an unfiltered list
   * was the whole defect: a number nobody can reproduce on the page it points at teaches the
   * reader to distrust the page. Plain ISO dates rather than `?period=` on purpose - the
   * target pages live in `@/modules/documents`/`@/modules/payments`, which `@/modules/closing`
   * depends on, so they must not have to understand a `ClosingPeriod`. */
  href: string;
  /** `true` when nothing is outstanding for this item in this period. */
  clear: boolean;
};

export type ClosingReport = {
  period: ClosingPeriod;
  totals: ClosingPeriodTotals;
  items: ClosingCheckItem[];
  /** Every item clear. Shown as "dieser Zeitraum ist vollständig" - which, as
   * decisions/0066 spells out, means "nothing known is missing", not "nothing exists that was
   * never uploaded". The totals above are the honest guard against that reading. */
  complete: boolean;
  /** No documents and no transactions at all in this period - a different (and much weaker)
   * statement than `complete`, rendered differently. */
  empty: boolean;
};

/** The target list for each gap, with whatever filter the page itself needs, BEFORE the
 * period's own date range is appended by `checkHref`. */
const CHECK_HREFS: Record<ClosingCheckKey, string> = {
  unmatchedTransactions: "/dashboard/finance/zuordnung",
  documentsWithoutPayment: "/dashboard/finance/offene-posten",
  pendingConfirmation: "/dashboard?intakeStatus=pending_confirmation",
  failedProcessing: "/dashboard?status=failed",
  openSuggestions: "/dashboard/finance/zuordnung",
};

/** Appends the period as `from`/`to`, keeping whatever query the base href already carries
 * (`?intakeStatus=pending_confirmation` does not become a second `?`). */
function checkHref(key: ClosingCheckKey, period: ClosingPeriod): string {
  const base = CHECK_HREFS[key];
  const range = new URLSearchParams(dateRangeSearchParams({ from: period.from, to: period.to })).toString();
  return base.includes("?") ? `${base}&${range}` : `${base}?${range}`;
}

export function buildClosingReport(period: ClosingPeriod, counts: ClosingCheckCounts, totals: ClosingPeriodTotals): ClosingReport {
  const items = CLOSING_CHECK_KEYS.map((key) => ({
    key,
    count: counts[key],
    href: checkHref(key, period),
    clear: counts[key] === 0,
  }));

  return {
    period,
    totals,
    items,
    complete: items.every((item) => item.clear),
    empty: totals.documents === 0 && totals.transactions === 0,
  };
}
