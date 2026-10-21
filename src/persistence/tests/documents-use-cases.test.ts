// Unit tests for createDocumentUseCases (WEBAPP_TEMPLATE_SPEC.md §10.2): typed fakes via
// dependency injection, no DB, no vi.mock. Covers quota rejections (pre-check and the
// authoritative in-transaction re-check), the storage compensation on a failed transaction,
// and workspace scoping.
import { describe, expect, it, vi } from "vitest";

import { createFakeObjectStorage } from "@/platform/object-storage/tests/support/fake-object-storage";
import { createFakeOcrEngine, createFakeDocumentAnalyzer, type OcrEngine, type DocumentAnalyzer } from "@/modules/documents";
import { createFakeIntakeClassifier, MT940_MIME_TYPE, sampleTabular, type IntakeClassifier } from "@/modules/intake";
import { withUnusedRepositories } from "@/persistence/tests/support/unused-repositories";
import { createFakeBillingRepository } from "@/persistence/tests/support/fake-billing-repositories";
import {
  createFakeContactProposalRepository,
  createFakeContactRepository,
  createFakeDocumentContactRepository,
} from "@/persistence/tests/support/fake-contacts-repositories";
import { createFakeDocumentRepository, createFakeIntakeFingerprintRepository, documentRow } from "@/persistence/tests/support/fake-documents-repositories";
import { createFakeJobsRepository } from "@/persistence/tests/support/fake-jobs-repository";
import { createFakeAccountRepository } from "@/persistence/tests/support/fake-accounts-repositories";
import { createFakeDocumentTransactionRepository, documentTransactionRow } from "@/persistence/tests/support/fake-payments-repositories";
import { createFakeWorkspaceMemberRepository, createFakeWorkspaceRepository, workspaceRow } from "@/persistence/tests/support/fake-workspaces-repositories";
import type { DocumentRepository, Repositories, UnitOfWork } from "@/persistence/repositories/contracts";
import { createTestPaymentProvider } from "@/modules/billing";
import { createBillingUseCases } from "@/persistence/use-cases/billing-use-cases";
import { createContactUseCases } from "@/persistence/use-cases/contacts-use-cases";
import { createDocumentUseCases, DOCUMENT_ERROR, MappingValidationError } from "@/persistence/use-cases/documents-use-cases";
import { PermanentJobError, TransientJobError } from "@/platform/jobs";
import { MistralRequestError } from "@/platform/mistral";
import { PDFDocument } from "pdf-lib";

const FIXED_NOW = new Date("2026-03-15T00:00:00.000Z");
const PDF_BYTES = new Uint8Array([1, 2, 3]);

function setup(options: {
  workspaces?: Parameters<typeof createFakeWorkspaceRepository>[0];
  members?: Parameters<typeof createFakeWorkspaceMemberRepository>[0];
  documents?: Parameters<typeof createFakeDocumentRepository>[0];
  documentRepoOverride?: (repo: DocumentRepository) => DocumentRepository;
  ocrEngine?: OcrEngine;
  analyzer?: DocumentAnalyzer;
  intakeClassifier?: IntakeClassifier;
  intakeFingerprints?: Parameters<typeof createFakeIntakeFingerprintRepository>[0];
  /** decisions/0072: `reclassifyDocument` reads a document's payment links (read-only). */
  documentTransactions?: Parameters<typeof createFakeDocumentTransactionRepository>[0];
  generateId?: () => string;
} = {}) {
  const { repo: workspace, state: workspaceState } = createFakeWorkspaceRepository(options.workspaces);
  const { repo: workspaceMember } = createFakeWorkspaceMemberRepository(options.members);
  const { repo: documentRepoBase, state: documentState } = createFakeDocumentRepository(options.documents);
  const document = options.documentRepoOverride ? options.documentRepoOverride(documentRepoBase) : documentRepoBase;
  const { repo: billing } = createFakeBillingRepository();
  const { repo: jobs, state: jobState } = createFakeJobsRepository();
  // C2 (decisions/0021-extraction-direction-and-invoice-fields.md): `processDocument` links
  // extracted parties via `contacts.upsertFromExtraction`, so every test that exercises it
  // needs these three repositories present too (`withUnusedRepositories` throws on first
  // touch of anything not provided).
  const { repo: contact, state: contactState } = createFakeContactRepository();
  const { repo: documentContact, state: documentContactState } = createFakeDocumentContactRepository();
  const { repo: contactProposal, state: contactProposalState } = createFakeContactProposalRepository();
  const { repo: intakeFingerprint, state: intakeFingerprintState } = createFakeIntakeFingerprintRepository(options.intakeFingerprints);

  // decisions/0039: the own-IBAN check reads the workspace's imported bank accounts.
  const { repo: account } = createFakeAccountRepository();
  const { repo: documentTransaction, state: documentTransactionState } = createFakeDocumentTransactionRepository(options.documentTransactions);

  const repos: Repositories = withUnusedRepositories({
    account,
    workspace,
    workspaceMember,
    document,
    billing,
    jobs,
    contact,
    documentContact,
    contactProposal,
    intakeFingerprint,
    documentTransaction,
  });
  const uow: UnitOfWork = { transaction: (work) => work(repos) };
  const { storage, objects } = createFakeObjectStorage();

  const billingUseCases = createBillingUseCases({ repos, uow, paymentProvider: createTestPaymentProvider(), now: () => FIXED_NOW });
  const contactUseCases = createContactUseCases({ repos, uow, now: () => FIXED_NOW });
  const useCases = createDocumentUseCases({
    repos,
    uow,
    objectStorage: storage,
    billing: billingUseCases,
    contacts: contactUseCases,
    ocrEngine: options.ocrEngine ?? createFakeOcrEngine(),
    analyzer: options.analyzer ?? createFakeDocumentAnalyzer(),
    intakeClassifier: options.intakeClassifier ?? createFakeIntakeClassifier(),
    now: () => FIXED_NOW,
    generateId: options.generateId ?? (() => "11111111-1111-1111-1111-111111111111"),
  });

  return {
    useCases,
    workspaceState,
    documentState,
    objects,
    storage,
    jobState,
    contactState,
    documentContactState,
    contactProposalState,
    intakeFingerprintState,
    documentTransactionState,
  };
}

