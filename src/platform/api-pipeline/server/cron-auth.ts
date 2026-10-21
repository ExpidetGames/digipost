/**
 * Access step for `src/app/api/cron/**` routes secured by `Authorization: Bearer
 * $CRON_SECRET` (WEBAPP_TEMPLATE_SPEC.md §7 "Cron", §9's env table). Reads the
 * secret through `src/platform/env` (`serverEnv()`), never `process.env` directly:
 * `src/platform/env` is the only owner allowed to read `process.env` in application
 * code (`src/platform/env/README.md`, WEBAPP_TEMPLATE_SPEC.md §9's `env-access` rule) -
 * `CRON_SECRET` is a required field in `ServerEnv`, so an unset secret fails
 * `serverEnv()` itself (a misconfiguration, not a request-time auth outcome) rather
 * than this step silently authorizing an empty value.
 */
import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";

import { serverEnv } from "@/platform/env/server";

/** Thrown by `requireCronSecret` when the request's bearer token does not match. */
export class CronAuthError extends Error {
  override readonly name = "CronAuthError";
}

/**
 * `Authorization: Bearer <secret>` compared in constant time. Both sides are
 * hashed first so neither the header's length nor its content leaks through
 * timing. An empty/missing header never matches.
 */
function bearerMatches(header: string | null, secret: string): boolean {
  const expected = createHash("sha256").update(`Bearer ${secret}`).digest();
  const actual = createHash("sha256").update(header ?? "").digest();
  return timingSafeEqual(expected, actual);
}

/**
 * Compares the request's `Authorization` header against `CRON_SECRET`. Throws
 * `CronAuthError` on any mismatch - the caller's own `access` step `mapError`
 * turns that into a 401 `ApiErrorResponse` (see `src/platform/api-pipeline/README.md`'s
 * "Adoption boundary" for this step's current, route-less status).
 */
export function requireCronSecret(request: Request): void {
  const { CRON_SECRET } = serverEnv();
  if (!bearerMatches(request.headers.get("authorization"), CRON_SECRET)) {
    throw new CronAuthError("cron bearer secret mismatch");
  }
}
