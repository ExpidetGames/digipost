// The signed-in user of the current request (WEBAPP_TEMPLATE_SPEC.md §6.2, §6.4).
import "server-only";

import { headers } from "next/headers";
import { redirect, unstable_rethrow } from "next/navigation";
import { cache } from "react";

import { CURRENT_PATH_HEADER } from "@/platform/auth/proxy-gate";

import { getAuth } from "./auth";

export type CurrentUser = { id: string; email: string };

/**
 * `{ id, email }` of the signed-in user, or `null`. `getSession` reads the session
 * cookie (falling back to the short-lived signed cookie cache configured in
 * `./auth.ts` before hitting the database). Memoized per request (`react cache`) so
 * a layout, a page and its Server Actions share one lookup. Never throws: on any
 * error (including a misconfigured/unreachable auth database) the request is
 * treated as signed out - `requireUser()` then redirects to `/login`.
 */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  try {
    const session = await getAuth().api.getSession({ headers: await headers() });
    if (!session) return null;
    const { id, email } = session.user;
    return { id, email };
  } catch (err) {
    // Next's own control-flow errors (dynamic rendering bailout, redirects) must propagate.
    unstable_rethrow(err);
    console.warn("[auth] getSession threw", err instanceof Error ? err.message : err);
    return null;
  }
});

/** Auth check for pages under `(app)`. Redirects signed-out requests to `/login`,
 * preserving the current path as `next=` when the proxy set it
 * (`src/platform/auth/proxy-gate.ts`'s `CURRENT_PATH_HEADER`). */
export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) {
    const currentPath = (await headers()).get(CURRENT_PATH_HEADER);
    redirect(currentPath ? `/login?next=${encodeURIComponent(currentPath)}` : "/login");
  }
  return user;
}
