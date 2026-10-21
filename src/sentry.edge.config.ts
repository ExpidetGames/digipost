/**
 * `@sentry/nextjs` file convention: the edge runtime's Sentry configuration,
 * dynamically imported from `src/instrumentation.ts`'s `register()` when
 * `NEXT_RUNTIME === "edge"`. This app has no edge routes today (`src/proxy.ts` always
 * runs in Node.js), but Next still loads an edge instrumentation bundle, so this
 * file must exist and stay side-effect-free without a DSN, same as
 * `src/sentry.server.config.ts`.
 *
 * Reads `process.env.SENTRY_DSN` directly - see `src/sentry.server.config.ts`'s header
 * comment and `decisions/0009-sentry-config-files-read-process-env-directly.md`.
 */
import * as Sentry from "@sentry/nextjs";

import { sentryInitOptions } from "@/platform/observability";

const options = sentryInitOptions(process.env.SENTRY_DSN);
if (options) {
  Sentry.init(options);
}
