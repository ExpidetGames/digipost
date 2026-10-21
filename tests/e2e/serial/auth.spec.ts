/**
 * Auth: magic link only (Better Auth, self-hosted - WEBAPP_TEMPLATE_SPEC.md §6).
 *
 * Lives in tests/e2e/serial/, not tests/e2e/ (playwright.config.ts's "serial" project, `workers:
 * 1`, dependent on the parallel "chromium" project finishing first): this file's real
 * magic-link requests share Better Auth's sign-in rate limit (3 requests / 60s, keyed
 * by IP - src/platform/auth/server/auth.ts), and every worker in this Docker test stack
 * shares one IP. With `workers: 1` at most one instance of this file's tests is ever
 * running, so its requests can never race another worker's for that same quota - this
 * matters with Playwright's `--repeat-each`: each repeat is its own independent test
 * run that Playwright is free to schedule onto any available worker, so with the
 * default (unpinned) worker count, two repeats of this file really did run
 * concurrently and race each other's rate-limit quota (confirmed by re-running with
 * `--repeat-each=5 --workers=2` before this file moved here: failures interleaved
 * across repeat instances instead of only ever appearing in the repeat right after
 * the rate-limit test).
 *
 * Within that single worker, `test.describe.configure({ mode: "serial" })` below still
 * keeps this file's own tests - and every one of a repeat's copies of them - in
 * deterministic file order, since `fullyParallel` (playwright.config.ts) would
 * otherwise let Playwright interleave this file's tests with another file's on the
 * same worker.
 *
 * The last test ("login rate limit") deliberately drains that quota and resets it
 * afterwards (helpers/db.ts's `clearMagicLinkRateLimit`) - without that, a rerun of
 * this file within the same 60s window (each `--repeat-each` repetition runs the whole
 * file again, back-to-back since workers are pinned to 1) would start with an
 * already-exhausted quota and the next pass's real magic-link requests would be
 * rejected before they could even reach Mailpit.
 */
import { expect, test, type Page } from "@playwright/test";

import { AUTH_COOKIE_RE, SESSION_COOKIE, createTestUser, loginAs, magicLinkFor, requestMagicLink } from "../helpers/auth";
import { clearMagicLinkRateLimit, createDbUser, deleteUserById, findUserIdByEmail, uniqueEmail } from "../helpers/db";
import { createPendingInvitation, createWorkspaceForUser, deleteWorkspaceById } from "../helpers/workspace";

test.describe.configure({ mode: "serial" });

const createdEmails: string[] = [];
// Workspaces do not cascade from user deletion (src/persistence/schema/workspaces.ts,
// decisions/0014-workspaces-and-access.md): every workspace a test creates here is
// tracked and deleted explicitly, before the user cleanup below runs.
const createdWorkspaceIds: string[] = [];

test.afterAll(async () => {
  for (const id of createdWorkspaceIds) {
    await deleteWorkspaceById(id);
  }
  for (const email of createdEmails) {
    await deleteUserById(await findUserIdByEmail(email));
  }
});

function pathOf(url: string): string {
  const u = new URL(url);
  return `${u.pathname}${u.search}`;
}

/** Records the app-host URLs a navigation passes through (redirect chain). */
function recordRequests(page: Page): string[] {
  const urls: string[] = [];
  page.on("request", (req) => urls.push(req.url()));
  return urls;
}

test(
  "guard: a fast session (user + session row inserted directly, cookie signed like Better Auth's own) is accepted on a protected page",
  async ({ page, context, baseURL }) => {
    const user = await createTestUser("guard");
    createdEmails.push(user.email);
    await loginAs(context, user, baseURL!);
    const workspace = await createWorkspaceForUser(user.id, "Guard Test GmbH");
    createdWorkspaceIds.push(workspace.id);

    // /dashboard is the "Posteingang" placeholder page (src/modules/dashboard-shell/core/nav-items.ts);
    // the header (src/modules/dashboard-shell) is what proves the session, showing the
    // signed-in user's email and workspace name on every (app) page.
    await page.goto("/dashboard");
    await expect.poll(() => pathOf(page.url())).toBe("/dashboard");

    await expect(page.getByRole("heading", { name: "Posteingang" })).toBeVisible();
    await expect(page.getByText(user.email)).toBeVisible();
    // .first(): the workspace name renders twice (desktop sidebar + mobile header,
    // src/modules/dashboard-shell/ui/dashboard-shell.tsx), only one visible per viewport.
    await expect(page.getByText("Guard Test GmbH").first()).toBeVisible();
  },
);

