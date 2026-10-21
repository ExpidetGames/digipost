// Onboarding, end to end (WEBAPP_TEMPLATE_SPEC.md §10, decisions/0014-workspaces-and-access.md):
// a signed-in user without a workspace is redirected to /onboarding, creates one through
// the real form, and lands on /dashboard with the workspace name visible. Uses the plain
// `createTestUser`/`loginAs` helpers directly (not the `user` Playwright fixture) so this
// spec controls its own cleanup order: the workspace it creates through the UI does not
// cascade from the user's deletion (src/persistence/schema/workspaces.ts), so it must be
// looked up and deleted explicitly, before the user.
import { expect, test } from "@playwright/test";

import { createTestUser, loginAs } from "./helpers/auth";
import { deleteUserById } from "./helpers/db";
import { createWorkspaceForUser, deleteWorkspaceById, findWorkspaceIdForUser } from "./helpers/workspace";

test("a new user creates a workspace and lands on the dashboard with the workspace name visible", { tag: "@smoke" }, async ({
  page,
  context,
  baseURL,
}) => {
  const user = await createTestUser("onboarding");
  await loginAs(context, user, baseURL!);

  try {
    await page.goto("/dashboard");
    await expect.poll(() => new URL(page.url()).pathname).toBe("/onboarding");
    await expect(page.getByRole("heading", { name: "Willkommen bei Digipost" })).toBeVisible();

    // C2 (decisions/0021-extraction-direction-and-invoice-fields.md): onboarding also
    // requires a company address (line 2/VAT id stay optional, country defaults to "DE").
    await page.getByLabel("Firmenname").fill("Neue Firma GmbH");
    await page.getByLabel("Straße und Hausnummer").fill("Musterstraße 1");
    await page.getByLabel("PLZ").fill("10115");
    await page.getByLabel("Ort").fill("Berlin");
    await page.getByRole("button", { name: "Arbeitsbereich anlegen" }).click();

    await expect.poll(() => new URL(page.url()).pathname).toBe("/dashboard");
    await expect(page.getByRole("heading", { name: "Posteingang" })).toBeVisible();
    await expect(page.getByText("Neue Firma GmbH").first()).toBeVisible();
    await expect(page.getByText(user.email)).toBeVisible();
  } finally {
    await deleteWorkspaceById(await findWorkspaceIdForUser(user.id));
    await deleteUserById(user.id);
  }
});

test("a user who already has a workspace visiting /onboarding is redirected to /dashboard", async ({
  page,
  context,
  baseURL,
}) => {
  const user = await createTestUser("already-onboarded");
  await loginAs(context, user, baseURL!);
  const workspace = await createWorkspaceForUser(user.id, "Existing Co");

  try {
    await page.goto("/onboarding");
    await expect.poll(() => new URL(page.url()).pathname).toBe("/dashboard");
    await expect(page.getByText("Existing Co").first()).toBeVisible();
  } finally {
    await deleteWorkspaceById(workspace.id);
    await deleteUserById(user.id);
  }
});
