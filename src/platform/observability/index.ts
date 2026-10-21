/**
 * Public entrypoint of `src/platform/observability`. Neutral (no `server-only`, no
 * `"use client"`): `sentryInitOptions` runs in Node, the edge runtime and the
 * browser alike - see `./core/init-options.ts`.
 */
export { redactInviteTokenFromUrl, sentryInitOptions, type SentryInitOptions } from "./core/init-options";