test("a signed-in user without a workspace is redirected to /onboarding", async ({ page, context, baseURL }) => {
  const user = await createTestUser("no-workspace");
  createdEmails.push(user.email);
  await loginAs(context, user, baseURL!);

  await page.goto("/dashboard");

  await expect.poll(() => pathOf(page.url())).toBe("/onboarding");
  await expect(page.getByRole("heading", { name: "Willkommen bei Digipost" })).toBeVisible();
});

test("/dashboard redirects to /login when signed out, keeping the return path", async ({ page }) => {
  await page.goto("/dashboard/does-not-exist?x=1");

  await expect
    .poll(() => pathOf(page.url()))
    .toBe(`/login?next=${encodeURIComponent("/dashboard/does-not-exist?x=1")}`);
  await expect(page.locator('input[type="hidden"][name="next"]')).toHaveValue("/dashboard/does-not-exist?x=1");
  await expect(page.getByRole("heading", { name: "Anmelden" })).toBeVisible();
  await expect(page.getByLabel("E-Mail-Adresse")).toBeVisible();
});

test("an open-redirect attempt in next= is neutralized", async ({ page }) => {
  await page.goto("/login?next=https://evil.example.com");

  // safeNextPath (src/modules/sign-in/core/safe-next-path.ts) rejects the absolute URL
  // and falls back to /dashboard - the hidden field never carries the attacker's target.
  await expect(page.locator('input[type="hidden"][name="next"]')).toHaveValue("/dashboard");
});

test("sign out clears the session and returns to /login", async ({ page, context, baseURL }) => {
  const user = await createTestUser("signout");
  createdEmails.push(user.email);
  await loginAs(context, user, baseURL!);
  const workspace = await createWorkspaceForUser(user.id, "Sign Out Test GmbH");
  createdWorkspaceIds.push(workspace.id);

  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: "Posteingang" })).toBeVisible();

  await page.getByRole("button", { name: "Abmelden" }).click();
  await expect.poll(() => pathOf(page.url())).toBe("/login");
  await expect(page.getByLabel("E-Mail-Adresse")).toBeVisible();

  // Session is really gone: back on /dashboard, signed out.
  await page.goto("/dashboard");
  await expect.poll(() => pathOf(page.url())).toBe(`/login?next=${encodeURIComponent("/dashboard")}`);

  // The app (running as a production build, `useSecureCookies: true`) only ever
  // sets/clears the `__Secure-`-prefixed cookie; that one must be gone. The plain,
  // unprefixed variant is an artifact of `loginAs()` planting both variants for
  // host-mode compatibility (tests/e2e/helpers/auth.ts) - the app never reads or writes
  // it here, so it is not part of what "signed out" means in this run.
  const remaining = (await context.cookies()).filter((c) => AUTH_COOKIE_RE.test(c.name));
  expect(remaining.map((c) => c.name)).not.toContain(`__Secure-${SESSION_COOKIE}`);
});

