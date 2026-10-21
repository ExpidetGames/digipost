/**
 * Privileged entrypoint of `src/platform/observability`. Never imported from client-reachable
 * code. `captureError` is what any server-side code with no Next.js request boundary of its
 * own (a background job handler, `src/persistence/use-cases/jobs-use-cases.ts`) calls to
 * still reach Sentry when a DSN is configured - see `./server/capture-error.ts`.
 */
import "server-only";

export { captureError } from "./server/capture-error";
