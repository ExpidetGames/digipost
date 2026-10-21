// Platform settlements, end to end (F4, decisions/0026-platform-settlements.md): an admin
// uploads the Stripe payout report fixture, confirms it (the fake `IntakeClassifier` already
// recognizes its header and proposes `documentKind: "payout_report"`, `platform: "stripe"`),
// sees the report's own decomposition on the document detail page, and finds the platform's
// clearing account under "Finanzen". A member never sees any of it - the finance area stays
// admin-only end to end, exactly like F2's own accounts (`tests/e2e/finance.spec.ts`).
import { readFileSync } from "node:fs";
import path from "node:path";

import { expect, test } from "./helpers/fixtures";
import { createTestUser, loginAs } from "./helpers/auth";
import { addMemberToWorkspace } from "./helpers/workspace";
import { deleteUserById, uniqueEmail } from "./helpers/db";

function stripePayoutCsvBuffer(): Buffer {
  return readFileSync(path.join(process.cwd(), "src/modules/intake/tests/fixtures/stripe-payout.csv"));
}

test(
  "admin uploads the Stripe payout report, confirms it, and sees the clearing account and decomposition",
  { tag: "@smoke" },
  async ({ page, adminUser }) => {
    void adminUser;
    await page.goto("/dashboard/scan");
    await page.setInputFiles('input[type="file"]', { name: "stripe-payout.csv", mimeType: "text/csv", buffer: stripePayoutCsvBuffer() });
    await expect(page.getByText("stripe-payout.csv")).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "Hochladen" }).click();
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 20_000 }).toMatch(/^\/dashboard\/documents\/.+/);

    // The fake classifier's own "stripe-payout" header-signature rule already proposes
    // `payout_report`/`stripe` - the confirmation panel's kind/platform selects default to
    // that, no manual selection needed.
    const confirmationHeading = page.getByRole("heading", { name: "Bestätigung nötig", level: 2 });
    await expect(confirmationHeading).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "Bestätigen und importieren" }).click();
    await expect(confirmationHeading).toHaveCount(0);

    // Confirmed: kind + platform badges.
    await expect(page.getByText("Auszahlungsbericht", { exact: true })).toBeVisible();
    await expect(page.getByText("Stripe", { exact: true })).toBeVisible();

    // The settlement report's own decomposition (revenue/fee/refund/payout, F4's own
    // `SettlementReportSection`) appears once the `import-account-transactions`/
    // `match-settlement-lines` jobs (kicked right after confirm, `after()`-scheduled so they
    // run slightly after the confirm click resolves) have actually run - reload until the
    // RSC payload reflects it, the same "poll via reload" pattern this suite uses wherever a
    // background job's effect is not covered by `ProcessingPoller`'s own active polling.
    await expect(async () => {
      await page.reload();
      await expect(page.getByText("Abrechnung", { exact: true })).toBeVisible();
    }).toPass({ timeout: 20_000 });
    await expect(page.getByText("Rechnung fehlt").first()).toBeVisible();

    await page.goto("/dashboard/finance");
    await expect(page.getByRole("heading", { name: "Finanzen" })).toBeVisible();
    // Two elements contain this text (the account's own name, "Stripe (Verrechnungskonto)",
    // and the separate type badge next to it) - `exact: true` matches only the badge.
    await expect(page.getByText("Verrechnungskonto", { exact: true })).toBeVisible();
  },
);

test("a member never sees the Stripe clearing account or any Finanzen content", async ({ browser, baseURL, adminUser }) => {
  const memberEmail = uniqueEmail("settlement-member");
  const memberContext = await browser.newContext();
  try {
    const memberPage = await memberContext.newPage();
    const memberUser = await createTestUser("settlement-member", memberEmail);
    await addMemberToWorkspace(adminUser.workspace.id, memberUser.id);
    await loginAs(memberContext, memberUser, baseURL!);

    await memberPage.goto("/dashboard");
    await expect(memberPage.getByRole("group", { name: "Finanzen" })).toHaveCount(0);
    await expect(memberPage.getByRole("link", { name: "Konten" })).toHaveCount(0);

    await memberPage.goto("/dashboard/finance");
    await expect(memberPage.getByText("This page could not be found.")).toBeVisible();
    await expect(memberPage.getByRole("heading", { name: "Finanzen" })).toHaveCount(0);

    await deleteUserById(memberUser.id);
  } finally {
    await memberContext.close();
  }
});
