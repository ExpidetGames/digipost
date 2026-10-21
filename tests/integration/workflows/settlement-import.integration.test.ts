// Owner-crossing integration test (WEBAPP_TEMPLATE_SPEC.md §10.1) for F4's platform
// settlements (decisions/0026-platform-settlements.md, building on F1a/F1b's universal intake,
// F2's accounts import, and F3a/F3b's payment matching): real Postgres + real MinIO, the real
// upload route, the real job runner, the fake AI provider (the fake `IntakeClassifier` already
// recognizes the Stripe fixture's own header signature). Covers: importing the Stripe payout
// report creates its clearing account and settlement lines/transactions, twice is idempotent;
// an outgoing invoice is matched to its revenue line by invoice number found in the report's
// own metadata; an incoming platform fee invoice settles once its period's fee lines are
// known; a platform payout pairs with its matching bank deposit, including when the bank line
// is imported LATER (F2's import hook calling back into F4's own pairing).
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

let currentUser: { id: string; email: string } | null = null;
vi.mock("@/platform/auth/server", () => ({
  getCurrentUser: async () => currentUser,
}));

vi.mock("next/cache", () => ({
  revalidatePath: () => {},
}));

import { getDb } from "@/persistence/foundation/client";
import { getRequestServices } from "@/persistence/composition/request-services";
import { createDrizzleDocumentRepository } from "@/persistence/repositories/drizzle/documents-repository";
import { createDrizzleWorkspaceMemberRepository, createDrizzleWorkspaceRepository } from "@/persistence/repositories/drizzle/workspaces-repository";
import type { CreateDocumentRow, DocumentDirection, MarkDocumentDoneInput } from "@/persistence/repositories/contracts";
import { user } from "@/persistence/schema/auth";
import { runDueJobs } from "@/platform/jobs/server";

import { POST } from "@/app/api/documents/route";

const FIXTURES_DIR = path.join(process.cwd(), "src/modules/intake/tests/fixtures");

function fixtureBytes(name: string): Buffer {
  return readFileSync(path.join(FIXTURES_DIR, name));
}

async function createTestUser(label: string): Promise<{ id: string; email: string }> {
  const email = `${label}-${randomUUID()}@example.test`;
  const [row] = await getDb().insert(user).values({ name: "Settlement Test User", email, emailVerified: false }).returning({ id: user.id });
  if (!row) throw new Error("failed to insert test user fixture");
  return { id: row.id, email };
}

async function createWorkspaceForUser(userId: string, name: string) {
  const workspaceRepo = createDrizzleWorkspaceRepository(getDb());
  const memberRepo = createDrizzleWorkspaceMemberRepository(getDb());
  const workspace = await workspaceRepo.create({ name });
  await memberRepo.create({ workspaceId: workspace.id, userId, role: "admin" });
  return workspace;
}

function postRequest(formData: FormData): Request {
  return new Request("http://localhost/api/documents", { method: "POST", body: formData });
}

function uploadForm(bytes: Buffer, fileName: string, mimeType: string): FormData {
  const formData = new FormData();
  formData.append("files", new File([new Uint8Array(bytes)], fileName, { type: mimeType }));
  return formData;
}

/** Uploads and confirms the Stripe payout CSV fixture as a `payout_report` - the fake
 * `IntakeClassifier` already recognizes its header (`documentKind: "payout_report", platform:
 * "stripe"`, `src/modules/intake/core/fake-intake-classifier.ts`), so this only has to drive
 * the same "pending_confirmation -> confirm" flow a human would through the UI. */
async function importStripePayoutReport(workspaceId: string, actingUserId: string): Promise<string> {
  const csv = fixtureBytes("stripe-payout.csv");
  const uploadResponse = await POST(postRequest(uploadForm(csv, "stripe-payout.csv", "text/csv")), {} as never);
  expect(uploadResponse.status).toBe(201);
  const { documentId } = (await uploadResponse.json()) as { documentId: string };

  await runDueJobs({ workspaceId, limit: 20 });

  const pending = await getRequestServices().documents.getById(workspaceId, documentId);
  expect(pending?.intakeStatus).toBe("pending_confirmation");
  const proposal = pending?.intakeResult;
  if (proposal?.type !== "tabular_proposal") throw new Error("expected a tabular_proposal intake result");
  expect(proposal.documentKind).toBe("payout_report");
  expect(proposal.platform).toBe("stripe");

  await getRequestServices().documents.confirmIntake({
    workspaceId,
    documentId,
    actingUserId,
    documentKind: "payout_report",
    platform: "stripe",
    mapping: proposal.columnMapping,
    amountSign: proposal.amountSign,
  });

  await runDueJobs({ workspaceId, limit: 20 });
  return documentId;
}

