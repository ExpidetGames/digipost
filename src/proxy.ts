// Next 16 Proxy (formerly middleware, WEBAPP_TEMPLATE_SPEC.md §6.2, §6.4). Cookie
// presence only: signed-out `/dashboard/*` or `/onboarding` -> `/login?next=…`. The
// `(app)` layout (`requireWorkspaceMember()`) and the `/onboarding` page
// (`requireUser()`) still do the real auth check, so a forged or expired cookie never
// gets past that point. `/invite/[token]` is deliberately NOT in the matcher: it must be
// reachable signed out too, so it can redirect to `/login` itself with a `next=` back to
// the invite page (decisions/0014-workspaces-and-access.md).
//
// Imports only `src/platform/auth/proxy-gate.ts` (no DB/network) so the proxy bundle
// never pulls in the rest of the auth graph, let alone `src/persistence/**`
// (WEBAPP_TEMPLATE_SPEC.md §5.1: "Der Proxy importiert gar nichts aus src/persistence/").
import { NextResponse, type NextRequest } from "next/server";

import { CURRENT_PATH_HEADER, hasSessionCookie } from "@/platform/auth/proxy-gate";

export function proxy(request: NextRequest): NextResponse {
  const { pathname, search } = request.nextUrl;

  if (!hasSessionCookie(request)) {
    const login = request.nextUrl.clone();
    login.pathname = "/login";
    login.search = `?next=${encodeURIComponent(`${pathname}${search}`)}`;
    return NextResponse.redirect(login, 307);
  }

  // Session cookie present (not yet validated - the (app) layout does that): let
  // the request through, carrying the current path for `requireUser()`'s rare
  // defense-in-depth redirect (see src/platform/auth/proxy-gate.ts's header doc).
  const forwardedHeaders = new Headers(request.headers);
  forwardedHeaders.set(CURRENT_PATH_HEADER, `${pathname}${search}`);
  return NextResponse.next({ request: { headers: forwardedHeaders } });
}

export const config = {
  // Static matcher (Next 16: matcher values must be constants, no env/computed
  // values - WEBAPP_TEMPLATE_SPEC.md's Next.js notes).
  matcher: ["/dashboard/:path*", "/onboarding"],
};
