// Processing pipeline, end to end (decisions/0016-processing-pipeline-and-ai.md): upload a
// document whose file name matches the fake AI provider's Telekom-invoice template, see it
// reach "Verarbeitet" with an auto-detected title and sender, and find it again by full-text
// search over the OCR text. The Docker test stack never sets `MISTRAL_API_KEY`
// (docker/compose.test.yml sets `AI_PROVIDER: fake` explicitly), so every assertion below is
// against the deterministic fake OCR/analyzer, never a real Mistral call.
//
// This spec used to also prove that a routing rule auto-assigned the upload to a team member
// and emailed them. Categories, assignment and routing were removed from the product
// (decisions/0063-no-category-no-assignment-no-routing.md), so those assertions are gone with
// the feature rather than adapted.
import { expect, test } from "./helpers/fixtures";
import { createTestPdfBuffer } from "./helpers/pdf-fixture";

test(
  "uploads a Telekom invoice, it processes with the fake AI provider, and is found by search",
  { tag: "@smoke" },
  async ({ page }) => {
    // Upload a document whose file name the fake OCR engine recognizes as a Telekom
    // invoice (`src/modules/documents/core/fake-ocr-engine.ts`).
    await page.goto("/dashboard/scan");
    const buffer = await createTestPdfBuffer();
    await page.setInputFiles('input[type="file"]', { name: "rechnung-telekom.pdf", mimeType: "application/pdf", buffer });
    // Waits for the file selection to reach the form's own React state before submitting -
    // see tests/e2e/billing.spec.ts's equivalent wait for the full explanation (P6 review
    // finding E2's real root cause: `setInputFiles` does not wait for the app's own re-render).
    await expect(page.getByText("rechnung-telekom.pdf")).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "Hochladen" }).click();

    await expect.poll(() => new URL(page.url()).pathname, { timeout: 20_000 }).toMatch(/^\/dashboard\/documents\/.+/);

    // Processing runs asynchronously (the upload route's own `after()`, backed up by the
    // detail page's polling "kick") - wait for it to reach "Verarbeitet" with an
    // auto-detected title and sender. The intermediate "processing" state is not asserted:
    // with the near-instant fake AI provider, whether the browser ever observes it before
    // "done" is a race, not a guarantee.
    await expect(page.getByText("Verarbeitet", { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("Telekom Deutschland GmbH").first()).toBeVisible();

    // Full-text search (websearch_to_tsquery('german', ...) over the generated search_vector,
    // decisions/0015-documents-and-quotas.md) finds it by OCR text content. The inbox row is
    // named after the counterparty with its legal form stripped
    // (decisions/0059-generated-document-names.md), so the row reads "Telekom Deutschland"
    // rather than the full company name the detail page shows.
    await page.goto("/dashboard");
    await page.getByLabel("Suche").fill("Telekom");
    await page.getByRole("button", { name: "Filtern" }).click();
    await expect(page.getByRole("link").filter({ hasText: "Telekom Deutschland" })).toBeVisible();
  },
);
