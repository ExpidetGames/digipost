// Guard for `reuseExistingServer` (playwright.config.ts): make sure the server at
// baseURL really is this app, not some other project's `next dev` reusing the same
// port. Also warms up a few routes: a production `next start` server (unlike
// `next dev`) does not eagerly require every route handler's compiled chunk at
// boot, so the FIRST request to each distinct route (`/login`, `/dashboard`,
// `/api/auth/*` - which also builds the lazy Better Auth instance and its database
// pool, src/platform/auth/server/auth.ts) is measurably slower than every one after
// it. Without this, the first test to touch a given route can exceed its
// assertion's timeout even though nothing is actually broken. Runs once, after
// Playwright started/detected the web server.
import type { FullConfig } from "@playwright/test";

async function warmUp(baseURL: string, path: string): Promise<void> {
  try {
    await fetch(new URL(path, baseURL), { redirect: "manual" });
  } catch {
    // Best-effort: a warm-up request failing outright (vs. just being slow) will
    // surface as a real test failure below anyway.
  }
}

export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use.baseURL;
  if (!baseURL) return;
  const res = await fetch(new URL("/", baseURL));
  const body = await res.text();
  if (!body.includes("Digipost")) {
    throw new Error(
      `The server at ${baseURL} does not look like this app (GET / -> ${res.status}, missing "Digipost"). ` +
        "Another project is using this port - pick a free one via E2E_PORT.",
    );
  }

  await warmUp(baseURL, "/login");
  await warmUp(baseURL, "/dashboard");
  await warmUp(baseURL, "/api/auth/get-session");
  // Forces Next to load/compile `/api/documents`'s own route module too (a GET 405s, but
  // only after resolving which methods the route exports) - the same "pay the first
  // request's compile cost here, not in a test" rationale as the three warm-ups above.
  // (P6 review: this alone was NOT the fix for billing.spec.ts's/documents.spec.ts's/
  // processing.spec.ts's upload flake investigated in this phase - that turned out to be a
  // real client-side race in the specs themselves, fixed there directly; kept here anyway
  // as ordinary hygiene for this route's own first-request cost.)
  await warmUp(baseURL, "/api/documents");
}