test("magic link: an invited address requests, opens, and lands on /dashboard", { tag: "@smoke" }, async ({ page }) => {
  // Better Auth's magic-link plugin shares ONE rate-limit bucket between the sign-in
  // request AND the verify endpoint (`node_modules/better-auth/dist/plugins/magic-link`'s
  // own `rateLimit: [{ pathMatcher: (p) => p.startsWith("/sign-in/magic-link") ||
  // p.startsWith("/magic-link/verify"), ... }]`, matched before our own `customRules` in
  // `src/platform/auth/server/auth.ts`), not a separate one per path the way this file's
  // `MAGIC_LINK_RATE_LIMIT` naming/comments suggest. This test alone makes 2 real calls
  // (1 request + 1 verify) against that combined 3-per-60s budget, and the very next test
  // makes 3 more (1 request + 2 verifies, exactly exhausting a fresh budget with zero
  // slack) - resetting here guarantees both tests start from a clean, fully-available
  // budget regardless of what ran earlier in this file, without touching that shared
  // Better Auth config itself (out of this phase's scope, decisions/0005).
  await clearMagicLinkRateLimit();
  const email = uniqueEmail("auth");
  createdEmails.push(email);
  // decisions/0074: a new account needs a pending invitation.
  const inviter = await createDbUser("auth-inviter");
  createdEmails.push(inviter.email);
  const inviterWorkspace = await createWorkspaceForUser(inviter.id, "Einladende GmbH");
  createdWorkspaceIds.push(inviterWorkspace.id);
  await createPendingInvitation(inviterWorkspace.id, email, inviter.id);

  await page.goto("/login");
  await requestMagicLink(page, email);
  await expect(page.getByText(email)).toBeVisible();
  await expect(page.getByText("Der Link ist 15 Minuten gültig", { exact: false })).toBeVisible();

  const link = await magicLinkFor(email);
  const visited = recordRequests(page);

  // Better Auth verify -> redirect to /dashboard (cookie set on the way) -> a brand-new
  // user has no workspace yet, so (app)/layout.tsx's requireWorkspaceMember() redirects
  // on to /onboarding (decisions/0014-workspaces-and-access.md; the dedicated onboarding
  // flow itself is tests/e2e/onboarding.spec.ts).
  await page.goto(link);
  await expect.poll(() => pathOf(page.url())).toBe("/onboarding");
  expect(visited.some((u) => u.includes("/api/auth/magic-link/verify?"))).toBe(true);
  await expect(page.getByRole("heading", { name: "Willkommen bei Digipost" })).toBeVisible();

  // The session cookie is host-only, HttpOnly, SameSite=Lax, and (the app always
  // runs as a production build for e2e, see tests/e2e/helpers/auth.ts's `loginAs` doc)
  // Secure / __Secure-prefixed.
  const authCookies = (await page.context().cookies()).filter((c) => AUTH_COOKIE_RE.test(c.name));
  expect(authCookies.map((c) => c.name)).toContain("__Secure-better-auth.session_token");
  for (const c of authCookies) {
    expect(c, c.name).toMatchObject({ domain: "localhost", secure: true, httpOnly: true, sameSite: "Lax" });
  }

  // Already signed in -> /login bounces straight back to /dashboard -> still no
  // workspace, so on to /onboarding again.
  await page.goto("/login");
  await expect.poll(() => pathOf(page.url())).toBe("/onboarding");
});