describe("createDocumentUseCases", () => {
  describe("createFromUpload", () => {
    it("stores the object, inserts the row, and records usage", async () => {
      const workspace = workspaceRow({ name: "Muster GmbH", tier: "free" });
      const { useCases, documentState, objects } = setup({ workspaces: [workspace] });

      const doc = await useCases.createFromUpload({
        workspaceId: workspace.id,
        uploadedByUserId: "u1",
        originalFileName: "brief.pdf",
        bytes: PDF_BYTES,
        mimeType: "application/pdf",
        extension: "pdf",
        pageCount: 1,
        fileHash: crypto.randomUUID(),
      });

      expect(doc.originalFileName).toBe("brief.pdf");
      expect(doc.mimeType).toBe("application/pdf");
      expect(documentState).toHaveLength(1);
      expect(objects.has(documentState[0]!.storageKey)).toBe(true);
      expect(documentState[0]!.storageKey).toBe(`workspaces/${workspace.id}/documents/11111111-1111-1111-1111-111111111111/original.pdf`);
    });

    it("rejects with quota_total_exceeded before writing to storage when the workspace is already at its limit (pre-check)", async () => {
      const workspace = workspaceRow({ name: "Muster GmbH", tier: "free" });
      const existing = Array.from({ length: 20 }, () =>
        documentRow({ workspaceId: workspace.id, storageKey: `workspaces/${workspace.id}/documents/${crypto.randomUUID()}/original.pdf` }),
      );
      const { useCases, objects } = setup({ workspaces: [workspace], documents: existing });

      await expect(
        useCases.createFromUpload({
          workspaceId: workspace.id,
          uploadedByUserId: "u1",
          originalFileName: "brief.pdf",
          bytes: PDF_BYTES,
          mimeType: "application/pdf",
          extension: "pdf",
          pageCount: 1,
          fileHash: crypto.randomUUID(),
        }),
      ).rejects.toMatchObject({ code: DOCUMENT_ERROR.quotaTotalExceeded });
      expect(objects.size).toBe(0);
    });

    it("deletes the already-stored object when the transaction fails (compensation)", async () => {
      const workspace = workspaceRow({ name: "Muster GmbH", tier: "free" });
      const { useCases, objects } = setup({
        workspaces: [workspace],
        documentRepoOverride: (repo) => ({
          ...repo,
          create: async () => {
            throw new Error("simulated DB failure inside the transaction");
          },
        }),
      });

      await expect(
        useCases.createFromUpload({
          workspaceId: workspace.id,
          uploadedByUserId: "u1",
          originalFileName: "brief.pdf",
          bytes: PDF_BYTES,
          mimeType: "application/pdf",
          extension: "pdf",
          pageCount: 1,
          fileHash: crypto.randomUUID(),
        }),
      ).rejects.toThrow("simulated DB failure inside the transaction");

      // The object was written before the transaction ran; once the transaction failed, it
      // must not be left orphaned in storage.
      expect(objects.size).toBe(0);
    });

    it("rejects for a workspace that does not exist", async () => {
      const { useCases } = setup();
      await expect(
        useCases.createFromUpload({
          workspaceId: crypto.randomUUID(),
          uploadedByUserId: "u1",
          originalFileName: "brief.pdf",
          bytes: PDF_BYTES,
          mimeType: "application/pdf",
          extension: "pdf",
          pageCount: 1,
          fileHash: crypto.randomUUID(),
        }),
      ).rejects.toMatchObject({ code: DOCUMENT_ERROR.notFound });
    });

    // F1b (decisions/0020-universal-intake.md's "Content-level duplicate detection"): an
    // exact repeat upload (same workspace, same `fileHash`) is rejected BEFORE any storage
    // write and BEFORE the quota is touched - not merely rejected somewhere in the flow.
    it("rejects a repeat upload (same fileHash) with duplicate_document, before storage or the quota check", async () => {
      const workspace = workspaceRow({ name: "Muster GmbH", tier: "free" });
      const existing = documentRow({
        workspaceId: workspace.id,
        storageKey: `workspaces/${workspace.id}/documents/${crypto.randomUUID()}/original.pdf`,
        fileHash: "shared-hash",
      });
      const { useCases, objects, documentState } = setup({ workspaces: [workspace], documents: [existing] });
      const countBefore = documentState.length;

      await expect(
        useCases.createFromUpload({
          workspaceId: workspace.id,
          uploadedByUserId: "u1",
          originalFileName: "erneut.pdf",
          bytes: PDF_BYTES,
          mimeType: "application/pdf",
          extension: "pdf",
          pageCount: 1,
          fileHash: "shared-hash",
        }),
      ).rejects.toMatchObject({ code: DOCUMENT_ERROR.duplicateDocument, existingDocumentId: existing.id });

      // Neither a new object nor a new row was ever created - the duplicate check runs
      // strictly before both.
      expect(objects.size).toBe(0);
      expect(documentState).toHaveLength(countBefore);
    });

    it("does not reject two different uploads with different fileHash values", async () => {
      const workspace = workspaceRow({ name: "Muster GmbH", tier: "free" });
      const ids = [crypto.randomUUID(), crypto.randomUUID()];
      const { useCases } = setup({ workspaces: [workspace], generateId: () => ids.shift()! });

      await useCases.createFromUpload({
        workspaceId: workspace.id,
        uploadedByUserId: "u1",
        originalFileName: "a.pdf",
        bytes: PDF_BYTES,
        mimeType: "application/pdf",
        extension: "pdf",
        pageCount: 1,
        fileHash: "hash-a",
      });

      await expect(
        useCases.createFromUpload({
          workspaceId: workspace.id,
          uploadedByUserId: "u1",
          originalFileName: "b.pdf",
          bytes: PDF_BYTES,
          mimeType: "application/pdf",
          extension: "pdf",
          pageCount: 1,
          fileHash: "hash-b",
        }),
      ).resolves.toMatchObject({ originalFileName: "b.pdf" });
    });
  });

  describe("workspace scoping", () => {
    it("counts, lists, and finds only the given workspace's documents", async () => {
      const w1 = workspaceRow({ name: "Firma A" });
      const w2 = workspaceRow({ name: "Firma B" });
      const docW1 = documentRow({ workspaceId: w1.id, storageKey: `workspaces/${w1.id}/documents/d1/original.pdf`, title: "A" });
      const docW2 = documentRow({ workspaceId: w2.id, storageKey: `workspaces/${w2.id}/documents/d2/original.pdf`, title: "B" });
      const { useCases } = setup({ workspaces: [w1, w2], documents: [docW1, docW2] });

      const listW1 = await useCases.list(w1.id, { page: 1, pageSize: 50 });
      expect(listW1.items.map((d) => d.title)).toEqual(["A"]);

      expect(await useCases.getById(w1.id, docW2.id)).toBeNull();
      expect(await useCases.getById(w2.id, docW2.id)).not.toBeNull();
    });
  });

  describe("deleteDocument", () => {
    it("deletes the row and both storage objects", async () => {
      const workspace = workspaceRow({ name: "Muster GmbH" });
      const doc = documentRow({
        workspaceId: workspace.id,
        storageKey: `workspaces/${workspace.id}/documents/d1/original.pdf`,
        searchablePdfKey: `workspaces/${workspace.id}/documents/d1/searchable.pdf`,
      });
      const { useCases, documentState, objects, storage } = setup({ workspaces: [workspace], documents: [doc] });
      await storage.putObject({ key: doc.storageKey, body: PDF_BYTES, contentType: "application/pdf" });
      await storage.putObject({ key: doc.searchablePdfKey!, body: PDF_BYTES, contentType: "application/pdf" });

      await useCases.deleteDocument({ workspaceId: workspace.id, documentId: doc.id });

      expect(documentState).toHaveLength(0);
      expect(objects.has(doc.storageKey)).toBe(false);
      expect(objects.has(doc.searchablePdfKey!)).toBe(false);
    });

    it("rejects deleting a document that does not exist in this workspace", async () => {
      const { useCases } = setup();
      await expect(useCases.deleteDocument({ workspaceId: "w1", documentId: crypto.randomUUID() })).rejects.toMatchObject({
        code: DOCUMENT_ERROR.notFound,
      });
    });
  });

  describe("enqueuePurgeForRejectedIntake (F5, decisions/0027-hardening-and-deletion.md)", () => {
    const THIRTY_ONE_DAYS_AGO = new Date(FIXED_NOW.getTime() - 31 * 24 * 60 * 60 * 1000);
    const TWENTY_NINE_DAYS_AGO = new Date(FIXED_NOW.getTime() - 29 * 24 * 60 * 60 * 1000);

    it("enqueues a purge-rejected-intake job per eligible document, across every workspace", async () => {
      const workspaceA = workspaceRow({ name: "A" });
      const workspaceB = workspaceRow({ name: "B" });
      const oldRejectedA = documentRow({
        workspaceId: workspaceA.id,
        storageKey: `workspaces/${workspaceA.id}/documents/old-a/original.csv`,
        intakeStatus: "rejected",
        updatedAt: THIRTY_ONE_DAYS_AGO,
      });
      const oldRejectedB = documentRow({
        workspaceId: workspaceB.id,
        storageKey: `workspaces/${workspaceB.id}/documents/old-b/original.csv`,
        intakeStatus: "rejected",
        updatedAt: THIRTY_ONE_DAYS_AGO,
      });
      const { useCases, jobState } = setup({
        workspaces: [workspaceA, workspaceB],
        documents: [oldRejectedA, oldRejectedB],
      });

      const result = await useCases.enqueuePurgeForRejectedIntake();

      expect(result).toEqual({ enqueued: 2 });
      expect(jobState).toHaveLength(2);
      expect(jobState.map((j) => j.payload)).toEqual(
        expect.arrayContaining([
          { workspaceId: workspaceA.id, documentId: oldRejectedA.id },
          { workspaceId: workspaceB.id, documentId: oldRejectedB.id },
        ]),
      );
      expect(jobState.every((j) => j.kind === "purge-rejected-intake")).toBe(true);
    });

    it("never enqueues a rejected document younger than the retention window", async () => {
      const workspace = workspaceRow({ name: "Muster GmbH" });
      const recentlyRejected = documentRow({
        workspaceId: workspace.id,
        storageKey: `workspaces/${workspace.id}/documents/recent/original.csv`,
        intakeStatus: "rejected",
        updatedAt: TWENTY_NINE_DAYS_AGO,
      });
      const { useCases, jobState } = setup({ workspaces: [workspace], documents: [recentlyRejected] });

      const result = await useCases.enqueuePurgeForRejectedIntake();

      expect(result).toEqual({ enqueued: 0 });
      expect(jobState).toHaveLength(0);
    });

    it("never enqueues a document with any other intake status, however old", async () => {
      const workspace = workspaceRow({ name: "Muster GmbH" });
      const oldButConfirmed = documentRow({
        workspaceId: workspace.id,
        storageKey: `workspaces/${workspace.id}/documents/confirmed/original.csv`,
        intakeStatus: "confirmed",
        updatedAt: THIRTY_ONE_DAYS_AGO,
      });
      const oldButPending = documentRow({
        workspaceId: workspace.id,
        storageKey: `workspaces/${workspace.id}/documents/pending/original.csv`,
        intakeStatus: "pending_confirmation",
        updatedAt: THIRTY_ONE_DAYS_AGO,
      });
      const { useCases, jobState } = setup({ workspaces: [workspace], documents: [oldButConfirmed, oldButPending] });

      const result = await useCases.enqueuePurgeForRejectedIntake();

      expect(result).toEqual({ enqueued: 0 });
      expect(jobState).toHaveLength(0);
    });
  });

  describe("createFromUpload enqueues process-document", () => {
    it("enqueues a process-document job in the same transaction as the insert", async () => {
      const workspace = workspaceRow({ name: "Muster GmbH", tier: "free" });
      const { useCases, jobState, documentState } = setup({ workspaces: [workspace] });

      const doc = await useCases.createFromUpload({
        workspaceId: workspace.id,
        uploadedByUserId: "u1",
        originalFileName: "rechnung-telekom.pdf",
        bytes: PDF_BYTES,
        mimeType: "application/pdf",
        extension: "pdf",
        pageCount: 1,
        fileHash: crypto.randomUUID(),
      });

      expect(jobState).toHaveLength(1);
      expect(jobState[0]).toMatchObject({
        kind: "process-document",
        workspaceId: workspace.id,
        payload: { documentId: documentState[0]!.id, workspaceId: workspace.id },
      });
      expect(doc.status).toBe("uploaded");
    });
  });

  describe("processDocument", () => {
    async function pdfFixture(): Promise<Uint8Array> {
      const doc = await PDFDocument.create();
      doc.addPage([595.28, 841.89]);
      return doc.save();
    }

    it("runs OCR, analyzes, builds a searchable PDF, and marks the document done (happy path)", async () => {
      const workspace = workspaceRow({ name: "Muster GmbH" });
      const pdfBytes = await pdfFixture();
      const doc = documentRow({
        workspaceId: workspace.id,
        storageKey: `workspaces/${workspace.id}/documents/d1/original.pdf`,
        originalFileName: "rechnung-telekom.pdf",
      });
      const { useCases, documentState, storage } = setup({ workspaces: [workspace], documents: [doc] });
      await storage.putObject({ key: doc.storageKey, body: pdfBytes, contentType: "application/pdf" });

      await useCases.processDocument({ workspaceId: workspace.id, documentId: doc.id });

      const updated = documentState.find((d) => d.id === doc.id)!;
      expect(updated.status).toBe("done");
      expect(updated.ocrText).toContain("Telekom Deutschland GmbH");
      expect(updated.searchablePdfKey).toBe(`workspaces/${workspace.id}/documents/${doc.id}/searchable.pdf`);
      expect(updated.errorCode).toBeNull();
    });

    // C2 (decisions/0021-extraction-direction-and-invoice-fields.md): direction, invoice
    // fields, and contact linking, on top of the same happy-path fixture above.
    describe("direction, invoice fields, and contact linking", () => {
      it("sets direction incoming, fills invoice fields, and links an unverified sender contact for the Telekom fixture", async () => {
        const workspace = workspaceRow({ name: "Muster GmbH" });
        const pdfBytes = await pdfFixture();
        const doc = documentRow({
          workspaceId: workspace.id,
          storageKey: `workspaces/${workspace.id}/documents/d1/original.pdf`,
          originalFileName: "rechnung-telekom.pdf",
        });
        const { useCases, documentState, storage, contactState, documentContactState } = setup({
          workspaces: [workspace],
          documents: [doc],
        });
        await storage.putObject({ key: doc.storageKey, body: pdfBytes, contentType: "application/pdf" });

        await useCases.processDocument({ workspaceId: workspace.id, documentId: doc.id });

        const updated = documentState.find((d) => d.id === doc.id)!;
        expect(updated.direction).toBe("incoming");
        expect(updated.invoiceNumber).toBe("4711");
        expect(updated.totalAmountCents).toBe(4999);
        expect(updated.currency).toBe("EUR");
        expect(updated.dueDate).toBe("2026-04-05");
        expect(updated.paymentIban).toBe("DE12500105170648489890");

        expect(contactState).toHaveLength(1);
        expect(contactState[0]).toMatchObject({ name: "Telekom Deutschland GmbH", vatId: "DE813298342", source: "auto", verifiedAt: null });
        expect(documentContactState).toEqual([expect.objectContaining({ documentId: doc.id, contactId: contactState[0]!.id, role: "sender" })]);
      });

      it("does not duplicate the contact or the link when the same document is retried", async () => {
        const workspace = workspaceRow({ name: "Muster GmbH" });
        const pdfBytes = await pdfFixture();
        const doc = documentRow({
          workspaceId: workspace.id,
          storageKey: `workspaces/${workspace.id}/documents/d1/original.pdf`,
          originalFileName: "rechnung-telekom.pdf",
        });
        const { useCases, storage, contactState, documentContactState } = setup({ workspaces: [workspace], documents: [doc] });
        await storage.putObject({ key: doc.storageKey, body: pdfBytes, contentType: "application/pdf" });

        await useCases.processDocument({ workspaceId: workspace.id, documentId: doc.id });
        await useCases.processDocument({ workspaceId: workspace.id, documentId: doc.id });

        expect(contactState).toHaveLength(1);
        expect(documentContactState).toHaveLength(1);
      });

      it("links a second document from the same sender to the same contact", async () => {
        const workspace = workspaceRow({ name: "Muster GmbH" });
        const pdfBytes = await pdfFixture();
        const doc1 = documentRow({
          workspaceId: workspace.id,
          storageKey: `workspaces/${workspace.id}/documents/d1/original.pdf`,
          originalFileName: "rechnung-telekom.pdf",
        });
        const doc2 = documentRow({
          workspaceId: workspace.id,
          storageKey: `workspaces/${workspace.id}/documents/d2/original.pdf`,
          originalFileName: "rechnung-telekom.pdf",
        });
        const { useCases, storage, contactState, documentContactState } = setup({ workspaces: [workspace], documents: [doc1, doc2] });
        await storage.putObject({ key: doc1.storageKey, body: pdfBytes, contentType: "application/pdf" });
        await storage.putObject({ key: doc2.storageKey, body: pdfBytes, contentType: "application/pdf" });

        await useCases.processDocument({ workspaceId: workspace.id, documentId: doc1.id });
        await useCases.processDocument({ workspaceId: workspace.id, documentId: doc2.id });

        expect(contactState).toHaveLength(1);
        expect(documentContactState).toHaveLength(2);
        expect(documentContactState.every((l) => l.contactId === contactState[0]!.id)).toBe(true);
      });

      it("marks a document outgoing and links a recipient contact when the model marks our own company as sender", async () => {
        const workspace = workspaceRow({
          name: "Muster Werkstatt GmbH",
          companyPostalCode: "10115",
          companyCity: "Berlin",
          companyVatId: "DE111222333",
        });
        const pdfBytes = await pdfFixture();
        const doc = documentRow({
          workspaceId: workspace.id,
          storageKey: `workspaces/${workspace.id}/documents/d1/original.pdf`,
          originalFileName: "ausgangsrechnung.pdf",
        });
        const { useCases, documentState, storage, contactState, documentContactState } = setup({ workspaces: [workspace], documents: [doc] });
        await storage.putObject({ key: doc.storageKey, body: pdfBytes, contentType: "application/pdf" });

        await useCases.processDocument({ workspaceId: workspace.id, documentId: doc.id });

        const updated = documentState.find((d) => d.id === doc.id)!;
        expect(updated.direction).toBe("outgoing");

        // The workspace's own company must never become a contact of itself, even though the
        // fake analyzer extracted it as a party (decisions/0019-contacts.md's own-company
        // exclusion, enforced in code via `isOwnCompany`, never trusted from the model).
        expect(contactState).toHaveLength(1);
        expect(contactState[0]!.name).not.toBe("Muster Werkstatt GmbH");
        expect(contactState[0]!.name).toBe("Muster Kunde GmbH");
        expect(documentContactState).toEqual([expect.objectContaining({ documentId: doc.id, contactId: contactState[0]!.id, role: "recipient" })]);
      });

      // H2-wave2.md's explicit "end-to-end check with fakes": the observed real defect,
      // reproduced end to end and proven fixed - the workspace's own brand ("Musterfirma") in
      // the letterhead, its own bank in the footer, and the customer in the address block all
      // appear in the SAME document text; the guided ("derived" mode) prompt asks the analyzer
      // for exactly ONE counterparty (the recipient), so there is no "list everyone" answer
      // that could ever put the bank or the workspace's own brand into `document_contacts` in
      // the first place - unlike the old ungated prompt, which is exactly how the real defect
      // happened (5 links from 3 runs, including the own bank and the own company itself).
      it("an outgoing invoice with our brand in the letterhead and our bank in the footer links only the customer, never the bank or ourselves", async () => {
        const workspace = workspaceRow({
          name: "Muster Werkstatt GmbH",
          companyPostalCode: "10115",
          companyCity: "Berlin",
          companyVatId: "DE111222333",
          companyAliases: ["Musterfirma"],
          companyIbans: ["DE89370400440532013000"],
        });
        const pdfBytes = await pdfFixture();
        const doc = documentRow({
          workspaceId: workspace.id,
          storageKey: `workspaces/${workspace.id}/documents/d1/original.pdf`,
          originalFileName: "musterfirma-ausgangsrechnung.pdf",
        });

        // The realistic shape of the owner's own real document: brand in the letterhead, the
        // customer's address block, and the workspace's own bank in the footer.
        const ocrText = [
          "Musterfirma",
          "Muster Werkstatt GmbH",
          "Ausgangsrechnung",
          "Rechnungsnummer 9001",
          "Muster Kunde GmbH",
          "Kundenstrasse 5",
          "20095 Hamburg",
          "Rechnungsbetrag: 250,00 EUR",
          "Bankverbindung: DE89 3704 0044 0532 0130 00",
          "MUSTERBANK PAYMENTS",
        ].join("\n");
        const ocrEngine: OcrEngine = {
          recognize: async () => ({ pages: [{ index: 0, markdown: ocrText, dimensions: null, blocks: null }] }),
        };

        const guidedAnalyzer: DocumentAnalyzer = {
          analyze: () => {
            throw new Error("analyze is no longer called by processOcrDocument since decisions/0036's wave 2");
          },
          analyzeGuided: async ({ plan }) => {
            // The whole point of guided extraction: `processOcrDocument` must have classified
            // `outgoing_invoice` and derived the plan BEFORE calling the analyzer at all.
            expect(plan.mode).toBe("derived");
            return {
              title: "Ausgangsrechnung",
              sender: "Muster Werkstatt GmbH",
              documentDate: "2026-04-20",
              summary: "Ausgangsrechnung ueber 250,00 EUR",
              counterparty: { name: "Muster Kunde GmbH", addressLine1: "Kundenstrasse 5", postalCode: "20095", city: "Hamburg", country: "DE" },
              parties: [],
              invoice: {
                invoiceNumber: "9001",
                totalAmountCents: 25000,
                currency: "EUR",
                dueDate: null,
                paymentIban: "DE89370400440532013000",
                paymentReference: null,
                paidNote: null,
              },
              reminderDirection: null,
            };
          },
        };
        const classifierClassify = vi.fn().mockResolvedValue({
          documentKind: "outgoing_invoice",
          confidence: 0.9,
          reason: "Ausgehende Rechnung erkannt",
          platform: null,
          columnMapping: null,
          amountSign: null,
        });
        const { useCases, documentState, storage, contactState, documentContactState } = setup({
          workspaces: [workspace],
          documents: [doc],
          analyzer: guidedAnalyzer,
          ocrEngine,
          intakeClassifier: { classify: classifierClassify },
        });
        await storage.putObject({ key: doc.storageKey, body: pdfBytes, contentType: "application/pdf" });

        await useCases.processDocument({ workspaceId: workspace.id, documentId: doc.id });

        const updated = documentState.find((d) => d.id === doc.id)!;
        expect(updated.direction).toBe("outgoing");
        expect(updated.kind).toBe("outgoing_invoice");
        expect(classifierClassify).toHaveBeenCalledTimes(1);

        expect(contactState).toHaveLength(1);
        expect(contactState[0]).toMatchObject({ name: "Muster Kunde GmbH", relationType: "customer", source: "auto" });
        expect(documentContactState).toEqual([expect.objectContaining({ documentId: doc.id, contactId: contactState[0]!.id, role: "recipient" })]);
      });

      // H2-wave2.md's addition, "promised to the owner": the self-counterparty check. The
      // residual weak spot of "the kind decides the roles" is a WRONG KIND, not a wrong role -
      // here the classifier calls a document `outgoing_invoice`, but the extracted
      // "counterparty" resolves to the workspace's OWN company under its brand alias, exactly
      // the shape a genuinely incoming invoice misclassified as outgoing would produce. Trusting
      // `plan.ourRole` here would silently invert a real supplier relationship into "our
      // customer" - the guard must instead leave direction `unknown`, link nothing, and keep
      // `kind` as classified (visible/correctable from the inbox filter).
      it("treats a derived counterparty that resolves to our own alias as a misclassified kind (self-counterparty guard)", async () => {
        const workspace = workspaceRow({
          name: "Muster Werkstatt GmbH",
          companyPostalCode: "10115",
          companyCity: "Berlin",
          companyVatId: "DE111222333",
          companyAliases: ["Musterfirma"],
        });
        const pdfBytes = await pdfFixture();
        const doc = documentRow({
          workspaceId: workspace.id,
          storageKey: `workspaces/${workspace.id}/documents/d1/original.pdf`,
          originalFileName: "falsch-klassifiziert.pdf",
        });

        const misclassifiedAnalyzer: DocumentAnalyzer = {
          analyze: () => {
            throw new Error("analyze is no longer called by processOcrDocument since decisions/0036's wave 2");
          },
          analyzeGuided: async () => ({
            title: "Rechnung",
            sender: "Lieferant GmbH",
            documentDate: "2026-04-20",
            summary: "Rechnung",
            counterparty: { name: "Musterfirma" },
            parties: [],
            invoice: { invoiceNumber: "77", totalAmountCents: 5000, currency: "EUR", dueDate: null, paymentIban: null, paymentReference: null, paidNote: null },
            reminderDirection: null,
          }),
        };
        const classifierClassify = vi.fn().mockResolvedValue({
          documentKind: "outgoing_invoice",
          confidence: 0.6,
          reason: "unsicher",
          platform: null,
          columnMapping: null,
          amountSign: null,
        });
        const { useCases, documentState, storage, contactState, documentContactState } = setup({
          workspaces: [workspace],
          documents: [doc],
          analyzer: misclassifiedAnalyzer,
          intakeClassifier: { classify: classifierClassify },
        });
        await storage.putObject({ key: doc.storageKey, body: pdfBytes, contentType: "application/pdf" });

        await useCases.processDocument({ workspaceId: workspace.id, documentId: doc.id });

        const updated = documentState.find((d) => d.id === doc.id)!;
        // `kind` is left exactly as classified - only `direction` is affected.
        expect(updated.kind).toBe("outgoing_invoice");
        expect(updated.direction).toBe("unknown");
        expect(updated.paymentStatus).toBe("not_applicable");
        expect(contactState).toHaveLength(0);
        expect(documentContactState).toHaveLength(0);
      });

      // H-contract.md section 5 / H2-wave2.md correction 3: a reminder's `payment_status` is
      // ALWAYS `not_applicable`, whatever direction and amount were found - it must never enter
      // payment matching (the original invoice it chases is already tracked as its own open
      // item, counting the reminder too would double the receivable).
      it("keeps a reminder's payment_status not_applicable even though direction and amount both resolve", async () => {
        const workspace = workspaceRow({ name: "Muster GmbH", companyIbans: ["DE89370400440532013000"] });
        const pdfBytes = await pdfFixture();
        const doc = documentRow({
          workspaceId: workspace.id,
          storageKey: `workspaces/${workspace.id}/documents/d1/original.pdf`,
          originalFileName: "mahnung.pdf",
        });
        // A foreign IBAN (not ours) -> `resolveReminderDirection` resolves `"incoming"`
        // regardless of the model's own answer - a genuine, resolvable direction and amount,
        // which is exactly why this test proves the `kind === "reminder"` exception fires
        // (without it, `isInvoiceShaped` would otherwise be `true` here).
        const reminderAnalyzer: DocumentAnalyzer = {
          analyze: () => {
            throw new Error("analyze is no longer called by processOcrDocument since decisions/0036's wave 2");
          },
          analyzeGuided: async () => ({
            title: "Zahlungserinnerung",
            sender: "Inkasso Meier KG",
            documentDate: "2026-04-01",
            summary: "Zahlungserinnerung",
            counterparty: null,
            parties: [{ role: "sender", name: "Inkasso Meier KG" }],
            invoice: {
              invoiceNumber: null,
              totalAmountCents: 8500,
              currency: "EUR",
              dueDate: null,
              paymentIban: "DE12500105170648489890",
              paymentReference: null,
              paidNote: null,
            },
            reminderDirection: "received",
          }),
        };
        const classifierClassify = vi.fn().mockResolvedValue({
          documentKind: "reminder",
          confidence: 0.85,
          reason: "Mahnung erkannt",
          platform: null,
          columnMapping: null,
          amountSign: null,
        });
        const { useCases, documentState, storage, jobState } = setup({
          workspaces: [workspace],
          documents: [doc],
          analyzer: reminderAnalyzer,
          intakeClassifier: { classify: classifierClassify },
        });
        await storage.putObject({ key: doc.storageKey, body: pdfBytes, contentType: "application/pdf" });

        await useCases.processDocument({ workspaceId: workspace.id, documentId: doc.id });

        const updated = documentState.find((d) => d.id === doc.id)!;
        expect(updated.direction).toBe("incoming");
        expect(updated.totalAmountCents).toBe(8500);
        expect(updated.paymentStatus).toBe("not_applicable");
        expect(jobState.filter((j) => j.kind === "match-payments")).toHaveLength(0);
      });

      // decisions/0036's "Payment status": `planCounterparty` now gives a settlement or payout
      // report a deterministic `incoming` direction, and an `incoming` document is matched
      // against DEBITS (`src/modules/payments/core/direction.ts`). The money in these documents
      // flows TO the workspace, so as an open item they would be paired with an unrelated
      // outgoing payment. They are reconciled by the settlement flow instead (decisions/0026).
      it.each(["platform_settlement", "payout_report"] as const)(
        "keeps a %s PDF out of payment matching although direction and amount both resolve",
        async (documentKind) => {
          const workspace = workspaceRow({ name: "Muster GmbH" });
          const pdfBytes = await pdfFixture();
          const doc = documentRow({
            workspaceId: workspace.id,
            storageKey: `workspaces/${workspace.id}/documents/d1/original.pdf`,
            originalFileName: "auszahlung.pdf",
          });
          const settlementAnalyzer: DocumentAnalyzer = {
            analyze: () => {
              throw new Error("analyze is no longer called by processOcrDocument since decisions/0036's wave 2");
            },
            analyzeGuided: async () => ({
              title: "Auszahlungsbericht",
              sender: "Stripe Payments Europe Ltd",
              documentDate: "2026-04-01",
              summary: "Monatliche Auszahlung",
              counterparty: { name: "Stripe Payments Europe Ltd", addressLine1: "1 Grand Canal Street Lower", city: "Dublin" },
              parties: [],
              invoice: { invoiceNumber: null, totalAmountCents: 124_900, currency: "EUR", dueDate: null, paymentIban: null, paymentReference: null, paidNote: null },
              reminderDirection: null,
            }),
          };
          const classifierClassify = vi.fn().mockResolvedValue({
            documentKind,
            confidence: 0.9,
            reason: "Plattformabrechnung erkannt",
            platform: "stripe",
            columnMapping: null,
            amountSign: null,
          });
          const { useCases, documentState, storage, jobState } = setup({
            workspaces: [workspace],
            documents: [doc],
            analyzer: settlementAnalyzer,
            intakeClassifier: { classify: classifierClassify },
          });
          await storage.putObject({ key: doc.storageKey, body: pdfBytes, contentType: "application/pdf" });

          await useCases.processDocument({ workspaceId: workspace.id, documentId: doc.id });

          const updated = documentState.find((d) => d.id === doc.id)!;
          expect(updated.kind).toBe(documentKind);
          expect(updated.direction).toBe("incoming");
          expect(updated.totalAmountCents).toBe(124_900);
          expect(updated.paymentStatus).toBe("not_applicable");
          expect(jobState.filter((j) => j.kind === "match-payments")).toHaveLength(0);
        },
      );
    });

    // decisions/0036-guided-extraction.md's wave 2: a self-identified ZUGFeRD invoice's `kind`
    // must be known BEFORE the guided analyzer ever runs (`planCounterparty(kind)` needs it),
    // so it can no longer be guessed from the analyzer's own extracted parties the way it used
    // to be (that guess only existed because the analyzer had already run). `resolveZugferdKind`
    // reads the CII XML's own seller/buyer names directly instead - no model call at all, the
    // same "self-identifying format, no classifier" rule camt.053/MT940 already follow.
    describe("ZUGFeRD kind resolution (no model call needed)", () => {
      function ciiInvoiceXml(sellerName: string, buyerName: string): string {
        return `<?xml version="1.0" encoding="UTF-8"?>
<rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100" xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100">
  <rsm:ExchangedDocument><ram:ID>4711</ram:ID></rsm:ExchangedDocument>
  <rsm:SupplyChainTradeTransaction>
    <ram:ApplicableHeaderTradeAgreement>
      <ram:SellerTradeParty><ram:Name>${sellerName}</ram:Name></ram:SellerTradeParty>
      <ram:BuyerTradeParty><ram:Name>${buyerName}</ram:Name></ram:BuyerTradeParty>
    </ram:ApplicableHeaderTradeAgreement>
    <ram:ApplicableHeaderTradeSettlement>
      <ram:InvoiceCurrencyCode>EUR</ram:InvoiceCurrencyCode>
      <ram:SpecifiedTradeSettlementHeaderMonetarySummation><ram:GrandTotalAmount>50.00</ram:GrandTotalAmount></ram:SpecifiedTradeSettlementHeaderMonetarySummation>
    </ram:ApplicableHeaderTradeSettlement>
  </rsm:SupplyChainTradeTransaction>
</rsm:CrossIndustryInvoice>`;
      }

      async function pdfWithEmbeddedZugferd(sellerName: string, buyerName: string): Promise<Uint8Array> {
        const pdfDoc = await PDFDocument.create();
        pdfDoc.addPage([595.28, 841.89]);
        await pdfDoc.attach(new TextEncoder().encode(ciiInvoiceXml(sellerName, buyerName)), "factur-x.xml", { mimeType: "application/xml" });
        return pdfDoc.save();
      }

      it("resolves outgoing_invoice when the CII seller name is our own company, no classifier call", async () => {
        const workspace = workspaceRow({ name: "Muster Werkstatt GmbH", companyVatId: "DE111222333" });
        const doc = documentRow({
          workspaceId: workspace.id,
          storageKey: `workspaces/${workspace.id}/documents/d1/original.pdf`,
          originalFileName: "zugferd-ausgangsrechnung.pdf",
        });
        const classifierClassify = vi.fn();
        const { useCases, documentState, storage } = setup({
          workspaces: [workspace],
          documents: [doc],
          intakeClassifier: { classify: classifierClassify },
        });
        await storage.putObject({
          key: doc.storageKey,
          body: await pdfWithEmbeddedZugferd("Muster Werkstatt GmbH", "Muster Kunde GmbH"),
          contentType: "application/pdf",
        });

        await useCases.processDocument({ workspaceId: workspace.id, documentId: doc.id });

        const updated = documentState.find((d) => d.id === doc.id)!;
        expect(updated.kind).toBe("outgoing_invoice");
        expect(updated.direction).toBe("outgoing");
        expect(classifierClassify).not.toHaveBeenCalled();
      });

      it("defaults to incoming_invoice when the CII seller name is not recognizably ours, no classifier call", async () => {
        const workspace = workspaceRow({ name: "Muster Werkstatt GmbH", companyVatId: "DE111222333" });
        const doc = documentRow({
          workspaceId: workspace.id,
          storageKey: `workspaces/${workspace.id}/documents/d1/original.pdf`,
          originalFileName: "zugferd-eingangsrechnung.pdf",
        });
        const classifierClassify = vi.fn();
        const { useCases, documentState, storage } = setup({
          workspaces: [workspace],
          documents: [doc],
          intakeClassifier: { classify: classifierClassify },
        });
        await storage.putObject({
          key: doc.storageKey,
          body: await pdfWithEmbeddedZugferd("Muster Lieferant GmbH", "Muster Werkstatt GmbH"),
          contentType: "application/pdf",
        });

        await useCases.processDocument({ workspaceId: workspace.id, documentId: doc.id });

        const updated = documentState.find((d) => d.id === doc.id)!;
        expect(updated.kind).toBe("incoming_invoice");
        expect(updated.direction).toBe("incoming");
        expect(classifierClassify).not.toHaveBeenCalled();
      });
    });

    it("is a no-op success when the document was deleted while the job was pending", async () => {
      const { useCases } = setup();
      await expect(useCases.processDocument({ workspaceId: "w1", documentId: crypto.randomUUID() })).resolves.toBeUndefined();
    });

    it("retries (throws TransientJobError) and records the document's errorCode on a transient OCR failure", async () => {
      const workspace = workspaceRow({ name: "Muster GmbH" });
      const pdfBytes = await pdfFixture();
      const doc = documentRow({ workspaceId: workspace.id, storageKey: `workspaces/${workspace.id}/documents/d1/original.pdf` });
      const failingOcr: OcrEngine = { recognize: async () => Promise.reject(new MistralRequestError("ai_rate_limited", true)) };
      const { useCases, documentState, storage } = setup({ workspaces: [workspace], documents: [doc], ocrEngine: failingOcr });
      await storage.putObject({ key: doc.storageKey, body: pdfBytes, contentType: "application/pdf" });

      await expect(useCases.processDocument({ workspaceId: workspace.id, documentId: doc.id })).rejects.toBeInstanceOf(TransientJobError);

      const updated = documentState.find((d) => d.id === doc.id)!;
      expect(updated.status).toBe("failed");
      expect(updated.errorCode).toBe("ai_rate_limited");
    });

    it("throws PermanentJobError and records the code on a permanent (auth) failure", async () => {
      const workspace = workspaceRow({ name: "Muster GmbH" });
      const pdfBytes = await pdfFixture();
      const doc = documentRow({ workspaceId: workspace.id, storageKey: `workspaces/${workspace.id}/documents/d1/original.pdf` });
      const failingOcr: OcrEngine = { recognize: async () => Promise.reject(new MistralRequestError("ai_auth_failed", false)) };
      const { useCases, documentState, storage } = setup({ workspaces: [workspace], documents: [doc], ocrEngine: failingOcr });
      await storage.putObject({ key: doc.storageKey, body: pdfBytes, contentType: "application/pdf" });

      await expect(useCases.processDocument({ workspaceId: workspace.id, documentId: doc.id })).rejects.toBeInstanceOf(PermanentJobError);

      const updated = documentState.find((d) => d.id === doc.id)!;
      expect(updated.status).toBe("failed");
      expect(updated.errorCode).toBe("ai_auth_failed");
    });

    // F1b (decisions/0020-universal-intake.md, decisions/0022-intake-wiring.md): the
    // non-OCR intake branches - camt.053 (self-identifying, always confirmed), a tabular
    // source with a known confirmed fingerprint (no model call), and an unknown tabular
    // source (a stored proposal).
    describe("intake branching (F1b)", () => {
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
      </Ntry>
    </Stmt>
  </BkToCstmrStmt>
</Document>`;

      const MUSTERBANK_CSV = [
        "Buchungsdatum;Wertstellung;Betrag;Währung;Empfänger/Auftraggeber;IBAN;Verwendungszweck",
        "15.01.2026;15.01.2026;100,00;EUR;Kunde AG;DE89370400440532013000;Rechnung 1",
        "16.01.2026;16.01.2026;-50,00;EUR;Lieferant GmbH;DE12500105170648489890;Bestellung 2",
      ].join("\n");

      function textBytes(input: string): Uint8Array {
        return new TextEncoder().encode(input);
      }

      it("parses a camt.053 XML deterministically, no classifier call, always confirmed", async () => {
        const workspace = workspaceRow({ name: "Muster GmbH" });
        const doc = documentRow({
          workspaceId: workspace.id,
          storageKey: `workspaces/${workspace.id}/documents/d1/original.xml`,
          mimeType: "application/xml",
          originalFileName: "kontoauszug.xml",
        });
        const classifierClassify = vi.fn();
        const { useCases, documentState, storage } = setup({
          workspaces: [workspace],
          documents: [doc],
          intakeClassifier: { classify: classifierClassify },
        });
        await storage.putObject({ key: doc.storageKey, body: textBytes(CAMT_053_XML), contentType: "application/xml" });

        await useCases.processDocument({ workspaceId: workspace.id, documentId: doc.id });

        const updated = documentState.find((d) => d.id === doc.id)!;
        expect(updated.status).toBe("done");
        expect(updated.kind).toBe("bank_statement");
        expect(updated.intakeStatus).toBe("confirmed");
        expect(updated.intakeResult).toMatchObject({ type: "bank_statement", transactionCount: 1 });
        expect(classifierClassify).not.toHaveBeenCalled();
      });

      // decisions/0028-mt940-support.md: a minimal, realistic MT940 statement - treated
      // exactly like camt.053 (deterministic parse, no classifier call, always confirmed).
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

      it("parses an MT940 statement deterministically, no classifier call, always confirmed", async () => {
        const workspace = workspaceRow({ name: "Muster GmbH" });
        const doc = documentRow({
          workspaceId: workspace.id,
          storageKey: `workspaces/${workspace.id}/documents/d1/original.mt940`,
          mimeType: MT940_MIME_TYPE,
          originalFileName: "kontoauszug.mt940",
        });
        const classifierClassify = vi.fn();
        const { useCases, documentState, storage } = setup({
          workspaces: [workspace],
          documents: [doc],
          intakeClassifier: { classify: classifierClassify },
        });
        await storage.putObject({ key: doc.storageKey, body: textBytes(MT940_STATEMENT), contentType: MT940_MIME_TYPE });

        await useCases.processDocument({ workspaceId: workspace.id, documentId: doc.id });

        const updated = documentState.find((d) => d.id === doc.id)!;
        expect(updated.status).toBe("done");
        expect(updated.kind).toBe("bank_statement");
        expect(updated.intakeStatus).toBe("confirmed");
        expect(updated.intakeResult).toMatchObject({ type: "bank_statement", transactionCount: 1, allStatementsReconcile: true });
        expect(classifierClassify).not.toHaveBeenCalled();
      });

      it("enqueues the import-account-transactions job for a confirmed MT940 statement", async () => {
        const workspace = workspaceRow({ name: "Muster GmbH" });
        const doc = documentRow({
          workspaceId: workspace.id,
          storageKey: `workspaces/${workspace.id}/documents/d1/original.mt940`,
          mimeType: MT940_MIME_TYPE,
          originalFileName: "kontoauszug.mt940",
        });
        const { useCases, jobState, storage } = setup({ workspaces: [workspace], documents: [doc] });
        await storage.putObject({ key: doc.storageKey, body: textBytes(MT940_STATEMENT), contentType: MT940_MIME_TYPE });

        await useCases.processDocument({ workspaceId: workspace.id, documentId: doc.id });

        const importJobs = jobState.filter((j) => j.kind === "import-account-transactions");
        expect(importJobs).toHaveLength(1);
        expect(importJobs[0]?.payload).toMatchObject({ documentId: doc.id });
      });

      it("marks a document permanently failed with unrecognized_mt940_format when the stored bytes no longer parse as MT940", async () => {
        const workspace = workspaceRow({ name: "Muster GmbH" });
        const doc = documentRow({
          workspaceId: workspace.id,
          storageKey: `workspaces/${workspace.id}/documents/d1/original.mt940`,
          mimeType: MT940_MIME_TYPE,
          originalFileName: "kontoauszug.mt940",
        });
        const { useCases, documentState, storage } = setup({ workspaces: [workspace], documents: [doc] });
        await storage.putObject({ key: doc.storageKey, body: textBytes("not mt940 at all"), contentType: MT940_MIME_TYPE });

        await expect(useCases.processDocument({ workspaceId: workspace.id, documentId: doc.id })).rejects.toBeInstanceOf(PermanentJobError);

        const updated = documentState.find((d) => d.id === doc.id)!;
        expect(updated.status).toBe("failed");
        expect(updated.errorCode).toBe("unrecognized_mt940_format");
      });

      it("applies a known confirmed fingerprint's mapping WITHOUT calling the classifier (fingerprint precedence)", async () => {
        const workspace = workspaceRow({ name: "Muster GmbH" });
        const doc = documentRow({
          workspaceId: workspace.id,
          storageKey: `workspaces/${workspace.id}/documents/d1/original.csv`,
          mimeType: "text/csv",
          originalFileName: "musterbank.csv",
        });

        const classifierClassify = vi.fn(async () => {
          throw new Error("the classifier must never be called once a fingerprint is confirmed");
        });
        const { useCases, documentState, storage, intakeFingerprintState } = setup({
          workspaces: [workspace],
          documents: [doc],
          intakeClassifier: { classify: classifierClassify },
          intakeFingerprints: [
            {
              id: "fp1",
              workspaceId: workspace.id,
              // The real fingerprint for this exact file's header/delimiter layout (never
              // hand-typed) - a match here is only possible because it agrees with what
              // `processTabularDocument` computes from the same text.
              fingerprint: sampleTabular(MUSTERBANK_CSV).fingerprint,
              documentKind: "bank_statement",
              platform: null,
              columnMapping: { bookingDate: "Buchungsdatum", amount: "Betrag", currency: "Währung", counterpartyName: "Empfänger/Auftraggeber" },
              amountSign: { mode: "signed_column", column: "Betrag" },
              confirmedByUserId: "admin1",
              confirmedAt: new Date(0),
              lastUsedAt: new Date(0),
              useCount: 3,
            },
          ],
        });
        await storage.putObject({ key: doc.storageKey, body: textBytes(MUSTERBANK_CSV), contentType: "text/csv" });

        await useCases.processDocument({ workspaceId: workspace.id, documentId: doc.id });

        const updated = documentState.find((d) => d.id === doc.id)!;
        expect(updated.status).toBe("done");
        expect(updated.kind).toBe("bank_statement");
        expect(updated.intakeStatus).toBe("confirmed");
        expect(classifierClassify).not.toHaveBeenCalled();
        // The fingerprint's own usage counter is bumped on every match.
        expect(intakeFingerprintState[0]?.useCount).toBe(4);
      });

      it("stores a pending_confirmation proposal for an unrecognized tabular source, via the classifier", async () => {
        const workspace = workspaceRow({ name: "Muster GmbH" });
        const doc = documentRow({
          workspaceId: workspace.id,
          storageKey: `workspaces/${workspace.id}/documents/d1/original.csv`,
          mimeType: "text/csv",
          originalFileName: "musterbank.csv",
        });
        const { useCases, documentState, storage } = setup({ workspaces: [workspace], documents: [doc] });
        await storage.putObject({ key: doc.storageKey, body: textBytes(MUSTERBANK_CSV), contentType: "text/csv" });

        await useCases.processDocument({ workspaceId: workspace.id, documentId: doc.id });

        const updated = documentState.find((d) => d.id === doc.id)!;
        expect(updated.status).toBe("done");
        expect(updated.kind).toBe("bank_statement");
        expect(updated.intakeStatus).toBe("pending_confirmation");
        expect(updated.intakeResult).toMatchObject({
          type: "tabular_proposal",
          documentKind: "bank_statement",
          validation: { ok: true },
        });
      });
    });
  });

  describe("confirmIntake / rejectIntake (F1b)", () => {
    const MUSTERBANK_CSV = [
      "Buchungsdatum;Wertstellung;Betrag;Währung;Empfänger/Auftraggeber;IBAN;Verwendungszweck",
      "15.01.2026;15.01.2026;100,00;EUR;Kunde AG;DE89370400440532013000;Rechnung 1",
    ].join("\n");

    function textBytes(input: string): Uint8Array {
      return new TextEncoder().encode(input);
    }

    async function setupPendingProposal() {
      const workspace = workspaceRow({ name: "Muster GmbH" });
      const doc = documentRow({
        workspaceId: workspace.id,
        storageKey: `workspaces/${workspace.id}/documents/d1/original.csv`,
        mimeType: "text/csv",
        originalFileName: "musterbank.csv",
      });
      const setupResult = setup({ workspaces: [workspace], documents: [doc] });
      await setupResult.storage.putObject({ key: doc.storageKey, body: textBytes(MUSTERBANK_CSV), contentType: "text/csv" });
      await setupResult.useCases.processDocument({ workspaceId: workspace.id, documentId: doc.id });
      return { workspace, doc, ...setupResult };
    }

    it("confirms a valid mapping, persists the normalized rows, and saves the fingerprint", async () => {
      const { workspace, doc, useCases, documentState, intakeFingerprintState } = await setupPendingProposal();

      const confirmed = await useCases.confirmIntake({
        workspaceId: workspace.id,
        documentId: doc.id,
        actingUserId: "admin1",
        documentKind: "bank_statement",
        platform: null,
        mapping: { bookingDate: "Buchungsdatum", amount: "Betrag", currency: "Währung", counterpartyName: "Empfänger/Auftraggeber" },
        amountSign: { mode: "signed_column", column: "Betrag" },
      });

      expect(confirmed.intakeStatus).toBe("confirmed");
      expect(confirmed.intakeResult).toMatchObject({ type: "tabular_confirmed", rowCount: 1 });
      const updated = documentState.find((d) => d.id === doc.id)!;
      expect(updated.intakeStatus).toBe("confirmed");
      expect(intakeFingerprintState).toHaveLength(1);
      expect(intakeFingerprintState[0]).toMatchObject({ workspaceId: workspace.id, documentKind: "bank_statement", confirmedByUserId: "admin1" });
    });

    it("rejects confirmation of a mapping that does not validate, with MappingValidationError", async () => {
      const { workspace, doc, useCases, intakeFingerprintState } = await setupPendingProposal();

      await expect(
        useCases.confirmIntake({
          workspaceId: workspace.id,
          documentId: doc.id,
          actingUserId: "admin1",
          documentKind: "bank_statement",
          platform: null,
          // "Nicht-Existent" is not a real column in the file - every row fails.
          mapping: { bookingDate: "Nicht-Existent" },
          amountSign: null,
        }),
      ).rejects.toBeInstanceOf(MappingValidationError);
      // A failed confirmation never saves a fingerprint.
      expect(intakeFingerprintState).toHaveLength(0);
    });

    it("rejects confirming/rejecting a document that is not pending_confirmation", async () => {
      const workspace = workspaceRow({ name: "Muster GmbH" });
      const doc = documentRow({ workspaceId: workspace.id, storageKey: `workspaces/${workspace.id}/documents/d1/original.pdf` });
      const { useCases } = setup({ workspaces: [workspace], documents: [doc] });

      await expect(
        useCases.confirmIntake({
          workspaceId: workspace.id,
          documentId: doc.id,
          actingUserId: null,
          documentKind: "bank_statement",
          platform: null,
          mapping: {},
          amountSign: null,
        }),
      ).rejects.toMatchObject({ code: DOCUMENT_ERROR.intakeNotPending });
      await expect(useCases.rejectIntake({ workspaceId: workspace.id, documentId: doc.id })).rejects.toMatchObject({
        code: DOCUMENT_ERROR.intakeNotPending,
      });
    });

    it("rejects a proposal: intakeStatus becomes rejected, nothing is imported", async () => {
      const { workspace, doc, useCases, documentState } = await setupPendingProposal();

      const rejected = await useCases.rejectIntake({ workspaceId: workspace.id, documentId: doc.id });

      expect(rejected.intakeStatus).toBe("rejected");
      const updated = documentState.find((d) => d.id === doc.id)!;
      expect(updated.intakeStatus).toBe("rejected");
    });
  });

  describe("retryProcessing", () => {
    it("rejects retrying a document that is not currently failed", async () => {
      const workspace = workspaceRow({ name: "Muster GmbH" });
      const doc = documentRow({ workspaceId: workspace.id, storageKey: `workspaces/${workspace.id}/documents/d1/original.pdf`, status: "done" });
      const { useCases } = setup({ workspaces: [workspace], documents: [doc] });

      await expect(useCases.retryProcessing({ workspaceId: workspace.id, documentId: doc.id })).rejects.toMatchObject({
        code: DOCUMENT_ERROR.retryNotAllowed,
      });
    });

    it("re-enqueues processing and resets status/errorCode for a failed document", async () => {
      const workspace = workspaceRow({ name: "Muster GmbH" });
      const doc = documentRow({
        workspaceId: workspace.id,
        storageKey: `workspaces/${workspace.id}/documents/d1/original.pdf`,
        status: "failed",
        errorCode: "ai_timeout",
      });
      const { useCases, documentState, jobState } = setup({ workspaces: [workspace], documents: [doc] });

      await useCases.retryProcessing({ workspaceId: workspace.id, documentId: doc.id });

      const updated = documentState.find((d) => d.id === doc.id)!;
      expect(updated.status).toBe("processing");
      expect(updated.errorCode).toBeNull();
      expect(jobState.filter((j) => j.kind === "process-document")).toHaveLength(1);
    });

    it("rejects retrying a document that does not exist", async () => {
      const { useCases } = setup();
      await expect(useCases.retryProcessing({ workspaceId: "w1", documentId: crypto.randomUUID() })).rejects.toMatchObject({
        code: DOCUMENT_ERROR.notFound,
      });
    });
  });
  // decisions/0072-correcting-a-document-s-kind.md: "Dokumentart ändern".
  describe("reclassifyDocument", () => {
    function processedPdf(workspaceId: string, overrides: Partial<Parameters<typeof documentRow>[0]> = {}) {
      return documentRow({
        workspaceId,
        storageKey: `workspaces/${workspaceId}/documents/d1/original.pdf`,
        status: "done",
        kind: "other",
        mimeType: "application/pdf",
        ...overrides,
      });
    }

    it("marks a processed PDF processing and enqueues process-document with the forced kind, in one transaction", async () => {
      const workspace = workspaceRow({ name: "Muster GmbH" });
      const doc = processedPdf(workspace.id, { paymentStatus: "open" });
      // An open suggestion never blocks: it is cleared through the payments owner afterwards.
      const suggestion = documentTransactionRow({ workspaceId: workspace.id, documentId: doc.id, transactionId: crypto.randomUUID(), status: "suggested" });
      const { useCases, documentState, jobState, documentTransactionState } = setup({ workspaces: [workspace], documents: [doc], documentTransactions: [suggestion] });

      await useCases.reclassifyDocument({ workspaceId: workspace.id, documentId: doc.id, kind: "incoming_invoice" });

      expect(documentState.find((d) => d.id === doc.id)!.status).toBe("processing");
      // Stored on the document, so a later retry keeps the correction.
      expect(documentState.find((d) => d.id === doc.id)!.manualKind).toBe("incoming_invoice");
      const jobs = jobState.filter((j) => j.kind === "process-document");
      expect(jobs).toHaveLength(1);
      expect(jobs[0]!.payload).toEqual({ workspaceId: workspace.id, documentId: doc.id, kindOverride: "incoming_invoice" });
      // The documents use case never writes `document_transactions` itself.
      expect(documentTransactionState).toHaveLength(1);
    });

    it("rejects a document that does not exist in this workspace", async () => {
      const workspace = workspaceRow({ name: "Muster GmbH" });
      const other = workspaceRow({ name: "Fremde GmbH" });
      const doc = processedPdf(other.id);
      const { useCases } = setup({ workspaces: [workspace, other], documents: [doc] });

      await expect(useCases.reclassifyDocument({ workspaceId: workspace.id, documentId: doc.id, kind: "incoming_invoice" })).rejects.toMatchObject({
        code: DOCUMENT_ERROR.notFound,
      });
    });

    it.each([
      { label: "a camt.053 upload", overrides: { mimeType: "application/xml", kind: "bank_statement" as const } },
      { label: "a CSV upload", overrides: { mimeType: "text/csv", kind: "other" as const } },
      { label: "a PDF still processing", overrides: { status: "processing" as const } },
      { label: "a failed PDF", overrides: { status: "failed" as const } },
    ])("rejects $label with reclassify_not_allowed", async ({ overrides }) => {
      const workspace = workspaceRow({ name: "Muster GmbH" });
      const doc = processedPdf(workspace.id, overrides);
      const { useCases, jobState } = setup({ workspaces: [workspace], documents: [doc] });

      await expect(useCases.reclassifyDocument({ workspaceId: workspace.id, documentId: doc.id, kind: "incoming_invoice" })).rejects.toMatchObject({
        code: DOCUMENT_ERROR.reclassifyNotAllowed,
      });
      expect(jobState).toHaveLength(0);
    });

    it("rejects an account-feeding kind with kind_not_selectable", async () => {
      const workspace = workspaceRow({ name: "Muster GmbH" });
      const doc = processedPdf(workspace.id);
      const { useCases } = setup({ workspaces: [workspace], documents: [doc] });

      for (const kind of ["bank_statement", "payout_report", "platform_settlement"] as const) {
        await expect(useCases.reclassifyDocument({ workspaceId: workspace.id, documentId: doc.id, kind })).rejects.toMatchObject({
          code: DOCUMENT_ERROR.kindNotSelectable,
        });
      }
    });

    it("rejects the kind the document already has with kind_unchanged", async () => {
      const workspace = workspaceRow({ name: "Muster GmbH" });
      const doc = processedPdf(workspace.id, { kind: "incoming_invoice" });
      const { useCases } = setup({ workspaces: [workspace], documents: [doc] });

      await expect(useCases.reclassifyDocument({ workspaceId: workspace.id, documentId: doc.id, kind: "incoming_invoice" })).rejects.toMatchObject({
        code: DOCUMENT_ERROR.kindUnchanged,
      });
    });

    it("corrects a PDF the classifier labeled platform_settlement away from it", async () => {
      const workspace = workspaceRow({ name: "Muster GmbH" });
      const doc = processedPdf(workspace.id, { kind: "platform_settlement", paymentStatus: "no_document_needed" });
      const { useCases, jobState } = setup({ workspaces: [workspace], documents: [doc] });

      await useCases.reclassifyDocument({ workspaceId: workspace.id, documentId: doc.id, kind: "incoming_invoice" });

      expect(jobState.filter((j) => j.kind === "process-document")).toHaveLength(1);
    });

    it("rejects a document with a confirmed payment link with payment_linked, leaving it untouched", async () => {
      const workspace = workspaceRow({ name: "Muster GmbH" });
      const doc = processedPdf(workspace.id, { kind: "incoming_invoice", paymentStatus: "paid" });
      const confirmed = documentTransactionRow({ workspaceId: workspace.id, documentId: doc.id, transactionId: crypto.randomUUID(), status: "confirmed" });
      const { useCases, documentState, jobState } = setup({ workspaces: [workspace], documents: [doc], documentTransactions: [confirmed] });

      await expect(useCases.reclassifyDocument({ workspaceId: workspace.id, documentId: doc.id, kind: "receipt" })).rejects.toMatchObject({
        code: DOCUMENT_ERROR.paymentLinked,
      });
      expect(documentState.find((d) => d.id === doc.id)!.status).toBe("done");
      expect(jobState).toHaveLength(0);
    });

    it("rejects a document a clearing account settled with payment_settled", async () => {
      const workspace = workspaceRow({ name: "Muster GmbH" });
      const doc = processedPdf(workspace.id, { kind: "incoming_invoice", paymentStatus: "settled" });
      const { useCases, jobState } = setup({ workspaces: [workspace], documents: [doc] });

      await expect(useCases.reclassifyDocument({ workspaceId: workspace.id, documentId: doc.id, kind: "letter" })).rejects.toMatchObject({
        code: DOCUMENT_ERROR.paymentSettled,
      });
      expect(jobState).toHaveLength(0);
    });
  });

  describe("processDocument with kindOverride (decisions/0072)", () => {
    async function pdfFixture(): Promise<Uint8Array> {
      const doc = await PDFDocument.create();
      doc.addPage([595.28, 841.89]);
      return doc.save();
    }

    function classifierReturning(documentKind: string) {
      return vi.fn().mockResolvedValue({ documentKind, confidence: 0.9, reason: "test", platform: null, columnMapping: null, amountSign: null });
    }

    it("keeps a stored manual kind on a later run without an override (a retry never undoes the correction)", async () => {
      const workspace = workspaceRow({ name: "Muster GmbH" });
      const pdfBytes = await pdfFixture();
      const doc = documentRow({
        workspaceId: workspace.id,
        storageKey: `workspaces/${workspace.id}/documents/d1/original.pdf`,
        originalFileName: "rechnung-telekom.pdf",
        status: "processing",
        kind: "incoming_invoice",
        manualKind: "incoming_invoice",
      });
      const classify = classifierReturning("other");
      const { useCases, documentState, storage } = setup({ workspaces: [workspace], documents: [doc], intakeClassifier: { classify } });
      await storage.putObject({ key: doc.storageKey, body: pdfBytes, contentType: "application/pdf" });

      await useCases.processDocument({ workspaceId: workspace.id, documentId: doc.id });

      expect(classify).not.toHaveBeenCalled();
      expect(documentState.find((d) => d.id === doc.id)!.kind).toBe("incoming_invoice");
    });

    it("uses the forced kind instead of asking the classifier, and runs the normal extraction for it", async () => {
      const workspace = workspaceRow({ name: "Muster GmbH" });
      const pdfBytes = await pdfFixture();
      const doc = documentRow({
        workspaceId: workspace.id,
        storageKey: `workspaces/${workspace.id}/documents/d1/original.pdf`,
        originalFileName: "rechnung-telekom.pdf",
        status: "processing",
        kind: "other",
      });
      const classify = classifierReturning("other");
      const analyzer = createFakeDocumentAnalyzer();
      const analyzeGuided = vi.spyOn(analyzer, "analyzeGuided");
      const { useCases, documentState, storage, jobState, documentContactState } = setup({
        workspaces: [workspace],
        documents: [doc],
        analyzer,
        intakeClassifier: { classify },
      });
      await storage.putObject({ key: doc.storageKey, body: pdfBytes, contentType: "application/pdf" });

      await useCases.processDocument({ workspaceId: workspace.id, documentId: doc.id, kindOverride: "incoming_invoice" });

      expect(classify).not.toHaveBeenCalled();
      expect(analyzeGuided).toHaveBeenCalledWith(expect.objectContaining({ kind: "incoming_invoice", plan: expect.objectContaining({ mode: "derived", ourRole: "recipient" }) }));
      const updated = documentState.find((d) => d.id === doc.id)!;
      expect(updated.status).toBe("done");
      expect(updated.kind).toBe("incoming_invoice");
      expect(updated.direction).toBe("incoming");
      expect(updated.totalAmountCents).toBe(4999);
      expect(updated.paymentStatus).toBe("open");
      // Invoice-shaped again, so the debounced matching run is scheduled exactly as on a normal run.
      expect(jobState.filter((j) => j.kind === "match-payments")).toHaveLength(1);
      expect(documentContactState).toEqual([expect.objectContaining({ documentId: doc.id, role: "sender" })]);
    });

    it("never flips a forced incoming_invoice by the own-IBAN heuristic that flips a classified one", async () => {
      // The Telekom fixture's verified payment IBAN, declared as our own: a CLASSIFIED
      // incoming_invoice paying into our own account is flipped to outgoing (decisions/0039).
      const workspace = workspaceRow({ name: "Muster GmbH", companyIbans: ["DE12500105170648489890"] });
      const pdfBytes = await pdfFixture();
      const makeDoc = () =>
        documentRow({
          workspaceId: workspace.id,
          storageKey: `workspaces/${workspace.id}/documents/d1/original.pdf`,
          originalFileName: "rechnung-telekom.pdf",
          status: "processing",
        });

      const classifiedDoc = makeDoc();
      const classified = setup({ workspaces: [workspace], documents: [classifiedDoc], intakeClassifier: { classify: classifierReturning("incoming_invoice") } });
      await classified.storage.putObject({ key: classifiedDoc.storageKey, body: pdfBytes, contentType: "application/pdf" });
      await classified.useCases.processDocument({ workspaceId: workspace.id, documentId: classifiedDoc.id });
      expect(classified.documentState[0]!.kind).toBe("outgoing_invoice");

      const forcedDoc = makeDoc();
      const forced = setup({ workspaces: [workspace], documents: [forcedDoc], intakeClassifier: { classify: classifierReturning("incoming_invoice") } });
      await forced.storage.putObject({ key: forcedDoc.storageKey, body: pdfBytes, contentType: "application/pdf" });
      await forced.useCases.processDocument({ workspaceId: workspace.id, documentId: forcedDoc.id, kindOverride: "incoming_invoice" });
      expect(forced.documentState[0]!.kind).toBe("incoming_invoice");
      expect(forced.documentState[0]!.direction).toBe("incoming");
    });

    it("a kind that is no longer invoice-shaped resets the payment status and schedules no matching", async () => {
      const workspace = workspaceRow({ name: "Muster GmbH" });
      const pdfBytes = await pdfFixture();
      const doc = documentRow({
        workspaceId: workspace.id,
        storageKey: `workspaces/${workspace.id}/documents/d1/original.pdf`,
        originalFileName: "rechnung-telekom.pdf",
        status: "processing",
        kind: "incoming_invoice",
        paymentStatus: "open",
      });
      const { useCases, documentState, storage, jobState } = setup({ workspaces: [workspace], documents: [doc] });
      await storage.putObject({ key: doc.storageKey, body: pdfBytes, contentType: "application/pdf" });

      await useCases.processDocument({ workspaceId: workspace.id, documentId: doc.id, kindOverride: "reminder" });

      const updated = documentState.find((d) => d.id === doc.id)!;
      expect(updated.kind).toBe("reminder");
      expect(updated.paymentStatus).toBe("not_applicable");
      expect(jobState.filter((j) => j.kind === "match-payments")).toHaveLength(0);
    });
  });
});
