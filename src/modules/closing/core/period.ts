// Owner: src/modules/closing (decisions/0066-abschluss-check-and-export.md). The period a
// completeness check and an export are scoped to: a month ("2026-01") or a year ("2026").
// Pure and synchronous - no clock of its own (every function that needs "today" takes an ISO
// date), so the whole file is unit-testable without freezing time.

/** `"month"` for `2026-01`, `"year"` for `2026`. */
export const CLOSING_PERIOD_KINDS = ["month", "year"] as const;
export type ClosingPeriodKind = (typeof CLOSING_PERIOD_KINDS)[number];

export type ClosingPeriod = {
  kind: ClosingPeriodKind;
  /** The canonical string form, exactly as it travels in the URL: `2026-01` or `2026`. */
  value: string;
  year: number;
  /** `1`-`12` for a month period, `null` for a year. */
  month: number | null;
  /** Inclusive ISO `YYYY-MM-DD` start of the period. */
  from: string;
  /** Inclusive ISO `YYYY-MM-DD` end of the period (the real last day: 28/29/30/31). */
  to: string;
};

/** Bounded so a malformed or hostile `?period=` can never produce a nonsense SQL date range.
 * Wide enough for any real bookkeeping year this product will ever see. */
const MIN_YEAR = 1990;
const MAX_YEAR = 2999;

const MONTH_PATTERN = /^(\d{4})-(\d{2})$/;
const YEAR_PATTERN = /^(\d{4})$/;

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** The real number of days in a month, leap years included (`Date.UTC` with day `0` is the
 * last day of the previous month). */
function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function monthPeriod(year: number, month: number): ClosingPeriod {
  return {
    kind: "month",
    value: `${year}-${pad2(month)}`,
    year,
    month,
    from: `${year}-${pad2(month)}-01`,
    to: `${year}-${pad2(month)}-${pad2(lastDayOfMonth(year, month))}`,
  };
}

function yearPeriod(year: number): ClosingPeriod {
  return { kind: "year", value: String(year), year, month: null, from: `${year}-01-01`, to: `${year}-12-31` };
}

/**
 * `null` for anything that is not a valid period - an empty or missing param
 * (decisions/0062-an-empty-search-param-means-absent.md: a `method="get"` form submits every
 * field, so an untouched selector arrives as `""`), a month outside 1-12, a year outside the
 * bounds above, or any other shape. The caller falls back to its own default rather than
 * erroring, exactly like `documentListQuerySchema` does for a stale bookmarked URL.
 */
export function parseClosingPeriod(raw: string | null | undefined): ClosingPeriod | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value) return null;

  const month = MONTH_PATTERN.exec(value);
  if (month) {
    const year = Number(month[1]);
    const monthNumber = Number(month[2]);
    if (year < MIN_YEAR || year > MAX_YEAR) return null;
    if (monthNumber < 1 || monthNumber > 12) return null;
    return monthPeriod(year, monthNumber);
  }

  const year = YEAR_PATTERN.exec(value);
  if (year) {
    const yearNumber = Number(year[1]);
    if (yearNumber < MIN_YEAR || yearNumber > MAX_YEAR) return null;
    return yearPeriod(yearNumber);
  }

  return null;
}

/** The month `todayIso` (an ISO `YYYY-MM-DD` date, UTC, supplied by the caller) falls in -
 * the page's default period when the URL carries none. */
export function currentClosingPeriod(todayIso: string): ClosingPeriod {
  const parsed = parseClosingPeriod(todayIso.slice(0, 7));
  // `todayIso` is always this application's own `new Date().toISOString().slice(0, 10)`, never
  // user input; the fallback only exists so this function has no partial return type.
  return parsed ?? monthPeriod(MIN_YEAR, 1);
}

/**
 * The period selector's options, newest first: the last `months` months ending with the month
 * `todayIso` falls in, then the last `years` whole years. Built here rather than in the page
 * so the list the user can pick from and the list the parser accepts can never drift apart.
 */
export function closingPeriodOptions(todayIso: string, options: { months: number; years: number }): { months: ClosingPeriod[]; years: ClosingPeriod[] } {
  const current = currentClosingPeriod(todayIso);
  const months: ClosingPeriod[] = [];
  for (let back = 0; back < options.months; back += 1) {
    // Month arithmetic through `Date.UTC` so December rolls into the previous year correctly.
    const date = new Date(Date.UTC(current.year, (current.month ?? 1) - 1 - back, 1));
    months.push(monthPeriod(date.getUTCFullYear(), date.getUTCMonth() + 1));
  }

  const years: ClosingPeriod[] = [];
  for (let back = 0; back < options.years; back += 1) {
    years.push(yearPeriod(current.year - back));
  }

  return { months, years };
}
