// Owner: src/modules/payments (decisions/0048-app-store-reports.md). Pure arithmetic for the
// owner's own actual goal: every Apple/Google credit on the bank account gets its report as the
// document that explains it. Both readers state their own deterministic "kind of file this is"
// (`@/modules/intake`'s `parseApplePaymentSummary`/`parseGooglePlayEarnings`), so unlike the
// ordinary three-stage matching engine (`core/rules.ts`/`core/arithmetic.ts`/`core/arbiter.ts`,
// decisions/0023-payment-matching.md) this never guesses: a pairing is only ever proposed when
// it is exact and unambiguous.
//
// Apple pays roughly two months after the reporting period, in the EXACT amount its own report
// states - `planApplePayoutPairing` looks for exactly one bank credit matching that amount,
// named "Apple", within a window after the period ends. Google pays around the middle of a
// later month, and one payout can cover several consecutive not-yet-paid monthly reports at
// once - `planGooglePayoutPairing` runs a small subset-sum search over consecutive, unpaired
// reports (oldest first) for each unpaired candidate credit.
import { textNamesPlatform } from "./platform-detection";

export type AppStoreReportSummary = {
  documentId: string;
  platform: "apple" | "google";
  /** ISO `YYYY-MM`. */
  period: string;
  /** Apple: the report's own stated payout total (its footer, or the sum of proceeds when the
   * footer is missing). Google: the report's own net (revenue minus fees minus refunds). */
  payoutAmountCents: number;
};

export type BankCreditCandidate = {
  transactionId: string;
  /** Signed - only ever a positive credit is useful here, a negative candidate never matches
   * (this module does not filter that out itself; see each `plan*` function's own doc). */
  amountCents: number;
  /** ISO `YYYY-MM-DD`. */
  bookingDate: string;
  counterpartyName: string | null;
  remittanceText: string | null;
};

export type AppStorePayoutPairing = {
  transactionId: string;
  /** One report for Apple (always) and for Google's single-report case; several consecutive
   * reports' ids, oldest first, for Google's multi-month case. */
  documentIds: string[];
  totalAmountCents: number;
};

function nameOrRemittanceMentionsPlatform(candidate: BankCreditCandidate, platform: "apple" | "google"): boolean {
  return textNamesPlatform(candidate.counterpartyName, platform) || textNamesPlatform(candidate.remittanceText, platform);
}