test("magic link can only be used once", async ({ page }) => {
  // This test alone makes 3 real calls against the shared sign-in+verify rate-limit
  // budget (1 request + 2 verifies - see the previous test's comment for why it is
  // shared): exactly the full 3-per-60s allowance with zero slack. Reset first so a
  // stray earlier call (a retry, the previous test's own request) never pushes this
  // test's own second (legitimate, expected-to-be-rejected-for-reuse-not-rate-limit)
  // verify over the limit.
  await clearMagicLinkRateLimit();
  // decisions/0074: an existing account (no workspace yet), the other way to get a link.
  const { email } = await createDbUser("auth-once");
  createdEmails.push(email);

  await page.goto("/login");
  await requestMagicLink(page, email);
  const link = await magicLinkFor(email);

  await page.goto(link);
  // The account has no workspace yet, so this lands on /onboarding.
  await expect.poll(() => pathOf(page.url())).toBe("/onboarding");

  // Sign out before the second use - kellner-connect's own equivalent test (this
  // template's proven prior art, `e2e/serial/auth.spec.ts`) does the same via its
  // dashboard's user menu; `/onboarding` has no sign-out control of its own (unlike the
  // (app) shell). Without this, the token rejection itself still works correctly
  // server-side (confirmed via a `Location: /login?error=INVALID_TOKEN` response header
  // while diagnosing this), but `/login`'s own "already signed in -> redirect to next"
  // check (`src/app/(auth)/login/page.tsx`) immediately bounces away from that error page
  // before this test can observe it, straight back through /dashboard -> /onboarding -
  // making the reused token look silently accepted. A real in-page `fetch` (not
  // Playwright's out-of-band `page.request`, which sends no `Origin` header and gets
  // rejected by Better Auth with `MISSING_OR_NULL_ORIGIN`) signs out through the same
  // origin the browser is actually on, exactly like a real sign-out button click.
  await page.evaluate(() =>
    fetch("/api/auth/sign-out", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
  );

  // Second use: Better Auth rejects the consumed token (INVALID_TOKEN) -> our /login page.
  await page.goto(link);
  await expect.poll(() => pathOf(page.url())).toBe("/login?error=INVALID_TOKEN");
  // Not `getByRole("alert")`: Next's route announcer (`#__next-route-announcer__`)
  // also carries `role="alert"`, so scope to the form's own error paragraph.
  await expect(
    page.getByText("Dieser Anmeldelink ist abgelaufen oder wurde bereits verwendet.", { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Anmeldelink senden" })).toBeVisible();
});

test.describe("login rate limit", () => {
  test.describe.configure({ mode: "serial" });

  test("requesting more sign-in links than the limit shows the rate-limit message instead of succeeding silently", async ({
    page,
  }) => {
    test.setTimeout(30_000);
    const email = uniqueEmail("ratelimit");
    createdEmails.push(email);

    const sent = page.getByRole("heading", { name: "Bitte prüfen Sie Ihr Postfach" });
    const limited = page.getByText("Es wurden zu viele Anmeldelinks angefordert.", { exact: false });
    const useDifferentAddress = page.getByRole("button", { name: "Andere E-Mail-Adresse verwenden" });

    await page.goto("/login");
    let sawLimit = false;
    try {
      const MAX_ATTEMPTS = 6;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS && !sawLimit; attempt++) {
        if (await useDifferentAddress.isVisible().catch(() => false)) await useDifferentAddress.click();
        await page.getByLabel("E-Mail-Adresse").fill(email);
        await page.getByRole("button", { name: "Anmeldelink senden" }).click();
        await expect(sent.or(limited)).toBeVisible({ timeout: 15_000 });
        if (await limited.isVisible()) sawLimit = true;
      }
      expect(sawLimit, `rate-limit message never appeared after ${MAX_ATTEMPTS} requests`).toBe(true);
    } finally {
      // This test deliberately drains the shared, IP-keyed, database-backed rate
      // limit (helpers/db.ts's clearMagicLinkRateLimit doc). `try/finally`, not a
      // hook: a describe-level `afterAll` only fires once for the whole run,
      // including every `--repeat-each` repetition (see this file's top-level
      // `afterAll`, which likewise accumulates emails across repeats rather than
      // running per repeat) - it would never reset the quota between passes.
      // Putting the reset in the test body instead runs it after every repeat of
      // this test, so the next pass's first real request ("magic link: request,
      // open, land on /dashboard", earlier in file order - both passes run in the
      // same `workers: 1` project, back-to-back, well inside the 60s window) starts
      // with a fresh quota instead of the one this test just exhausted.
      await clearMagicLinkRateLimit();
    }
  });
});

// decisions/0074-sign-up-by-invitation-only.md
test("an address with neither an account nor an invitation gets the same answer and no mail", async ({ page }) => {
  await clearMagicLinkRateLimit();
  const email = uniqueEmail("stranger");

  await page.goto("/login");
  await requestMagicLink(page, email);
  await expect(page.getByText(email)).toBeVisible();
  await expect(page.getByText("Falls für", { exact: false })).toBeVisible();

  // The send path returns before any mail is queued; give a delivered mail time to show up.
  await page.waitForTimeout(3_000);
  await expect(magicLinkFor(email, 1_000)).rejects.toThrow();
  expect(await findUserIdByEmail(email)).toBeUndefined();
});
