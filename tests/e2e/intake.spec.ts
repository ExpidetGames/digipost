// Universal intake, end to end (decisions/0020-universal-intake.md, F1b): upload a CSV bank
// export the fake classifier recognizes (`src/modules/intake/core/fake-intake-classifier.ts`'s
// "musterbank-bank-statement" rule), see "Bestätigung nötig", confirm the proposed mapping, see the
// document's kind become "Kontoauszug", then upload the identical file again and see the
// duplicate-document message. The Docker test stack never sets `MISTRAL_API_KEY`
// (`docker/compose.test.yml` sets `AI_PROVIDER: fake` explicitly), so this exercises the
// deterministic fake classifier, never a real Mistral call.
import { expect, test } from "./helpers/fixtures";

const MUSTERBANK_CSV = [
  "Buchungsdatum;Wertstellung;Betrag;Währung;Empfänger/Auftraggeber;IBAN;Verwendungszweck",
  "15.01.2026;15.01.2026;100,00;EUR;Kunde AG;DE89370400440532013000;Rechnung 1",
  "16.01.2026;16.01.2026;-50,00;EUR;Lieferant GmbH;DE12500105170648489890;Bestellung 2",
].join("\n");

function csvBuffer(): Buffer {
  return Buffer.from(MUSTERBANK_CSV, "utf-8");
}

test(
  "uploads a CSV bank export, confirms the proposed mapping, and rejects a repeat upload as a duplicate",
  { tag: "@smoke" },
  async ({ page, adminUser }) => {
    // `adminUser` establishes the signed-in session and workspace (via the fixture's own
    // `use()`); this spec does not need its fields directly.
    void adminUser;
    await page.goto("/dashboard/scan");
    await page.setInputFiles('input[type="file"]', { name: "kontoauszug.csv", mimeType: "text/csv", buffer: csvBuffer() });
    await expect(page.getByText("kontoauszug.csv")).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "Hochladen" }).click();

    await expect.poll(() => new URL(page.url()).pathname, { timeout: 20_000 }).toMatch(/^\/dashboard\/documents\/.+/);

    // Processing runs asynchronously (the upload route's own `after()`, backed up by the
    // detail page's polling "kick") - the confirmation panel (a level-2 heading, scoped to
    // avoid the title bar's own "Bestätigung nötig" badge carrying the identical text) shows
    // up once it lands on `pending_confirmation`.
    const confirmationHeading = page.getByRole("heading", { name: "Bestätigung nötig", level: 2 });
    await expect(confirmationHeading).toBeVisible({ timeout: 20_000 });

    await page.getByRole("button", { name: "Bestätigen und importieren" }).click();

    // Confirmed: the panel disappears, the imported-rows summary and the "Kontoauszug" kind
    // badge (F1b's own taxonomy, decisions/0022-intake-wiring.md) both show up.
    await expect(confirmationHeading).toHaveCount(0);
    await expect(page.getByText("Importierte Daten")).toBeVisible();
    await expect(page.getByText("Kontoauszug", { exact: true })).toBeVisible();

    // Uploading the exact same file again is rejected as an exact duplicate
    // (decisions/0020-universal-intake.md's `fileHash` check) - "Dieses Dokument ist bereits
    // vorhanden", never silently re-imported or re-classified.
    await page.goto("/dashboard/scan");
    await page.setInputFiles('input[type="file"]', { name: "kontoauszug.csv", mimeType: "text/csv", buffer: csvBuffer() });
    await expect(page.getByText("kontoauszug.csv")).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "Hochladen" }).click();

    await expect(page.getByText("Dieses Dokument ist bereits vorhanden.")).toBeVisible({ timeout: 20_000 });
  },
);