/** Creates an invoice-shaped document directly (bypassing OCR - this test is about
 * settlement/payment matching, not extraction). Mirrors
 * `tests/integration/workflows/payments-matching.integration.test.ts`'s own helper. */
async function createInvoiceDocument(
  workspaceId: string,
  input: { direction: DocumentDirection; invoiceNumber: string | null; totalAmountCents: number; documentDate?: string | null },
) {
  const documentRepo = createDrizzleDocumentRepository(getDb());
  const created = await documentRepo.create({
    id: randomUUID(),
    workspaceId,
    uploadedByUserId: null,
    originalFileName: `rechnung-${input.invoiceNumber ?? randomUUID()}.pdf`,
    mimeType: "application/pdf",
    pageCount: 1,
    sizeBytes: 10,
    storageKey: `workspaces/${workspaceId}/documents/${randomUUID()}/original.pdf`,
    fileHash: randomUUID(),
  } satisfies CreateDocumentRow);

  await documentRepo.markDone(workspaceId, created.id, {
    ocrText: "Testrechnung",
    ocrBlocks: null,
    title: null,
    sender: null,
    documentDate: input.documentDate ?? null,
    summary: null,
    searchablePdfKey: `workspaces/${workspaceId}/documents/${created.id}/searchable.pdf`,
    direction: input.direction,
    invoiceNumber: input.invoiceNumber,
    totalAmountCents: input.totalAmountCents,
    currency: "EUR",
    dueDate: null,
    paymentIban: null,
    paymentReference: null,
    paidNote: null,
    kind: input.direction === "outgoing" ? "outgoing_invoice" : "incoming_invoice",
    paymentStatus: "open",
  } satisfies MarkDocumentDoneInput);

  return created.id;
}

function minimalCamt053(entry: { amount: string; creditDebit: "CRDT" | "DBIT"; bookingDate: string; remittanceText: string }): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02">
  <BkToCstmrStmt>
    <GrpHdr><MsgId>MSG-SETTLEMENT-PAIRING</MsgId><CreDtTm>2026-09-01T06:00:00</CreDtTm></GrpHdr>
    <Stmt>
      <Id>STMT-SETTLEMENT-PAIRING</Id>
      <CreDtTm>2026-09-01T06:00:00</CreDtTm>
      <Acct><Id><IBAN>DE02120300000000202088</IBAN></Id><Ccy>EUR</Ccy></Acct>
      <Bal><Tp><CdOrPrtry><Cd>OPBD</Cd></CdOrPrtry></Tp><Amt Ccy="EUR">0.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>2026-08-01</Dt></Dt></Bal>
      <Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp><Amt Ccy="EUR">${entry.amount}</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>2026-08-31</Dt></Dt></Bal>
      <Ntry>
        <Amt Ccy="EUR">${entry.amount}</Amt>
        <CdtDbtInd>${entry.creditDebit}</CdtDbtInd>
        <BookgDt><Dt>${entry.bookingDate}</Dt></BookgDt>
        <NtryDtls><TxDtls>
          <RltdPties><Dbtr><Nm>Stripe Payments Europe Ltd</Nm></Dbtr></RltdPties>
          <RmtInf><Ustrd>${entry.remittanceText}</Ustrd></RmtInf>
        </TxDtls></NtryDtls>
      </Ntry>
    </Stmt>
  </BkToCstmrStmt>
