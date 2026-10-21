// Accounts and transactions, end to end (F2, decisions/0024-accounts-and-transactions.md): an
// admin uploads a camt.053 bank statement through the real upload flow, the automatic
// pipeline hook imports it, and the account/transactions show up under "Finanzen". A plain
// member never sees the nav entry and is forbidden (404) on the route directly - the finance
// area is admin-only end to end (`finance.read`/`finance.manage`, both admin-only
// permissions), the first deliberate deviation from the PRD's "kein Rechte-Management"
// because a bank statement exposes salaries and other private debits.
import { expect, test } from "./helpers/fixtures";
import { createTestUser, loginAs } from "./helpers/auth";
import { addMemberToWorkspace } from "./helpers/workspace";
import { deleteUserById, uniqueEmail } from "./helpers/db";

const CAMT_053_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02">
  <BkToCstmrStmt>
    <Stmt>
      <Id>STMT-1</Id>
      <Acct><Id><IBAN>DE89370400440532013000</IBAN></Id><Ccy>EUR</Ccy></Acct>
      <Bal><Tp><CdOrPrtry><Cd>OPBD</Cd></CdOrPrtry></Tp><Amt Ccy="EUR">100.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>2026-01-01</Dt></Dt></Bal>
      <Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp><Amt Ccy="EUR">150.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>2026-01-31</Dt></Dt></Bal>
      <Ntry>
        <Amt Ccy="EUR">50.00</Amt>
        <CdtDbtInd>CRDT</CdtDbtInd>
        <BookgDt><Dt>2026-01-15</Dt></BookgDt>
        <NtryDtls><TxDtls>
          <RltdPties><Dbtr><Nm>Kunde AG</Nm></Dbtr></RltdPties>
          <RmtInf><Ustrd>Rechnung 1</Ustrd></RmtInf>
        </TxDtls></NtryDtls>
      </Ntry>
    </Stmt>
  </BkToCstmrStmt>
</Document>`;

function xmlBuffer(): Buffer {
  return Buffer.from(CAMT_053_XML, "utf-8");
}

// decisions/0028-mt940-support.md: the same account/amounts as `CAMT_053_XML` above, so this
// test proves MT940 reaches the identical "Finanzen" result through its own deterministic
// parse path.
const MT940_STATEMENT = [
  ":20:STMT1",
  ":25:DE89370400440532013000",
  ":28C:00001/001",
  ":60F:C260101EUR100,00",
  ":61:2601150115C50,00NTRFREF1",
  ":86:000?00GUTSCHR?20EREF+X1?32Kunde AG",
  ":62F:C260115EUR150,00",
  "-",
].join("\n");

function mt940Buffer(): Buffer {
  return Buffer.from(MT940_STATEMENT, "utf-8");
}

test(
  "admin uploads a camt.053 statement, the account and its transaction show up under Finanzen",
  { tag: "@smoke" },
  async ({ page, adminUser }) => {
    void adminUser;
    await page.goto("/dashboard/scan");
    await page.setInputFiles('input[type="file"]', { name: "kontoauszug.xml", mimeType: "application/xml", buffer: xmlBuffer() });
    await expect(page.getByText("kontoauszug.xml")).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "Hochladen" }).click();
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 20_000 }).toMatch(/^\/dashboard\/documents\/.+/);

    // A camt.053 statement is always confirmed immediately (no confirmation step) - the
    // import-account-transactions job runs right after processing (the same `after()` +
    // detail-page polling "kick" every other processing job uses).
    await expect(page.getByText("Importierte Daten")).toBeVisible({ timeout: 20_000 });

    await page.goto("/dashboard/finance");
    await expect(page.getByRole("heading", { name: "Finanzen" })).toBeVisible();
    const accountLink = page.getByRole("link", { name: /Bankkonto/ });
    await expect(accountLink).toBeVisible();
    // The closing balance (150.00 EUR) is the account's exact latest balance.
    await expect(page.getByText("150,00")).toBeVisible();

    await accountLink.click();
    await expect.poll(() => new URL(page.url()).pathname).toMatch(/^\/dashboard\/finance\/.+/);
    await expect(page.getByText("Kunde AG")).toBeVisible();
    await expect(page.getByText("50,00")).toBeVisible();
  },
);

test(
  "admin uploads an MT940 statement (real Musterbank-style extension), the account and its transaction show up under Finanzen",
  async ({ page, adminUser }) => {
    void adminUser;
    // Uploaded with a `.mt940` extension and a generic/absent declared MIME type - mirrors the
    // real bug report the file-picker fix (decisions/0028-mt940-support.md) addresses: the
    // server sniffs content by bytes, never the extension or declared type.
    await page.goto("/dashboard/scan");
    await page.setInputFiles('input[type="file"]', { name: "umsaetze.mt940", mimeType: "text/plain", buffer: mt940Buffer() });
    await expect(page.getByText("umsaetze.mt940")).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "Hochladen" }).click();
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 20_000 }).toMatch(/^\/dashboard\/documents\/.+/);

    // MT940, like camt.053, is always confirmed immediately (no confirmation step).
    await expect(page.getByText("Importierte Daten")).toBeVisible({ timeout: 20_000 });

    await page.goto("/dashboard/finance");
    await expect(page.getByRole("heading", { name: "Finanzen" })).toBeVisible();
    const accountLink = page.getByRole("link", { name: /Bankkonto/ });
    await expect(accountLink).toBeVisible();
    await expect(page.getByText("150,00")).toBeVisible();

    await accountLink.click();
    await expect.poll(() => new URL(page.url()).pathname).toMatch(/^\/dashboard\/finance\/.+/);
    await expect(page.getByText("Kunde AG")).toBeVisible();
    await expect(page.getByText("50,00")).toBeVisible();
  },
);

test("a member never sees the Finanzen nav entry and is forbidden on the route directly", async ({ browser, baseURL, adminUser }) => {
  const memberEmail = uniqueEmail("finance-member");
  const memberContext = await browser.newContext();
  try {
    const memberPage = await memberContext.newPage();
    const memberUser = await createTestUser("finance-member", memberEmail);
    await addMemberToWorkspace(adminUser.workspace.id, memberUser.id);
    await loginAs(memberContext, memberUser, baseURL!);

    await memberPage.goto("/dashboard");
    // decisions/0055-navigation-by-use-case.md: the whole "Finanzen" section disappears with its
    // heading once every entry in it is filtered out, so neither the group nor its links show.
    await expect(memberPage.getByRole("group", { name: "Finanzen" })).toHaveCount(0);
    await expect(memberPage.getByRole("link", { name: "Konten" })).toHaveCount(0);
    await expect(memberPage.getByRole("link", { name: "Zuordnung" })).toHaveCount(0);

    // `notFound()` renders the App Router's not-found boundary correctly (proven below by
    // its own "404"/"This page could not be found." content and the absence of any Finanzen
    // page content) - the raw HTTP status of this particular response is a separate, known
    // Next.js characteristic (the shared `(app)` layout shell above this page has already
    // started streaming with a 200 by the time the page's own `notFound()` call resolves,
    // so the top-level status cannot retroactively become 404) that this repository's other
    // admin-only page (`/dashboard/settings/intake`) was never
    // e2e-tested for either - asserting on it here would fail for a reason unrelated to
    // this module's own access control, which is what this test is actually about.
    await memberPage.goto("/dashboard/finance");
    await expect(memberPage.getByText("This page could not be found.")).toBeVisible();
    await expect(memberPage.getByRole("heading", { name: "Finanzen" })).toHaveCount(0);

    await deleteUserById(memberUser.id);
  } finally {
    await memberContext.close();
  }
});
