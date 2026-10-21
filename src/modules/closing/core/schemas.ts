// Neutral validation for the Abschluss page's and the export route's one URL parameter
// (WEBAPP_TEMPLATE_SPEC.md §2.5: every boundary is parsed with Zod).
import { z } from "zod";

import { parseClosingPeriod, type ClosingPeriod } from "./period";

/** `/dashboard/abschluss?period=2026-01` and `/api/closing/export?period=2026`. The value is
 * handed straight to `parseClosingPeriod`, which already answers `null` for an empty string
 * (decisions/0062-an-empty-search-param-means-absent.md) and for every malformed shape - so
 * this schema only has to narrow the raw param to "a string or nothing". */
export const closingQuerySchema = z.object({
  period: z.string().trim().max(10).optional(),
});

/** `null` when the param is missing or not a valid period; the caller then falls back to its
 * own default (the page) or rejects the request (the export route). */
export function readClosingPeriod(raw: unknown): ClosingPeriod | null {
  const parsed = closingQuerySchema.safeParse(raw);
  if (!parsed.success) return null;
  return parseClosingPeriod(parsed.data.period);
}
