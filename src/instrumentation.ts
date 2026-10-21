/**
 * Server instrumentation (Next.js file convention: `register()` runs once, before
 * the server starts handling requests). Conditionally loads the per-runtime Sentry
 * config - `src/sentry.server.config.ts` on Node, `src/sentry.edge.config.ts` on edge
 * (Next.js instrumentation docs, `node_modules/next/dist/docs/`: this file always
 * runs in Node itself, so the `NEXT_RUNTIME` check picks the config file for the
 * runtime that is *about to* handle requests, not the one running `register()`).
 * Both config files no-op without `SENTRY_DSN` (`src/platform/observability`'s
 * `sentryInitOptions`).
 *
 * `onRequestError` reports uncaught server errors (Server Components, Route
 * Handlers, Server Actions, Proxy) to Sentry (`@sentry/nextjs`'s
 * `captureRequestError`) - only when `SENTRY_DSN` is set, matching "no
 * instrumentation overhead without a DSN".
 */
import * as Sentry from "@sentry/nextjs";
import type { Instrumentation } from "next";

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") await import("./sentry.server.config");
  if (process.env.NEXT_RUNTIME === "edge") await import("./sentry.edge.config");
  // decisions/0042: `next dev` has no cron scheduler, so a local sweeper drives the job queue.
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.NODE_ENV === "development") {
    const { startLocalCronSweeper } = await import("@/platform/api-pipeline/server");
    startLocalCronSweeper();
  }
}

export const onRequestError: Instrumentation.onRequestError = async (err, request, context) => {
  // Sentry no-ops on its own once `Sentry.init` was never called (no DSN, see
  // sentry.*.config.ts) - gated explicitly anyway for a true no-op (no
  // capture-object construction, no flush wait) rather than relying on the SDK's
  // internal no-op behavior.
  if (!process.env.SENTRY_DSN) return;

  try {
    Sentry.captureRequestError(err, request, context);
    // Serverless: flush before the function suspends.
    await Sentry.flush(2000);
  } catch (captureErr) {
    console.error("[instrumentation] failed to report error to Sentry", captureErr);
  }
};
