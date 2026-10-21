// Owner: src/platform/observability. Reports an error to Sentry - the counterpart to
// `src/instrumentation.ts`'s `onRequestError`, which only ever sees an uncaught error that
// propagates all the way to a Next.js request boundary (a Server Component, Route Handler,
// Server Action, or Proxy). A background job failure never reaches that boundary: the job
// queue (`src/persistence/use-cases/jobs-use-cases.ts`) deliberately catches every handler's
// error itself so one failing job never crashes the caller that triggered it (`after()`, the
// cron sweeper, or the UI "kick") - without an explicit call like this one, that failure
// would stay in server logs only, invisible to Sentry no matter how a DSN is configured
// (D3, decisions/0016-processing-pipeline-and-ai.md's processing pipeline).
import "server-only";

import * as Sentry from "@sentry/nextjs";

import { serverEnv } from "@/platform/env/server";

/**
 * A true no-op without `SENTRY_DSN` configured, same gate `sentry.*.config.ts` uses before
 * ever calling `Sentry.init()` - `Sentry.captureException` would already no-op with no prior
 * `init()` call, this checks explicitly anyway rather than relying on that.
 *
 * `context` becomes the event's `extra` data: callers must never pass document content,
 * personal data, or any credential (AGENTS.md "Security") - only small, already-stable
 * identifiers and codes (a job id, a document id, a stable error code), the same fields a
 * caller's own structured log line already carries.
 */
export function captureError(error: unknown, context?: Record<string, unknown>): void {
  if (!serverEnv().SENTRY_DSN) return;

  try {
    Sentry.captureException(error, context ? { extra: context } : undefined);
  } catch (captureErr) {
    console.error("[observability] failed to report error to Sentry", captureErr);
  }
}
