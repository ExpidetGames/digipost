// Contacts, end to end (decisions/0019-contacts.md, C3): manual create (always verified),
// an unverified contact's badge and "Bestätigen" flow, a pending IBAN proposal's warning
// callout and reject flow, and a merge moving a linked document's count from the source to
// the target contact. Uses the `adminUser` fixture (a fast session with a real workspace,
// `tests/e2e/helpers/fixtures.ts`); test contacts/documents/proposals are seeded directly
// against the test DB (`tests/e2e/helpers/contacts.ts`), the same shortcut
// `tests/e2e/helpers/workspace.ts` already establishes for workspaces, since driving the
// OCR/extraction pipeline just to get a contact into a particular state is out of scope here.
import { expect, test } from "./helpers/fixtures";
import { createTestContact, createTestDocument, createTestProposal, linkTestDocumentContact } from "./helpers/contacts";

test(
  "creates a contact manually and sees it verified",
  { tag: "@smoke" },
  async ({ page, adminUser }) => {
    await page.goto("/dashboard/contacts");
    await expect(page.getByRole("heading", { name: "Kontakte" })).toBeVisible();

    await page.getByRole("button", { name: "Kontakt anlegen" }).click();
    await page.getByLabel("Name").fill("Neue Firma GmbH");
    await page.getByRole("button", { name: "Kontakt anlegen" }).click();

    await expect.poll(() => new URL(page.url()).pathname, { timeout: 10_000 }).toMatch(/^\/dashboard\/contacts\/.+/);
    await expect(page.getByRole("heading", { name: "Neue Firma GmbH" })).toBeVisible();
    // A manual save always counts as verification (decisions/0019-contacts.md) - no
    // "Unbestätigt" badge, and a "Bestätigt am ..." line instead of "Bestätigen".
    await expect(page.getByText("Unbestätigt")).toHaveCount(0);
    await expect(page.getByText(/^Bestätigt am/)).toBeVisible();

    // Shows up in the workspace's own contact list.
    await page.goto("/dashboard/contacts");
    await expect(page.getByText("Neue Firma GmbH")).toBeVisible();
    await expect(page.getByText(adminUser.workspace.name).first()).toBeVisible();
  },
);

test("an unverified contact shows the badge and can be confirmed", async ({ page, adminUser }) => {
  // Named to avoid colliding with the "Unbestätigt" badge text itself (Playwright's
  // `getByText` matches substrings by default) - a fixture name containing that word as a
  // prefix used to make `getByText("Unbestätigt")` match the page heading too.
  const contact = await createTestContact(adminUser.workspace.id, { name: "Musterlieferant AG", verifiedAt: null });

  await page.goto(`/dashboard/contacts/${contact.id}`);
  await expect(page.getByText("Unbestätigt")).toBeVisible();
  await expect(page.getByText("Noch nicht bestätigt.")).toBeVisible();

  await page.getByRole("button", { name: "Bestätigen" }).click();

  await expect(page.getByText("Unbestätigt")).toHaveCount(0);
  await expect(page.getByText(/^Bestätigt am/)).toBeVisible();
});

test("a pending IBAN proposal shows the fraud warning and can be rejected", async ({ page, adminUser }) => {
  const contact = await createTestContact(adminUser.workspace.id, {
    name: "Lieferant mit neuer IBAN",
    iban: "DE02120300000000202051",
  });
  await createTestProposal(adminUser.workspace.id, contact.id, {
    field: "iban",
    currentValue: "DE02120300000000202051",
    proposedValue: "DE89370400440532013000",
  });

  await page.goto(`/dashboard/contacts/${contact.id}`);
  const warning = page.getByRole("alert").filter({ hasText: "Bankverbindung" });
  await expect(warning).toBeVisible();
  // Scoped to the proposal callout itself: the same IBAN string also appears in the
  // contact's own field list (its current, still-unchanged value), so an unscoped
  // `page.getByText(...)` would match twice.
  const proposalItem = page.locator("li").filter({ has: warning });
  await expect(proposalItem.getByText("DE02120300000000202051")).toBeVisible();
  await expect(proposalItem.getByText("DE89370400440532013000")).toBeVisible();

  await page.getByRole("button", { name: "Ablehnen" }).click();

  await expect(warning).toHaveCount(0);
});

test("merging two contacts moves the linked document's count to the target", async ({ page, adminUser }) => {
  const target = await createTestContact(adminUser.workspace.id, { name: "Zielkontakt GmbH" });
  const source = await createTestContact(adminUser.workspace.id, { name: "Quellkontakt GmbH" });
  const document = await createTestDocument(adminUser.workspace.id, "quellrechnung.pdf");
  await linkTestDocumentContact(document.id, source.id, "sender");

  await page.goto("/dashboard/contacts");
  await expect(page.getByText("Keine Dokumente").first()).toBeVisible();

  await page.goto(`/dashboard/contacts/${source.id}`);
  await page.getByRole("button", { name: "Zusammenführen" }).click();
  await page.getByPlaceholder("Kontakt suchen…").fill("Zielkontakt");
  await page.getByText("Zielkontakt GmbH", { exact: true }).click();
  await page.getByRole("button", { name: "Ja, zusammenführen" }).click();

  await expect.poll(() => new URL(page.url()).pathname, { timeout: 10_000 }).toBe(`/dashboard/contacts/${target.id}`);
  await expect(page.getByRole("heading", { name: "Zielkontakt GmbH" })).toBeVisible();
  await expect(page.getByText("quellrechnung.pdf")).toBeVisible();

  await page.goto("/dashboard/contacts");
  await expect(page.getByText("Quellkontakt GmbH")).toHaveCount(0);
  await expect(page.getByText("1 Dokument")).toBeVisible();
});