</Document>`;
}

describe("platform settlements (F4, real Postgres + MinIO, fake AI)", () => {
  it("imports the Stripe payout report into its own clearing account, idempotently", async () => {
    const founder = await createTestUser("settlement-import");
    currentUser = founder;
    const workspace = await createWorkspaceForUser(founder.id, "Settlement Import GmbH");

    const documentId = await importStripePayoutReport(workspace.id, founder.id);

    const accounts = await getRequestServices().accounts.listAccounts(workspace.id);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ type: "clearing", platform: "stripe" });

    const transactions = await getRequestServices().accounts.listTransactions(workspace.id, accounts[0]!.id, { page: 1, pageSize: 50 });
    // 4 revenue + 1 refund + 4 fee + 2 synthesized payout lines = 11 ledger transactions.
    expect(transactions.items).toHaveLength(11);

    // Re-running the import directly is idempotent: zero new lines/transactions.
    const rerun = await getRequestServices().accounts.importFromDocument({ workspaceId: workspace.id, documentId });
    expect(rerun).toMatchObject({ status: "settlement_imported", accountId: accounts[0]!.id, linesImported: 0, linesDuplicate: 11 });
  });

  it("matches an outgoing invoice to its revenue line by the invoice number found in the report's own metadata", async () => {
    const founder = await createTestUser("settlement-revenue-match");
    currentUser = founder;
    const workspace = await createWorkspaceForUser(founder.id, "Settlement Revenue GmbH");

    // Row 1 of the Stripe fixture: gross 99.00 EUR, payment_metadata[invoice_number] = RE-2026-1001.
    const invoiceId = await createInvoiceDocument(workspace.id, { direction: "outgoing", invoiceNumber: "RE-2026-1001", totalAmountCents: 9_900 });

    await importStripePayoutReport(workspace.id, founder.id);

    const section = await getRequestServices().payments.getDocumentPaymentSection(workspace.id, invoiceId);
    expect(section?.paymentStatus).toBe("paid");
    expect(section?.matchedTransactions).toHaveLength(1);
    expect(section?.matchedTransactions[0]).toMatchObject({ status: "confirmed", kind: "exact", matchedBy: "auto", allocatedAmountCents: 9_900 });
  });

  it("settles a platform fee invoice once its period's fee lines are known", async () => {
    const founder = await createTestUser("settlement-fee-invoice");
    currentUser = founder;
    const workspace = await createWorkspaceForUser(founder.id, "Settlement Fee GmbH");

    await importStripePayoutReport(workspace.id, founder.id);

    // Sum of every fee line in the fixture: 317 + 172 + 598 + 115 = 1202 cents.
    const feeInvoiceId = await createInvoiceDocument(workspace.id, {
      direction: "incoming",
      invoiceNumber: "STRIPE-FEE-2026-08",
      totalAmountCents: 1_202,
      documentDate: "2026-08-31",
    });

    const contact = await getRequestServices().contacts.createManual({
      workspaceId: workspace.id,
      name: "Stripe Payments Europe, Ltd.",
      actingUserId: founder.id,
    });
    await getRequestServices().contacts.linkDocument({ workspaceId: workspace.id, documentId: feeInvoiceId, contactId: contact.id, role: "sender" });

    await getRequestServices().payments.runMatching({ workspaceId: workspace.id, trigger: "document_done" });

    const section = await getRequestServices().payments.getDocumentPaymentSection(workspace.id, feeInvoiceId);
    expect(section?.paymentStatus).toBe("settled");
  });

  it("pairs a platform payout with its matching bank deposit, including when the bank line is imported later", async () => {
    const founder = await createTestUser("settlement-payout-pairing");
    currentUser = founder;
    const workspace = await createWorkspaceForUser(founder.id, "Settlement Pairing GmbH");

    await importStripePayoutReport(workspace.id, founder.id);

    const accountsBefore = await getRequestServices().accounts.listAccounts(workspace.id);
    const clearingAccount = accountsBefore.find((a) => a.type === "clearing")!;
    const clearingTxBefore = await getRequestServices().accounts.listTransactions(workspace.id, clearingAccount.id, { page: 1, pageSize: 50 });
    // Payout 1: rows 1+2, net 95.83 + 47.28 = 143.11 EUR -> a debit of -14311 cents.
    const payoutTxBefore = clearingTxBefore.items.find((tx) => tx.amountCents === -14_311);
    expect(payoutTxBefore).toBeDefined();
    expect(payoutTxBefore!.transferGroupId).toBeNull();

    // The bank deposit arrives LATER, as its own separate import - F2's import hook must call
    // back into F4's own pairing (decisions/0026).
    const bankXml = minimalCamt053({ amount: "143.11", creditDebit: "CRDT", bookingDate: "2026-08-02", remittanceText: "Auszahlung po_1AbCdEfGhPayout01" });
    const bankUpload = await POST(postRequest(uploadForm(Buffer.from(bankXml, "utf8"), "bankauszug.xml", "application/xml")), {} as never);
    expect(bankUpload.status).toBe(201);
    await runDueJobs({ workspaceId: workspace.id, limit: 20 });

    const accountsAfter = await getRequestServices().accounts.listAccounts(workspace.id);
    const bankAccount = accountsAfter.find((a) => a.type === "bank")!;
    expect(bankAccount).toBeDefined();

    const clearingTxAfter = await getRequestServices().accounts.listTransactions(workspace.id, clearingAccount.id, { page: 1, pageSize: 50 });
    const payoutTxAfter = clearingTxAfter.items.find((tx) => tx.amountCents === -14_311)!;
    expect(payoutTxAfter.transferGroupId).not.toBeNull();

    const bankTx = (await getRequestServices().accounts.listTransactions(workspace.id, bankAccount.id, { page: 1, pageSize: 50 })).items[0]!;
    expect(bankTx.transferGroupId).toBe(payoutTxAfter.transferGroupId);
  });
});
