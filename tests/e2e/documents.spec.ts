// Documents, end to end (decisions/0015-documents-and-quotas.md): upload a small PDF via
// the file input on /dashboard/scan, see it in the Posteingang, open the detail page, the
// PDF embed is present, then delete it. Uses the `adminUser` fixture
// (a fast session with a real workspace, `tests/e2e/helpers/fixtures.ts`) since every page
// here requires workspace membership.
import { expect, test } from "./helpers/fixtures";
import { createTestPdfBuffer } from "./helpers/pdf-fixture";

test(
  "uploads a PDF, sees it in the inbox, opens the detail page with the PDF embedded, and deletes it",
  { tag: "@smoke" },
  async ({ page, adminUser }) => {
    await page.goto("/dashboard/scan");
    await expect(page.getByRole("heading", { name: "Post erfassen" })).toBeVisible();

    const buffer = await createTestPdfBuffer();
    await page.setInputFiles('input[type="file"]', { name: "testdokument.pdf", mimeType: "application/pdf", buffer });
    // Waits for the file selection to reach the form's own React state before submitting -
    // see tests/e2e/billing.spec.ts's equivalent wait for the full explanation (P6 review
    // finding E2's real root cause: `setInputFiles` does not wait for the app's own re-render).
    await expect(page.getByText("testdokument.pdf")).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "Hochladen" }).click();

    await expect.poll(() => new URL(page.url()).pathname, { timeout: 20_000 }).toMatch(/^\/dashboard\/documents\/.+/);

    // The PDF embed (same-origin iframe streaming GET /api/documents/[id]/file) is present.
    const iframe = page.locator('iframe[src*="/api/documents/"]');
    await expect(iframe).toBeVisible();

    // The document shows up in the inbox under its own workspace. An unprocessed upload has
    // no counterparty and no date yet, so its generated row name falls back to the file name
    // without its extension (decisions/0059-generated-document-names.md).
    await page.goto("/dashboard");
    await expect(page.getByText("testdokument", { exact: false }).first()).toBeVisible();

    // Delete it from the detail page.
    await page.getByText("testdokument", { exact: false }).first().click();
    await page.getByRole("button", { name: "Löschen" }).click();
    await page.getByRole("button", { name: "Ja, löschen" }).click();

    await expect.poll(() => new URL(page.url()).pathname).toBe("/dashboard");
    await expect(page.getByText("testdokument", { exact: false })).toHaveCount(0);

    // `adminUser`'s workspace name is also visible, proving we stayed in our own workspace.
    await expect(page.getByText(adminUser.workspace.name).first()).toBeVisible();
  },
);
