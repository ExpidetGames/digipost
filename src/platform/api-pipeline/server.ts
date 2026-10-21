import "server-only";

/**
 * Privileged entrypoint of `src/platform/api-pipeline`. Never imported from
 * client-reachable code. The two access steps a route picks between: a cron
 * bearer secret (`server/cron-auth.ts`) or a Better Auth session
 * (`server/require-session-access.ts`).
 */
export { CronAuthError, requireCronSecret } from "./server/cron-auth";
export { startLocalCronSweeper } from "./server/local-cron-sweeper";
export { SessionAccessError, requireSessionAccess } from "./server/require-session-access";
