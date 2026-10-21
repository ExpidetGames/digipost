/**
 * Client-side instrumentation (Next.js file convention, current best practice for
 * SDKs that need to run before hydration - see
 * `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/instrumentation-client.md`).
 * `@sentry/nextjs` adopts this file for its browser SDK init, replacing the older
 * `sentry.client.config.ts` convention.
 *
 * Only synchronous, top-level code here is guaranteed to run before hydration, so
 * this stays synchronous (no `await`). No-op without `NEXT_PUBLIC_SENTRY_DSN`
 * (mirrored from `SENTRY_DSN` by `next.config.ts`'s `env` block, so `.env.example`
 * only needs to name the one, server-style variable) - see
 * `decisions/0009-sentry-config-files-read-process-env-directly.md` for why this
 * file reads `process.env.NEXT_PUBLIC_SENTRY_DSN` directly rather than through
 * `src/platform/env`.
 */
import * as Sentry from "@sentry/nextjs";

import { sentryInitOptions } from "@/platform/observability";

const sentryOptions = sentryInitOptions(process.env.NEXT_PUBLIC_SENTRY_DSN);
if (sentryOptions) {
  Sentry.init(sentryOptions);
}
