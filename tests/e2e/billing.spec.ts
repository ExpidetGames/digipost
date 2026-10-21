// Billing, end to end (decisions/0017-billing-tiers-and-packages.md): an admin uploads a
// document, sees correct usage numbers on /dashboard/billing, changes the tier in test mode,
// buys a package, and a plain member sees the same page read-only, without any controls.
// Uses the `adminUser` fixture (a fast session with a real workspace,
// `tests/e2e/helpers/fixtures.ts`) plus a second, member-role session for the read-only
// assertion (the same pattern `tests/e2e/invitation.spec.ts` uses for a second user).
import { expect, test } from "./helpers/fixtures";
import { createTestUser, loginAs } from "./helpers/auth";
import { addMemberToWorkspace } from "./helpers/workspace";
import { deleteUserById, uniqueEmail } from "./helpers/db";
import { createTestPdfBuffer } from "./helpers/pdf-fixture";

test(
  "admin sees correct usage after an upload, changes tier in test mode, and buys a package",
  { tag: "@smoke" },
  async ({ page, adminUser }) => {
    // One document, so /dashboard/billing shows "1" rather than "0" stored documents.
    await page.goto("/dashboard/scan");
    // Proves the page has actually painted its SSR markup - cheap wall-clock margin before
    // the file input interaction below, though this alone does not prove React has finished
    // hydrating and attached its `change` listener (see the root-cause comment there).
    await expect(page.getByRole("heading", { name: "Post erfassen" })).toBeVisible();
    const buffer = await createTestPdfBuffer();
    // F5 root cause (decisions/0027-hardening-and-deletion.md): P6's earlier fix here waited
    // for the file selection to reach the form's own React state (rendered as the file name
    // in the list below `ui/upload-form.tsx`'s dropzone) before submitting, on the theory
    // that `setInputFiles` only guarantees the DOM input's `change` event fired, not that the
    // component's `onChange`-driven re-render has completed. That wait alone still flaked:
    // `page.goto()` resolves on the `load` event, not on React having finished hydrating and
    // attached its delegated `change` listener to this client component
    // (`UploadForm`/`CameraScanner` both statically bundled here). If `setInputFiles` fires
    // the native `change` event before that listener attaches, React silently drops it -
    // never queued, never replayed - so `files` stays empty and P6's own wait times out
    // after 20s instead of racing ahead too early. Wrapping the whole select-and-verify step
    // in `toPass` resends the (idempotent) file selection until hydration is unambiguously
    // complete, which is a targeted retry of one browser event for a real, well-understood
    // DOM-event-vs-hydration race - never a raised retry count or a skip to hide a flaky
    // assertion.
    await expect(async () => {
      await page.setInputFiles('input[type="file"]', { name: "billing-testdokument.pdf", mimeType: "application/pdf", buffer });
      await expect(page.getByText("billing-testdokument.pdf")).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
    await page.getByRole("button", { name: "Hochladen" }).click();
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 20_000 }).toMatch(/^\/dashboard\/documents\/.+/);

    await page.goto("/dashboard/billing");
    await expect(page.getByRole("heading", { name: "Tarif & Nutzung" })).toBeVisible();
    // `adminUser`'s workspace name is also visible, proving we stayed in our own workspace
    // (`tests/e2e/documents.spec.ts` uses the same assertion for the same reason).
    await expect(page.getByText(adminUser.workspace.name).first()).toBeVisible();
    await expect(page.getByRole("heading", { name: "Free", exact: true })).toBeVisible();
    await expect(page.getByText("1 / 20")).toBeVisible(); // Free's total limit is 20.
    // Free has no monthly limit - exact match: the package section's own "not available on
    // Free" copy also contains this substring.
    await expect(page.getByText("kein monatliches Limit", { exact: true })).toBeVisible();

    // Testmodus badge is visible on the management controls (BILLING_TEST_MODE=true in the
    // hermetic test stack, docker/compose.test.yml).
    await expect(page.getByText("Testmodus").first()).toBeVisible();

    // Change the tier to Starter.
    await page.getByLabel("Neuer Tarif").selectOption("starter");
    await page.getByRole("button", { name: "Tarif ändern" }).click();
    await expect(page.getByRole("heading", { name: "Starter", exact: true })).toBeVisible();
    await expect(page.getByText("1 / 750")).toBeVisible(); // Starter's total limit.

    // Starter can purchase packages (Free cannot) - buy package S.
    await expect(page.getByRole("heading", { name: "Digitalisierungspaket kaufen" })).toBeVisible();
    const packageSCard = page.locator("li").filter({ hasText: "Paket S" });
    await packageSCard.getByRole("button", { name: "Kaufen" }).click();

    await expect(page.getByText("Paket S (+250)")).toBeVisible();
    // The effective monthly limit (100 base + 250 from the package) is now reflected; the
    // one document uploaded above already counted toward this calendar month's creations.
    await expect(page.getByText("1 / 350")).toBeVisible();
  },
);

test("a member without billing.manage sees the read-only view, no management controls", async ({ browser, baseURL, adminUser }) => {
  const memberEmail = uniqueEmail("billing-member");
  const memberContext = await browser.newContext();
  try {
    const memberPage = await memberContext.newPage();
    const memberUser = await createTestUser("billing-member", memberEmail);
    await addMemberToWorkspace(adminUser.workspace.id, memberUser.id);
    await loginAs(memberContext, memberUser, baseURL!);

    await memberPage.goto("/dashboard/billing");
    await expect(memberPage.getByRole("heading", { name: "Tarif & Nutzung" })).toBeVisible();
    await expect(memberPage.getByText("Nur der Administrator", { exact: false })).toBeVisible();
    await expect(memberPage.getByLabel("Neuer Tarif")).toHaveCount(0);
    await expect(memberPage.getByRole("button", { name: "Tarif ändern" })).toHaveCount(0);
    await expect(memberPage.getByRole("button", { name: "Kaufen" })).toHaveCount(0);

    await deleteUserById(memberUser.id);
  } finally {
    await memberContext.close();
  }
});
