// Invitation flow, end to end (WEBAPP_TEMPLATE_SPEC.md §10, decisions/0014-workspaces-and-access.md):
// the admin invites an email from `/dashboard/team`, the invitee gets the mail in Mailpit
// (reading it does not touch Better Auth at all - only the invitation e-mail, our own
// mailer, not the magic-link flow), signs in, and accepts, appearing in the team list.
//
// The invitee's sign-in here uses a FAST SESSION (`createTestUser`/`loginAs`), not a real
// magic-link round trip: WEBAPP_TEMPLATE_SPEC.md §10.4 reserves real magic-link mail for
// `tests/e2e/serial/auth.spec.ts` alone, specifically because Better Auth's magic-link
// rate limit (3 requests/60s, keyed by IP - the SAME IP every worker in this Docker test
// stack shares) is a piece of global, cross-test shared state. This file runs in the
// *parallel* project, which finishes before `serial/` starts but not necessarily more than
// 60 seconds before - an earlier version of this test called `requestMagicLink` here and
// intermittently starved `serial/auth.spec.ts`'s own magic-link tests of their rate-limit
// budget (observed as "Too many requests" on Better Auth's `/magic-link/verify` endpoint
// in `serial/auth.spec.ts`, which does not touch this file at all). The redirect-when-
// signed-out behavior is still verified below without needing a real magic-link session to
// exist afterward - a separate context that never authenticates already proves it.
import { expect, test } from "./helpers/fixtures";
import { createTestUser, invitationLinkFor, loginAs } from "./helpers/auth";
import { deleteUserById, findUserIdByEmail, uniqueEmail } from "./helpers/db";

function pathOf(url: string): string {
  const u = new URL(url);
  return `${u.pathname}${u.search}`;
}

test(
  "admin invites an email, the invitee accepts, and appears in the team list",
  { tag: "@smoke" },
  async ({ page, browser, baseURL, adminUser }) => {
    const inviteeEmail = uniqueEmail("invitee");

    await page.goto("/dashboard/team");
    await expect(page.getByRole("heading", { name: "Team", exact: true })).toBeVisible();
    await page.getByLabel("E-Mail-Adresse").fill(inviteeEmail);
    await page.getByRole("button", { name: "Einladen" }).click();
    await expect(page.getByText(inviteeEmail)).toBeVisible();

    const inviteLink = await invitationLinkFor(inviteeEmail);

    // Signed out: a fresh, never-authenticated context visiting the invite link is
    // redirected to /login with a safe `next` back to this exact page.
    const anonymousContext = await browser.newContext();
    try {
      const anonymousPage = await anonymousContext.newPage();
      await anonymousPage.goto(inviteLink);
      await expect
        .poll(() => pathOf(anonymousPage.url()))
        .toBe(`/login?next=${encodeURIComponent(new URL(inviteLink).pathname)}`);
    } finally {
      await anonymousContext.close();
    }

    // The invitee signs in (fast session - see this file's header comment for why not a
    // real magic-link round trip) using exactly the invited email, then opens the same
    // invite link already authenticated.
    const inviteeContext = await browser.newContext();
    const inviteePage = await inviteeContext.newPage();
    try {
      const inviteeUser = await createTestUser("invitee", inviteeEmail);
      await loginAs(inviteeContext, inviteeUser, baseURL!);

      await inviteePage.goto(inviteLink);
      await expect(inviteePage.getByRole("heading", { name: "Einladung" })).toBeVisible();
      await expect(inviteePage.getByText(adminUser.workspace.name, { exact: false })).toBeVisible();

      await inviteePage.getByRole("button", { name: "Einladung annehmen" }).click();
      await expect.poll(() => pathOf(inviteePage.url())).toBe("/dashboard");
      await expect(inviteePage.getByText(adminUser.workspace.name).first()).toBeVisible();

      // Deleting the invitee's user row cascades away their membership
      // (src/persistence/schema/workspaces.ts's `onDelete: "cascade"` on
      // `workspace_members.userId`) - the admin-side assertions below need that
      // membership to still exist, so cleanup happens only after them (this test's
      // top-level `finally`), not here.
      await page.reload();
      // Scoped to the invitee's own row: "Mitglied" (role: member) is otherwise a
      // substring of the page's own "Mitglieder" heading/description, which would
      // make an unscoped `getByText("Mitglied")` ambiguous (strict-mode violation).
      const memberRow = page.locator("li").filter({ hasText: inviteeEmail });
      await expect(memberRow).toBeVisible();
      await expect(memberRow.getByText("Mitglied", { exact: false })).toBeVisible();
    } finally {
      await inviteeContext.close();
      await deleteUserById(await findUserIdByEmail(inviteeEmail));
    }
  },
);

test("accepting an invitation with a different signed-in email shows a clear error", async ({ page, browser, baseURL, adminUser }) => {
  const inviteeEmail = uniqueEmail("mismatch-invitee");

  // `adminUser` signs `page` in as an admin with a workspace before this body runs
  // (tests/e2e/helpers/fixtures.ts); asserting on its workspace name both uses the fixture
  // and proves the page really is signed in as that admin (not accidentally on /login,
  // which coincidentally has its own "E-Mail-Adresse" label that could otherwise mask a
  // missing-fixture bug as a plain "Einladen" button-not-found timeout).
  await page.goto("/dashboard/team");
  await expect(page.getByText(adminUser.workspace.name).first()).toBeVisible();
  await page.getByLabel("E-Mail-Adresse").fill(inviteeEmail);
  await page.getByRole("button", { name: "Einladen" }).click();
  await expect(page.getByText(inviteeEmail)).toBeVisible();

  const inviteLink = await invitationLinkFor(inviteeEmail);

  // The admin (already signed in, but with a DIFFERENT email than the invited one) opens
  // the invite link directly: the preview itself succeeds (it does not check identity),
  // but accepting does - `acceptInvitationAction` compares the invitation's email to
  // whoever is actually signed in, case-insensitively.
  //
  // P6 review finding E2 (this test flaked once): a fresh context/page re-authenticated as
  // the SAME admin, rather than reusing `page` (which just submitted the invite form on
  // `/dashboard/team`), the same isolation pattern the invitee already uses above in the
  // first test. This removes any possibility of the invite-link visit racing whatever
  // in-flight navigation/revalidation `page` itself might still be settling right after its
  // own form submission - `page` and its team-list assertions are left completely alone.
  const adminOnInviteContext = await browser.newContext();
  try {
    const adminOnInvitePage = await adminOnInviteContext.newPage();
    await loginAs(adminOnInviteContext, adminUser, baseURL!);

    await adminOnInvitePage.goto(inviteLink);
    await expect(adminOnInvitePage.getByRole("heading", { name: "Einladung" })).toBeVisible();
    await adminOnInvitePage.getByRole("button", { name: "Einladung annehmen" }).click();

    await expect(
      adminOnInvitePage.getByText("Diese Einladung wurde an eine andere E-Mail-Adresse gesendet.", { exact: false }),
    ).toBeVisible();
  } finally {
    await adminOnInviteContext.close();
  }

  // No user was ever created for `inviteeEmail` in this test (only the admin ever signs in)
  // - nothing to clean up beyond the invitation row itself, which lives on the admin's
  // workspace and is deleted along with it by the `adminUser` fixture's own teardown.
});
