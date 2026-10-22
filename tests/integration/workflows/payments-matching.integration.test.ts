// Owner-crossing integration test (WEBAPP_TEMPLATE_SPEC.md §10.1) for F3b's payment-matching
// wiring (decisions/0025-payment-matching-wiring.md, building on F3a's pure engine,
// decisions/0023-payment-matching.md, and F2's accounts import,
// decisions/0024-accounts-and-transactions.md): real Postgres + real MinIO, the real upload
// route, the real job runner. Imports a real camt.053 fixture whose remittance texts name two
// invoice numbers exactly -> both auto-confirm and their documents become `paid`; a
// transaction with no invoice-number signal but an amount matching two open invoices combined
// -> one `collective` suggestion covering both, never auto-confirmed; rejecting one leg withdraws
// the whole collective (without that invoice the sum no longer adds up, decisions/0045 recomputes
// deterministic suggestions every run) and it is never proposed again; re-running matching a
// further time changes nothing (idempotent).
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
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
import { createDrizzleAccountRepository, createDrizzleTransactionRepository } from "@/persistence/repositories/drizzle/accounts-repository";
import { createDrizzleDocumentRepository } from "@/persistence/repositories/drizzle/documents-repository";
import { createDrizzleWorkspaceMemberRepository, createDrizzleWorkspaceRepository } from "@/persistence/repositories/drizzle/workspaces-repository";
import type { CreateDocumentRow, DocumentDirection, MarkDocumentDoneInput } from "@/persistence/repositories/contracts";
import { user } from "@/persistence/schema/auth";
import { jobs } from "@/persistence/schema/jobs";
import { runDueJobs } from "@/platform/jobs/server";

import { POST } from "@/app/api/documents/route";

// Own minimal camt.053 fixture (not `src/modules/intake/tests/fixtures/camt053-valid.xml`,
// which was hand-built for `@/modules/intake`'s own tests and whose remittance texts only
// name 4-digit invoice numbers - too short to clear `findInvoiceNumbers`'s digit-only floor,
// `src/modules/payments/core/text-signals.ts`'s `MIN_DIGIT_ONLY_TOKEN_LENGTH`, R1). This
// fixture's two invoice references are alphanumeric, exactly the common real-world shape
// (`RE-2026-00042`) that floor was never meant to restrict.
const CAMT_053_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02">
  <BkToCstmrStmt>
    <GrpHdr><MsgId>MSG-PAYMENTS-MATCHING</MsgId><CreDtTm>2026-09-01T06:00:00</CreDtTm></GrpHdr>
    <Stmt>
      <Id>STMT-PAYMENTS-MATCHING</Id>
      <CreDtTm>2026-09-01T06:00:00</CreDtTm>
      <Acct><Id><IBAN>DE02120300000000202099</IBAN></Id><Ccy>EUR</Ccy></Acct>
      <Bal><Tp><CdOrPrtry><Cd>OPBD</Cd></CdOrPrtry></Tp><Amt Ccy="EUR">1000.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>2026-08-01</Dt></Dt></Bal>
      <Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp><Amt Ccy="EUR">1750.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>2026-08-31</Dt></Dt></Bal>
      <Ntry>
        <Amt Ccy="EUR">250.00</Amt>
        <CdtDbtInd>CRDT</CdtDbtInd>
        <BookgDt><Dt>2026-08-02</Dt></BookgDt>
        <NtryDtls><TxDtls>
          <RltdPties><Dbtr><Nm>Kunde A GmbH</Nm></Dbtr></RltdPties>
          <RmtInf><Ustrd>Rechnung RE-2026-00042</Ustrd></RmtInf>
        </TxDtls></NtryDtls>
      </Ntry>
      <Ntry>
        <Amt Ccy="EUR">500.00</Amt>
        <CdtDbtInd>CRDT</CdtDbtInd>
        <BookgDt><Dt>2026-08-10</Dt></BookgDt>
        <NtryDtls><TxDtls>
          <RltdPties><Dbtr><Nm>Kunde B GmbH</Nm></Dbtr></RltdPties>
          <RmtInf><Ustrd>Zahlung fuer RE-2026-00099</Ustrd></RmtInf>
        </TxDtls></NtryDtls>
      </Ntry>
    </Stmt>
  </BkToCstmrStmt>
