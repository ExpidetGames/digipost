// The Next.js Route Handler bridge for `/api/auth/*` (WEBAPP_TEMPLATE_SPEC.md §6.2),
// used by `src/app/api/auth/[...all]/route.ts`. `getAuth()` runs per request (not at
// import time), so builds and tests that never touch this route do not need the auth
// env; `toNextJsHandler` is a cheap wrapper around it.
import "server-only";

import { toNextJsHandler } from "better-auth/next-js";

import { getAuth } from "./auth";

export const authRouteHandlers = {
  GET: (request: Request): Promise<Response> => toNextJsHandler(getAuth()).GET(request),
  POST: (request: Request): Promise<Response> => toNextJsHandler(getAuth()).POST(request),
};
