// The active-workspace cookie (decisions/0070-several-workspaces-per-user.md): which of the
// caller's workspaces this browser is currently looking at.
//
// The cookie is CLIENT INPUT and nothing else. It never grants access: `resolveAccess`
// (`./get-workspace-access.ts`) only ever uses the id it carries after a database lookup has
// confirmed the signed-in user really is a member of that workspace, on every single
// request. A forged, stale, or malformed cookie therefore degrades silently to the caller's
// oldest membership - it can never widen what the caller may see, and it never reveals
// whether the workspace it names exists at all.
//
// Reading happens while rendering a Server Component, which is why reads and writes live in
// separate functions here: `cookies().set()` only works inside a Server Function or a Route
// Handler (AGENTS.md's Next.js notes), so only `src/modules/workspaces`' Server Actions call
// the writers below.
import "server-only";

import { cookies } from "next/headers";
import { unstable_rethrow } from "next/navigation";

/** Name kept product-neutral and prefixed like the rest of this app's own cookies. */
export const ACTIVE_WORKSPACE_COOKIE = "digipost.active_workspace";

/** One year: a browser that comes back after a long absence should still land in the
 * workspace it was last looking at, and a stale value costs nothing (it is re-checked
 * against the database on every request, and falls back when it no longer resolves). */
const ACTIVE_WORKSPACE_COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    path: "/",
    // `secure` only in production: the local dev stack and the Playwright run both serve
    // plain HTTP, where a `Secure` cookie would simply never be stored.
    secure: process.env.NODE_ENV === "production",
    maxAge: ACTIVE_WORKSPACE_COOKIE_MAX_AGE_SECONDS,
  };
}

/**
 * The workspace id the browser claims to be looking at, or `null`. Anything that is not a
 * syntactically valid uuid is treated as absent and never reaches the database - a
 * `workspaces.id` comparison against a malformed uuid is a Postgres error, and this
 * function's whole contract is that it cannot make a request fail. Never throws: a context
 * where `cookies()` is unavailable also resolves to `null` (and therefore to the fallback).
 * `unstable_rethrow` first, for the same reason `@/platform/auth/server`'s `getCurrentUser`
 * uses it: Next's own control-flow errors (a dynamic-rendering bailout, a redirect) travel as
 * exceptions and must never be swallowed by a defensive catch.
 */
export async function readActiveWorkspaceId(): Promise<string | null> {
  try {
    const value = (await cookies()).get(ACTIVE_WORKSPACE_COOKIE)?.value;
    if (!value || !UUID_PATTERN.test(value)) return null;
    return value;
  } catch (err) {
    unstable_rethrow(err);
    return null;
  }
}

/** Server Functions/Route Handlers only. The caller MUST have verified the membership
 * first - this writes whatever it is given. */
export async function setActiveWorkspaceCookie(workspaceId: string): Promise<void> {
  (await cookies()).set(ACTIVE_WORKSPACE_COOKIE, workspaceId, cookieOptions());
}

/** Server Functions/Route Handlers only. Called when the active workspace stops existing for
 * the caller (leaving it, deleting it), so the next request falls back cleanly instead of
 * carrying a dead id around for a year. */
export async function clearActiveWorkspaceCookie(): Promise<void> {
  (await cookies()).delete(ACTIVE_WORKSPACE_COOKIE);
}
