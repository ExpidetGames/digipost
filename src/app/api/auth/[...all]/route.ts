// Better Auth's own handler (WEBAPP_TEMPLATE_SPEC.md §6.2): magic-link sign-in,
// `/magic-link/verify`, `get-session`, `sign-out`, and every other Better Auth
// endpoint. The magic link mailed to users points here directly
// (`/api/auth/magic-link/verify?token=…&callbackURL=…`): Better Auth verifies the
// token, sets the session cookie, and redirects to `callbackURL` itself - there is
// no separate callback route.
import { authRouteHandlers } from "@/platform/auth/server";

export const dynamic = "force-dynamic";

export const { GET, POST } = authRouteHandlers;
