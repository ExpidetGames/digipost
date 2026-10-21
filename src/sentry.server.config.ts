/**
 * `@sentry/nextjs` file convention: the Node runtime's Sentry configuration,
 * dynamically imported from `src/instrumentation.ts`'s `register()` when
 * `NEXT_RUNTIME === "nodejs"` (Next.js instrumentation docs,
 * `node_modules/next/dist/docs/`). Options come from `src/platform/observability`
 * (`sentryInitOptions`) so server, edge and client stay in sync; `Sentry.init` is
 * only called when a DSN is configured - no DSN, zero instrumentation overhead (not
 * just zero network traffic), per Sentry's own guidance for a true no-op.
 *
 * Reads `process.env.SENTRY_DSN` directly rather than through `src/platform/env`'s
 * `serverEnv()`: this file (like `src/sentry.edge.config.ts` and
 * `src/instrumentation-client.ts`) is part of the same Next.js/Sentry file-convention
 * family as `src/instrumentation.ts` itself (which `WEBAPP_TEMPLATE_SPEC.md` §9
 * explicitly exempts from the "`src/platform/env` is the only reader of `process.env`"
 * rule) - see `decisions/0009-sentry-config-files-read-process-env-directly.md`.
 */
import * as Sentry from "@sentry/nextjs";

import { sentryInitOptions } from "@/platform/observability";

const options = sentryInitOptions(process.env.SENTRY_DSN);
if (options) {
  Sentry.init(options);
}
