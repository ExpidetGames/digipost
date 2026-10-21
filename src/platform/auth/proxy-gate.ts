// Further subpath (WEBAPP_TEMPLATE_SPEC.md §4.2: "weitere Subpaths ... nur mit
// Begründung im Owner-README und im Dateikopf", justified here and in
// src/platform/auth/README.md). Imported only by src/proxy.ts (WEBAPP_TEMPLATE_SPEC.md §6.2):
// `better-auth/cookies` is a tiny, dependency-free cookie-presence check (no
// DB/network), so it is safe to import unconditionally from the proxy, unlike
// `./server.ts` (which builds the whole Better Auth instance, including a database
// connection, on first use) or anything under `src/persistence/`.
import { getSessionCookie } from "better-auth/cookies";
import type { NextRequest } from "next/server";

/** Whether a session cookie is present - presence only, not validity. */
export function hasSessionCookie(request: NextRequest): boolean {
  return Boolean(getSessionCookie(request));
}

/**
 * Request header src/proxy.ts sets to the current pathname + search on every request it
 * lets through to a protected route. Server Components have no other way to read the
 * current request's path (no server-side `usePathname`); `requireUser()`
 * (`src/platform/auth/server/session.ts`) reads it to rebuild `next=` for the rare
 * defense-in-depth case where the proxy's cookie-presence check passed but the
 * session turns out to be invalid or expired by the time the `(app)` layout
 * validates it for real.
 */
export const CURRENT_PATH_HEADER = "x-current-path";
