// Payment matching, end to end (F3b, decisions/0025-payment-matching-wiring.md): an admin
// uploads a Telekom invoice (the fake AI provider's own template,
// `src/modules/documents/core/fake-ocr-engine.ts`, incoming, 49.99 EUR) and then a camt.053
// statement carrying a matching debit booked to the same counterparty name - the name-match
// signal (no invoice number needed here, `src/modules/payments/core/text-signals.ts`'s
// digit-only floor would reject the fake fixture's own 4-digit "Rechnungsnummer 4711" anyway)
// produces a suggestion under "Zuordnung"; the admin confirms it there and sees "Bezahlt" on
// the invoice. A plain member sees the same status chip on the document but never an amount
// or a counterparty (`finance.read` is admin-only, decisions/0024-accounts-and-transactions.md).
import { expect, test } from "./helpers/fixtures";
import { createTestUser, loginAs } from "./helpers/auth";
import { databaseNow, waitForPaymentMatching } from "./helpers/jobs";
import { addMemberToWorkspace, setPaymentAutoConfirm } from "./helpers/workspace";
import { deleteUserById, uniqueEmail } from "./helpers/db";
import { createTestPdfBuffer } from "./helpers/pdf-fixture";

const CAMT_053_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02">
  <BkToCstmrStmt>
    <Stmt>
      <Id>STMT-PAYMENTS-E2E</Id>
      <Acct><Id><IBAN>DE89370400440532019000</IBAN></Id><Ccy>EUR</Ccy></Acct>
      <Bal><Tp><CdOrPrtry><Cd>OPBD</Cd></CdOrPrtry></Tp><Amt Ccy="EUR">500.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>2026-04-01</Dt></Dt></Bal>
      <Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp><Amt Ccy="EUR">450.01</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>2026-04-30</Dt></Dt></Bal>
      <Ntry>
        <Amt Ccy="EUR">49.99</Amt>
        <CdtDbtInd>DBIT</CdtDbtInd>
        <BookgDt><Dt>2026-04-15</Dt></BookgDt>
        <NtryDtls><TxDtls>
          <RltdPties><Cdtr><Nm>Telekom Deutschland GmbH</Nm></Cdtr></RltdPties>
          <RmtInf><Ustrd>Telefonrechnung</Ustrd></RmtInf>
        </TxDtls></NtryDtls>
      </Ntry>
    </Stmt>
  </BkToCstmrStmt>
</Document>`;

function xmlBuffer(): Buffer {
  return Buffer.from(CAMT_053_XML, "utf-8");
}

test(
  "admin uploads a Telekom invoice and a matching camt.053 statement, confirms the suggestion under Zuordnung, and sees Bezahlt",
  { tag: "@smoke" },
  async ({ page, browser, baseURL, adminUser }) => {

    // The default auto-confirm mode ("system", decisions/0044) would book this deterministic
    // name-and-amount match by itself; "none" leaves it as a suggestion to confirm by hand.
    await setPaymentAutoConfirm(adminUser.workspace.id, "none");

    // 1. The invoice (incoming, 49.99 EUR, sender "Telekom Deutschland GmbH").
    await page.goto("/dashboard/scan");
    const pdfBytes = await createTestPdfBuffer();
    await page.setInputFiles('input[type="file"]', { name: "rechnung-telekom.pdf", mimeType: "application/pdf", buffer: pdfBytes });
    await expect(page.getByText("rechnung-telekom.pdf")).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "Hochladen" }).click();
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 20_000 }).toMatch(/^\/dashboard\/documents\/.+/);
    await expect(page.getByText("Verarbeitet", { exact: true })).toBeVisible({ timeout: 20_000 });
    const invoiceUrl = page.url();

    // 2. The camt.053 statement: `documents-use-cases.ts`'s camt053 branch enqueues
    // `import-account-transactions`, which queues `match-payments` due immediately
    // (decisions/0076); the upload route's own `after()` runner runs all three jobs, so the spec
    // only waits for that run, it never triggers one itself.
    const statementUploadedAfter = await databaseNow();
    await page.goto("/dashboard/scan");
    await page.setInputFiles('input[type="file"]', { name: "kontoauszug.xml", mimeType: "application/xml", buffer: xmlBuffer() });
    await expect(page.getByText("kontoauszug.xml")).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "Hochladen" }).click();
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 20_000 }).toMatch(/^\/dashboard\/documents\/.+/);
    await expect(page.getByText("Importierte Daten")).toBeVisible({ timeout: 20_000 });
    await waitForPaymentMatching(adminUser.workspace.id, statementUploadedAfter);

    // 3. "Zuordnung" shows the unmatched transaction with its suggestion - confirm it there.
    await page.goto("/dashboard/finance/zuordnung");
    await expect(page.getByRole("heading", { name: "Zuordnung" })).toBeVisible();
    await expect(page.getByText("Telekom Deutschland GmbH").first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("49,99").first()).toBeVisible();
    await page.getByRole("button", { name: "Bestätigen" }).click();
    await expect(page.getByText("Keine offenen Transaktionen.")).toBeVisible({ timeout: 10_000 });

    // 4. The invoice itself now shows "Bezahlt".
    await page.goto(invoiceUrl);
    await expect(page.getByTestId("payment-section").getByText("Bezahlt", { exact: true })).toBeVisible();

    // 5. A plain member sees the same status, but never the matched transaction's amount or
    // counterparty (`finance.read` is admin-only) - the payment section's own scope, not the
    // page as a whole, since the invoice's OWN extracted amount/sender are ordinary document
    // fields every member already sees regardless of finance permissions.
    const memberEmail = uniqueEmail("payments-member");
    const memberContext = await browser.newContext();
    try {
      const memberPage = await memberContext.newPage();
      const memberUser = await createTestUser("payments-member", memberEmail);
      await addMemberToWorkspace(adminUser.workspace.id, memberUser.id);
      await loginAs(memberContext, memberUser, baseURL!);

      await memberPage.goto(invoiceUrl);
      const section = memberPage.getByTestId("payment-section");
      await expect(section.getByText("Bezahlt", { exact: true })).toBeVisible();
      await expect(section.getByText("49,99")).toHaveCount(0);
      await expect(section.getByText("Telekom Deutschland GmbH")).toHaveCount(0);

      await deleteUserById(memberUser.id);
    } finally {
      await memberContext.close();
    }
  },
);