function addDaysIso(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function lastDayOfPeriod(period: string): string {
  const [year, month] = period.split("-").map(Number) as [number, number];
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${period}-${String(lastDay).padStart(2, "0")}`;
}

/** Apple pays roughly two months after the period ends (a real-world example: a January
 * report paid on 2025-03-06, 34 days after 2025-01-31) - 120 days gives ample room without
 * accidentally reaching into the NEXT month's own payout, which a real Apple payout schedule
 * (roughly monthly, `bank-platform-credits.txt`'s own Apple rows) never lets happen anyway
 * (two Apple payouts are never for the exact same amount to the cent by chance). */
const APPLE_PAYOUT_WINDOW_DAYS = 120;

/**
 * `report`'s payout paired with the one bank credit that is exact to the cent, named "Apple",
 * and booked within `APPLE_PAYOUT_WINDOW_DAYS` after the period's own last day - `null` when no
 * candidate matches, or when more than one does (ambiguous, never guessed at). Candidates with
 * a non-positive `amountCents` can never match (a payout is always a credit) but are not
 * filtered here for the caller's convenience - `payoutAmountCents` is always positive, so an
 * exact-equality comparison against a negative candidate already never matches.
 */
export function planApplePayoutPairing(report: AppStoreReportSummary, candidates: readonly BankCreditCandidate[]): AppStorePayoutPairing | null {
  const periodEnd = lastDayOfPeriod(report.period);
  const windowEnd = addDaysIso(periodEnd, APPLE_PAYOUT_WINDOW_DAYS);

  const matches = candidates.filter(
    (candidate) =>
      candidate.amountCents === report.payoutAmountCents &&
      nameOrRemittanceMentionsPlatform(candidate, "apple") &&
      candidate.bookingDate > periodEnd &&
      candidate.bookingDate <= windowEnd,
  );

  if (matches.length !== 1) return null;
  const match = matches[0]!;
  return { transactionId: match.transactionId, documentIds: [report.documentId], totalAmountCents: match.amountCents };
}

/** One calendar month after `period` ("2025-01" -> "2025-02") - `reports` are only ever
 * "consecutive" when each one's period is exactly the previous one's next month; a gap (an
 * un-uploaded month) stops the run right there, the same way a real payout could never
 * legitimately skip over a month with no report at all. */
function nextPeriod(period: string): string {
  const [year, month] = period.split("-").map(Number) as [number, number];
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  return `${nextYear}-${String(nextMonth).padStart(2, "0")}`;
}

const MAX_CONSECUTIVE_REPORTS = 12;

/**
 * Google pays around the middle of a later month, and one payout can cover several consecutive
 * not-yet-paid monthly reports at once (a real-world example: the first Google credit is
 * not January's net alone). `reports` must already be every still-unpaired Google report
 * (oldest period first); `candidates` every still-unexplained Google-named bank credit.
 *
 * For each candidate, in booking-date order, this tries every run of CONSECUTIVE still-unclaimed
 * reports, starting at ANY of them (decisions/0049: a run starting at the oldest one only let an
 * unexplainable older month block every later payout; observed: January and February, part of a
 * payout that also needs December 2024, blocked March + April = 141,60 EUR = the 2025-05-14
 * credit). A run qualifies when its sum is exact to the cent and it ends one or two months before
 * the credit's booking month, which is how Google actually pays. Exactly one qualifying run is
 * taken; two or more make the credit ambiguous and it stays unexplained. Claimed reports are
 * removed for every later candidate, so a report is never paired twice.
 */
export function planGooglePayoutPairing(reports: readonly AppStoreReportSummary[], candidates: readonly BankCreditCandidate[]): AppStorePayoutPairing[] {
  const remaining = [...reports].sort((a, b) => a.period.localeCompare(b.period));
  const orderedCandidates = [...candidates].sort((a, b) => a.bookingDate.localeCompare(b.bookingDate));
  const pairings: AppStorePayoutPairing[] = [];

  for (const candidate of orderedCandidates) {
    if (!nameOrRemittanceMentionsPlatform(candidate, "google")) continue;
    if (remaining.length === 0) break;
    const bookingPeriod = candidate.bookingDate.slice(0, 7);

    const qualifying: Array<{ start: number; length: number; sum: number }> = [];
    for (let start = 0; start < remaining.length; start++) {
      let sum = 0;
      for (let length = 1; length <= MAX_CONSECUTIVE_REPORTS && start + length <= remaining.length; length++) {
        const report = remaining[start + length - 1]!;
        if (length > 1 && report.period !== nextPeriod(remaining[start + length - 2]!.period)) break;
        sum += report.payoutAmountCents;
        const monthsBeforeBooking = monthsBetween(report.period, bookingPeriod);
        if (sum === candidate.amountCents && monthsBeforeBooking >= 1 && monthsBeforeBooking <= 2) qualifying.push({ start, length, sum });
      }
    }

    if (qualifying.length !== 1) continue; // none, or ambiguous
    const { start, length, sum } = qualifying[0]!;
    const claimed = remaining.splice(start, length);
    pairings.push({ transactionId: candidate.transactionId, documentIds: claimed.map((report) => report.documentId), totalAmountCents: sum });
  }

  return pairings;
}

/** Whole months from `fromPeriod` to `toPeriod` (both ISO `YYYY-MM`). */
function monthsBetween(fromPeriod: string, toPeriod: string): number {
  const [fromYear, fromMonth] = fromPeriod.split("-").map(Number) as [number, number];
  const [toYear, toMonth] = toPeriod.split("-").map(Number) as [number, number];
  return (toYear - fromYear) * 12 + (toMonth - fromMonth);
}