</Document>`;

// decisions/0076: a debit to the fake OCR engine's Telekom invoice (incoming, 49.99 EUR), booked
// to the same counterparty name - a deterministic name-and-amount match.
const TELEKOM_CAMT_053_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02">
  <BkToCstmrStmt>
    <Stmt>
      <Id>STMT-MATCH-AFTER-TRIGGER</Id>
      <Acct><Id><IBAN>DE89370400440532019001</IBAN></Id><Ccy>EUR</Ccy></Acct>
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

/** A 1x1 PNG: the upload route assembles it into a PDF, which the fake OCR engine reads as the
 * Telekom invoice (`src/modules/documents/core/fake-ocr-engine.ts`). */
const PNG_1X1_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
/** An opaque red 1x1 PNG: a different assembled PDF, so the exact-duplicate check accepts it
 * (`processing-pipeline.integration.test.ts` uses the same pair). */
const PNG_1X1_VARIANT_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

async function matchPaymentJobs(workspaceId: string) {
  return getDb()
    .select()
    .from(jobs)
    .where(and(eq(jobs.workspaceId, workspaceId), eq(jobs.kind, "match-payments")));
}

async function createTestUser(label: string): Promise<{ id: string; email: string }> {
  const email = `${label}-${randomUUID()}@example.test`;
  const [row] = await getDb().insert(user).values({ name: "Payments Test User", email, emailVerified: false }).returning({ id: user.id });
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

/** Creates an invoice-shaped document directly (bypassing OCR - this test is about matching,
 * not extraction, which C2/decisions/0021 already covers on its own). */
async function createInvoiceDocument(
  workspaceId: string,
  input: { direction: DocumentDirection; invoiceNumber: string | null; totalAmountCents: number },
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
    documentDate: null,
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

describe("payment matching (F3b, real Postgres + MinIO, fake AI)", () => {
  it(
    "auto-confirms two invoices via a real camt.053 import, never re-suggests a rejected collective pairing, and is idempotent",
    async () => {
      const founder = await createTestUser("payments-matching");
      currentUser = founder;
      const workspace = await createWorkspaceForUser(founder.id, "Payments Matching GmbH");

      // --- Part 1: a real camt.053 import whose remittance texts name two alphanumeric
      // invoice numbers exactly - both money IN, so both settle an OUTGOING invoice
      // (decisions/0021's direction convention).
      const bytes = Buffer.from(CAMT_053_XML, "utf8");
      const uploadResponse = await POST(postRequest(uploadForm(bytes, "kontoauszug.xml", "application/xml")), {} as never);
      expect(uploadResponse.status).toBe(201);
      await runDueJobs({ workspaceId: workspace.id, limit: 20 });

      const invoice1 = await createInvoiceDocument(workspace.id, { direction: "outgoing", invoiceNumber: "RE-2026-00042", totalAmountCents: 25_000 });
      const invoice2 = await createInvoiceDocument(workspace.id, { direction: "outgoing", invoiceNumber: "RE-2026-00099", totalAmountCents: 50_000 });

      const firstRun = await getRequestServices().payments.runMatching({ workspaceId: workspace.id, trigger: "document_done" });
      expect(firstRun.autoConfirmed).toBe(2);

      const section1 = await getRequestServices().payments.getDocumentPaymentSection(workspace.id, invoice1);
      const section2 = await getRequestServices().payments.getDocumentPaymentSection(workspace.id, invoice2);
      expect(section1?.paymentStatus).toBe("paid");
      expect(section1?.matchedTransactions).toHaveLength(1);
      expect(section1?.matchedTransactions[0]).toMatchObject({ status: "confirmed", kind: "exact", matchedBy: "auto", allocatedAmountCents: 25_000 });
      expect(section2?.paymentStatus).toBe("paid");
      expect(section2?.matchedTransactions).toHaveLength(1);

      // --- Part 2: a collective payment - one transaction with no invoice-number signal at
      // all, whose amount equals exactly the sum of two fresh open invoices. Inserted directly
      // against a dedicated account (this scenario does not depend on camt parsing itself,
      // already proven above and by @/modules/intake's own tests).
      const accountRepo = createDrizzleAccountRepository(getDb());
      const transactionRepo = createDrizzleTransactionRepository(getDb());
      const account = await accountRepo.create({
        workspaceId: workspace.id,
        type: "bank",
        name: "Sammelzahlungskonto",
        iban: null,
        bic: null,
        currency: "EUR",
        holder: null,
        platform: null,
      });

      // decisions/0045: a collective payment needs every document to share the payment's
      // counterparty; here both invoice numbers appear in the remittance text.
      const invoiceA = await createInvoiceDocument(workspace.id, { direction: "incoming", invoiceNumber: "1001", totalAmountCents: 3_000 });
      const invoiceB = await createInvoiceDocument(workspace.id, { direction: "incoming", invoiceNumber: "1002", totalAmountCents: 7_000 });

      const [collectiveTx] = await transactionRepo.insertManyIdempotent([
        {
          workspaceId: workspace.id,
          accountId: account.id,
          bookingDate: "2026-08-20",
          valueDate: "2026-08-20",
          amountCents: -10_000,
          currency: "EUR",
          creditDebit: "debit",
          counterpartyName: "Sammelüberweisung",
          counterpartyIban: null,
          counterpartyBic: null,
          remittanceText: "Sammelzahlung Rechnung 1001 und Rechnung 1002",
          endToEndId: null,
          mandateId: null,
          creditorId: null,
          bankTxCode: null,
          bankReference: null,
          idempotencyKey: `collective-${randomUUID()}`,
          importBatchId: null,
          sourceDocumentId: null,
          raw: null,
        },
      ]);
      if (!collectiveTx) throw new Error("expected the collective transaction to be inserted");

      const secondRun = await getRequestServices().payments.runMatching({ workspaceId: workspace.id, trigger: "cron" });
      expect(secondRun.autoConfirmed).toBe(0); // a collective suggestion is never auto-confirmed

      const sectionA = await getRequestServices().payments.getDocumentPaymentSection(workspace.id, invoiceA);
      const sectionB = await getRequestServices().payments.getDocumentPaymentSection(workspace.id, invoiceB);
      expect(sectionA?.suggestions).toHaveLength(1);
      expect(sectionA?.suggestions[0]).toMatchObject({ status: "suggested", kind: "collective", transactionId: collectiveTx.id });
      expect(sectionB?.suggestions).toHaveLength(1);
      expect(sectionB?.suggestions[0]).toMatchObject({ status: "suggested", kind: "collective", transactionId: collectiveTx.id });

      // --- Part 3: rejecting invoiceA's leg of the collective suggestion must never be
      // re-proposed by a later run, even though invoiceB's own leg is untouched.
      const rejectedSuggestionId = sectionA!.suggestions[0]!.id;
      await getRequestServices().payments.rejectSuggestion({ workspaceId: workspace.id, documentTransactionId: rejectedSuggestionId, actingUserId: founder.id });

      const thirdRun = await getRequestServices().payments.runMatching({ workspaceId: workspace.id, trigger: "cron" });
      expect(thirdRun.autoConfirmed).toBe(0);

      const sectionAAfterRejection = await getRequestServices().payments.getDocumentPaymentSection(workspace.id, invoiceA);
      expect(sectionAAfterRejection?.suggestions).toHaveLength(0); // never re-suggested
      const sectionBAfterRejection = await getRequestServices().payments.getDocumentPaymentSection(workspace.id, invoiceB);
      // decisions/0045: the collective hypothesis is broken once one leg is rejected, so the
      // other leg is withdrawn too instead of lingering as half a collective payment.
      expect(sectionBAfterRejection?.suggestions).toHaveLength(0);

      // --- Part 4: idempotency - running matching again changes nothing further: the two
      // auto-confirmed invoices stay confirmed exactly once each, invoiceA stays rejected and
      // un-suggested, and the collective is not re-proposed for invoiceB either.
      const fourthRun = await getRequestServices().payments.runMatching({ workspaceId: workspace.id, trigger: "cron" });
      expect(fourthRun.autoConfirmed).toBe(0);

      const finalSection1 = await getRequestServices().payments.getDocumentPaymentSection(workspace.id, invoice1);
      expect(finalSection1?.matchedTransactions).toHaveLength(1);
      const finalSectionA = await getRequestServices().payments.getDocumentPaymentSection(workspace.id, invoiceA);
      expect(finalSectionA?.suggestions).toHaveLength(0);
      const finalSectionB = await getRequestServices().payments.getDocumentPaymentSection(workspace.id, invoiceB);
      expect(finalSectionB?.suggestions).toHaveLength(0);
    },
    30_000,
  );

  // decisions/0076: production runs jobs only from `after()` and a two-hourly cron, so a
  // finished invoice and an imported statement must be matched by the very runner invocation
  // that processed them (here: one `runDueJobs` call each, like the upload route's `after()`).
  it(
    "matches right after every trigger: a statement import and an invoice upload each end matched within their own runDueJobs call",
    async () => {
      const founder = await createTestUser("match-after-trigger");
      currentUser = founder;
      const workspace = await createWorkspaceForUser(founder.id, "Sofortabgleich GmbH");

      // 1. The statement: process-document -> import-account-transactions -> match-payments,
      // all in ONE runner call. Nothing to match yet, so the run queues its six-hour follow-up.
      const statementResponse = await POST(postRequest(uploadForm(Buffer.from(TELEKOM_CAMT_053_XML, "utf8"), "kontoauszug.xml", "application/xml")), {} as never);
      expect(statementResponse.status).toBe(201);
      const statementRun = await runDueJobs({ workspaceId: workspace.id, limit: 5 });
      expect(statementRun.processed).toBe(3);

      const afterStatement = await matchPaymentJobs(workspace.id);
      expect(afterStatement.filter((j) => j.status === "done")).toHaveLength(1);
      const queued = afterStatement.filter((j) => j.status === "pending");
      expect(queued).toHaveLength(1);
      expect(queued[0]!.payload).toMatchObject({ trigger: "cron" });
      expect(queued[0]!.runAt.getTime()).toBeGreaterThan(Date.now() + 5 * 3_600_000);

      // 2. The invoice: process-document -> match-payments in ONE runner call. The pending
      // six-hour follow-up must not swallow the immediate run: it is pulled forward and runs now.
      const invoiceForm = new FormData();
      invoiceForm.append("files", new File([Buffer.from(PNG_1X1_B64, "base64")], "seite-1.png", { type: "image/png" }));
      invoiceForm.append("fileName", "rechnung-telekom.pdf");
      const invoiceResponse = await POST(postRequest(invoiceForm), {} as never);
      expect(invoiceResponse.status).toBe(201);
      const { documentId } = (await invoiceResponse.json()) as { documentId: string };

      const invoiceRun = await runDueJobs({ workspaceId: workspace.id, limit: 5 });
      expect(invoiceRun.processed).toBe(2);

      const section = await getRequestServices().payments.getDocumentPaymentSection(workspace.id, documentId);
      // The default auto-confirm mode ("system", decisions/0044) books this deterministic
      // name-and-amount match by itself.
      expect(section?.paymentStatus).toBe("paid");
      expect(section?.matchedTransactions).toHaveLength(1);
      expect(section?.matchedTransactions[0]).toMatchObject({ status: "confirmed", matchedBy: "auto", allocatedAmountCents: 4_999 });

      const afterInvoice = await matchPaymentJobs(workspace.id);
      expect(afterInvoice.filter((j) => j.status === "done")).toHaveLength(2);
      // Everything is resolved now, so no follow-up remains queued.
      expect(afterInvoice.filter((j) => j.status === "pending")).toHaveLength(0);
    },
    30_000,
  );

  it(
    "a bulk upload matches once per runner call, after every document it processed",
    async () => {
      const founder = await createTestUser("match-bulk");
      currentUser = founder;
      const workspace = await createWorkspaceForUser(founder.id, "Stapelupload GmbH");

      // Two invoices uploaded before any runner starts (one request each, like the upload
      // form), from distinct image bytes so the duplicate check accepts the second.
      for (const [index, base64] of [PNG_1X1_B64, PNG_1X1_VARIANT_B64].entries()) {
        const form = new FormData();
        form.append("files", new File([Buffer.from(base64, "base64")], "seite-1.png", { type: "image/png" }));
        form.append("fileName", `rechnung-telekom-${index + 1}.pdf`);
        const response = await POST(postRequest(form), {} as never);
        expect(response.status).toBe(201);
      }

      const run = await runDueJobs({ workspaceId: workspace.id, limit: 5 });

      // Two documents and ONE matching run: the first finished invoice queued it due now, the
      // second found it still queued, and it was claimed only after both documents.
      expect(run.processed).toBe(3);
      const matchJobs = await matchPaymentJobs(workspace.id);
      expect(matchJobs.filter((j) => j.status === "done")).toHaveLength(1);
    },
    30_000,
  );
});
