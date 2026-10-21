// A closed date range as it travels in a URL: `?from=2025-01-01&to=2025-12-31`. Neutral (no
// "use client"/"use server", no persistence, no i18n), importable from a module's core
// schemas and from a page alike, exactly like `action-result.ts` next to it.
//
// Two plain ISO dates rather than a period token on purpose
// (decisions/0066-abschluss-check-and-export.md): `@/modules/closing`'s `ClosingPeriod`
// depends on documents and payments already, so a `?period=` parameter understood by the
// inbox and by `/dashboard/finance/**` would invert that direction. A range is also a filter
// worth having on its own, independent of any Abschluss.
//
// Both bounds are INCLUSIVE and independent: either may be absent, which means "open on that
// side". `from` after `to` is accepted and simply matches nothing - an honest empty list
// rather than a silently swapped range the user never asked for.
import { z } from "zod";

export type DateRange = {
  /** Inclusive ISO `YYYY-MM-DD` lower bound, or `undefined` for "no lower bound". */
  from?: string;
  /** Inclusive ISO `YYYY-MM-DD` upper bound, or `undefined` for "no upper bound". */
  to?: string;
};

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A real calendar date in ISO `YYYY-MM-DD` form. The round-trip through `Date.UTC` is what
 * rejects `2025-02-31`: the pattern alone would let it through, and it would then reach
 * Postgres as `'2025-02-31'::date` and fail the whole query at runtime rather than being
 * ignored like every other unusable search param.
 */
export function isIsoDate(value: string): boolean {
  if (!ISO_DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** One bound. `.catch(undefined)` rather than a hard failure: an empty string (every
 * `method="get"` form submits every field, decisions/0062-an-empty-search-param-means-absent.md),
 * a stale bookmark, or a hostile value all mean "no bound", never a broken page. */
export const isoDateQueryFieldSchema = z
  .string()
  .trim()
  .refine(isIsoDate)
  .optional()
  .catch(undefined);

/** The two bounds together - spread into a larger query schema (the inbox) or parsed on its
 * own (`/dashboard/finance/zuordnung`, `/dashboard/finance/offene-posten`). */
export const dateRangeQuerySchema = z.object({
  from: isoDateQueryFieldSchema,
  to: isoDateQueryFieldSchema,
});

/** Narrows raw search params to a range, never throwing - see `isoDateQueryFieldSchema`. */
export function readDateRange(raw: unknown): DateRange {
  const parsed = dateRangeQuerySchema.safeParse(raw);
  if (!parsed.success) return {};
  return { from: parsed.data.from, to: parsed.data.to };
}

/** `true` when at least one bound is set - what a page branches on to render its
 * "Zeitraum: ..." note and its clear link. */
export function isDateRangeActive(range: DateRange): boolean {
  return range.from !== undefined || range.to !== undefined;
}

/** The range as URL search params, for a link that carries it (the Abschluss's check links).
 * Absent bounds are omitted entirely rather than sent as empty values. */
export function dateRangeSearchParams(range: DateRange): [string, string][] {
  const params: [string, string][] = [];
  if (range.from !== undefined) params.push(["from", range.from]);
  if (range.to !== undefined) params.push(["to", range.to]);
  return params;
}
