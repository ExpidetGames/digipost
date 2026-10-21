import "server-only";

/**
 * Privileged entrypoint of `src/platform/auth` (WEBAPP_TEMPLATE_SPEC.md §6.2). Never
 * imported from client-reachable code; see `src/platform/auth/proxy-gate.ts` for the
 * one deliberately DB-free subpath the proxy uses instead.
 */
export { getAuth, MAGIC_LINK_EXPIRES_IN_SECONDS, resetAuthForTests } from "./server/auth";
export { getCurrentUser, requireUser, type CurrentUser } from "./server/session";
export { authRouteHandlers } from "./server/route-handlers";
