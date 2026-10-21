/**
 * Access step for a JSON API route that requires a signed-in user's Better Auth
 * session (WEBAPP_TEMPLATE_SPEC.md §7's request-path table, the counterpart to
 * `server/cron-auth.ts`'s service-to-service bearer token). No route in this
 * template adopts it yet (the dashboard reaches the persistence layer through
 * Server Actions, not a JSON API route, `src/modules/workspaces/actions.ts`); it exists
 * so the pipeline supports both auth modes it documents, ready for the first
 * authenticated `src/app/api/**` route a project built from this template adds.
 */
import "server-only";

import { getCurrentUser, type CurrentUser } from "@/platform/auth/server";

/** Thrown by `requireSessionAccess` when the request carries no valid session. */
export class SessionAccessError extends Error {
  override readonly name = "SessionAccessError";
  constructor() {
    super("no valid session");
  }
}

/**
 * Resolves the signed-in user the same way `src/platform/auth/server`'s `requireUser`
 * does for Server Components, but never redirects: a JSON API route has no page to
 * redirect from. Throws `SessionAccessError` instead, for the pipeline's `access`
 * step to map to a 401 `ApiErrorResponse`.
 */
export async function requireSessionAccess(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) {
    throw new SessionAccessError();
  }
  return user;
}
