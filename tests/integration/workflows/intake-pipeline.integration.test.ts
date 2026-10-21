// Owner-crossing integration test (WEBAPP_TEMPLATE_SPEC.md §10.1) for F1b's universal-intake
// wiring (decisions/0020-universal-intake.md, decisions/0022-intake-wiring.md): uploads
// through the real `POST /api/documents` route handler (real Postgres + real MinIO), reusing
// F1a's own fixtures (`src/modules/intake/tests/fixtures/`), then runs the job runner
// directly (`runDueJobs`) with the fake AI provider/classifier. Covers: a camt.053 statement
// (self-identifying, no model call, always confirmed, quota counted once), an unrecognized
// Musterbank-style CSV (a stored proposal via the fake classifier), confirming it (rows stored,
// fingerprint saved), a later file sharing the same fingerprint (confirmed WITHOUT a second
// classifier call), an exact-duplicate upload (rejected before storage), and a malicious XML
// (rejected, nothing stored).
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

import { parseIntakeResult } from "@/modules/documents";
import { getDb } from "@/persistence/foundation/client";
import { getRequestServices } from "@/persistence/composition/request-services";
import { getIntakeClassifier, resetIntakeClassifierForTests } from "@/platform/mistral/server";
import { createDrizzleDocumentRepository } from "@/persistence/repositories/drizzle/documents-repository";
import { createDrizzleIntakeFingerprintRepository } from "@/persistence/repositories/drizzle/intake-fingerprints-repository";
import { createDrizzleWorkspaceMemberRepository, createDrizzleWorkspaceRepository } from "@/persistence/repositories/drizzle/workspaces-repository";
import { user } from "@/persistence/schema/auth";
import { runDueJobs } from "@/platform/jobs/server";

import { POST } from "@/app/api/documents/route";

const FIXTURES_DIR = path.join(process.cwd(), "src/modules/intake/tests/fixtures");

function fixtureBytes(name: string): Buffer {
  return readFileSync(path.join(FIXTURES_DIR, name));
}

async function createTestUser(label: string): Promise<{ id: string; email: string }> {
  const email = `${label}-${randomUUID()}@example.test`;
  const [row] = await getDb().insert(user).values({ name: "Intake Test User", email, emailVerified: false }).returning({ id: user.id });
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

describe("universal intake pipeline (F1b, real Postgres + MinIO, fake AI)", () => {
  it("parses a camt.053 statement deterministically: bank_statement, confirmed, N transactions, quota counted once", async () => {
    const founder = await createTestUser("camt");
    currentUser = founder;
    const workspace = await createWorkspaceForUser(founder.id, "Camt Flow GmbH");

    const bytes = fixtureBytes("camt053-valid.xml");
    const response = await POST(postRequest(uploadForm(bytes, "kontoauszug.xml", "application/xml")), {} as never);
    expect(response.status).toBe(201);
    const { documentId } = (await response.json()) as { documentId: string };

    await runDueJobs({ workspaceId: workspace.id, limit: 5 });

    const documentRepo = createDrizzleDocumentRepository(getDb());
    const processed = await documentRepo.findById(workspace.id, documentId);
    expect(processed?.status).toBe("done");
    expect(processed?.kind).toBe("bank_statement");
    expect(processed?.intakeStatus).toBe("confirmed");
    expect(processed?.intakeResult).toMatchObject({ type: "bank_statement", transactionCount: 8 });

    // "quota counted once": the structured file is one document, not one per transaction.
    expect(await getRequestServices().documents.countStored(workspace.id)).toBe(1);
  });

  it("rejects a repeat upload of the identical bytes with duplicate_document, nothing new stored", async () => {
    const founder = await createTestUser("camt-dup");
    currentUser = founder;
    const workspace = await createWorkspaceForUser(founder.id, "Camt Duplicate GmbH");

    const bytes = fixtureBytes("camt053-valid.xml");
    const first = await POST(postRequest(uploadForm(bytes, "kontoauszug.xml", "application/xml")), {} as never);
    expect(first.status).toBe(201);
    const { documentId } = (await first.json()) as { documentId: string };

    const second = await POST(postRequest(uploadForm(bytes, "kontoauszug-erneut.xml", "application/xml")), {} as never);
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ errorCode: "duplicate_document", existingDocumentId: documentId });

    expect(await getRequestServices().documents.countStored(workspace.id)).toBe(1);
  });

  it("rejects a malicious XML (XXE) with a stable code, nothing stored", async () => {
    const founder = await createTestUser("xxe");
    currentUser = founder;
    const workspace = await createWorkspaceForUser(founder.id, "XXE GmbH");

    const bytes = fixtureBytes("malicious-xxe.xml");
    const response = await POST(postRequest(uploadForm(bytes, "boese.xml", "application/xml")), {} as never);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ errorCode: "unsafe_xml" });
    expect(await getRequestServices().documents.countStored(workspace.id)).toBe(0);
  });

  it(
    "an unrecognized Musterbank-style CSV becomes a pending proposal; confirming stores rows and the fingerprint; " +
      "a later file with the same layout confirms WITHOUT another classifier call",
    async () => {
      // The fake classifier is a `globalThis`-memoized singleton (`get-intake-classifier.ts`) -
      // reset it first so this test's own spy (below) is the one actually bound, regardless
      // of what an earlier test in this same worker process already triggered.
      resetIntakeClassifierForTests();

      const founder = await createTestUser("musterbank");
      currentUser = founder;
      const workspace = await createWorkspaceForUser(founder.id, "Musterbank Flow GmbH");

      const firstCsv = fixtureBytes("musterbank-statement.csv");
      const uploadResponse = await POST(postRequest(uploadForm(firstCsv, "kontoauszug-august.csv", "text/csv")), {} as never);
      expect(uploadResponse.status).toBe(201);
      const { documentId } = (await uploadResponse.json()) as { documentId: string };

      await runDueJobs({ workspaceId: workspace.id, limit: 5 });

      const documentRepo = createDrizzleDocumentRepository(getDb());
      const pending = await documentRepo.findById(workspace.id, documentId);
      expect(pending?.status).toBe("done");
      expect(pending?.intakeStatus).toBe("pending_confirmation");
      expect(pending?.kind).toBe("bank_statement");
      const proposal = parseIntakeResult(pending?.intakeResult);
      if (proposal?.type !== "tabular_proposal") throw new Error("expected a tabular_proposal intake result");

      // Confirm through the real use case (the same call `confirmIntakeAction` makes),
      // using the proposal's own recognized mapping/amountSign.
      const confirmed = await getRequestServices().documents.confirmIntake({
        workspaceId: workspace.id,
        documentId,
        actingUserId: founder.id,
        documentKind: "bank_statement",
        platform: null,
        mapping: proposal.columnMapping,
        amountSign: proposal.amountSign,
      });
      expect(confirmed.intakeStatus).toBe("confirmed");
      expect(confirmed.intakeResult).toMatchObject({ type: "tabular_confirmed", rowCount: 7 });

      const fingerprintRepo = createDrizzleIntakeFingerprintRepository(getDb());
      const fingerprints = await fingerprintRepo.listForWorkspace(workspace.id);
      expect(fingerprints).toHaveLength(1);
      expect(fingerprints[0]).toMatchObject({ documentKind: "bank_statement", confirmedByUserId: founder.id, useCount: 1 });

      // A second file with the SAME header/delimiter layout (a later month's export from the
      // same bank) but different data rows - a different `fileHash`, the same fingerprint.
      const secondCsvText = [
        "Buchungsdatum;Wertstellung;Betrag;Währung;Empfänger/Auftraggeber;IBAN;Verwendungszweck",
        "01.09.2026;01.09.2026;300,00;EUR;Neuer Kunde GmbH;DE45500105172295759744;Rechnung 2001",
      ].join("\n");
      const secondCsv = Buffer.from(secondCsvText, "utf-8");

      const classifySpy = vi.fn();
      const intakeClassifier = getIntakeClassifier();
      const classifySpyRestore = vi.spyOn(intakeClassifier, "classify").mockImplementation(classifySpy);

      try {
        const secondUpload = await POST(postRequest(uploadForm(secondCsv, "kontoauszug-september.csv", "text/csv")), {} as never);
        expect(secondUpload.status).toBe(201);
        const { documentId: secondDocumentId } = (await secondUpload.json()) as { documentId: string };

        await runDueJobs({ workspaceId: workspace.id, limit: 5 });

        const secondDoc = await documentRepo.findById(workspace.id, secondDocumentId);
        expect(secondDoc?.intakeStatus).toBe("confirmed");
        expect(secondDoc?.kind).toBe("bank_statement");
        expect(classifySpy).not.toHaveBeenCalled();

        const usedFingerprints = await fingerprintRepo.listForWorkspace(workspace.id);
        expect(usedFingerprints).toHaveLength(1);
        expect(usedFingerprints[0]?.useCount).toBe(2);
      } finally {
        classifySpyRestore.mockRestore();
      }
    },
  );

  it(
    "accepts a CAMT.053 v08 file uploaded with a bank-specific extension - the server never " +
      "decides acceptance by file name (decisions/0028-mt940-support.md's own bug fix)",
    async () => {
      const founder = await createTestUser("camt-v08");
      currentUser = founder;
      const workspace = await createWorkspaceForUser(founder.id, "Camt V08 GmbH");

      // The real bug report: a Musterbank export named "*.camt053v08" with a generic/absent
      // browser-declared Content-Type - the OLD file-picker `accept` list would have hidden
      // this from the OS dialog before it ever reached here; the route itself never looked at
      // the name or the declared type either way (`sniffFileKind` reads bytes only).
      const bytes = fixtureBytes("camt053-valid.xml").toString("utf-8").replace("camt.053.001.02", "camt.053.001.08");
      const response = await POST(
        postRequest(uploadForm(Buffer.from(bytes, "utf-8"), "OLD_Musterbank_statement_21092026.camt053v08", "application/octet-stream")),
        {} as never,
      );
      expect(response.status).toBe(201);
      const { documentId } = (await response.json()) as { documentId: string };

      await runDueJobs({ workspaceId: workspace.id, limit: 5 });

      const documentRepo = createDrizzleDocumentRepository(getDb());
      const processed = await documentRepo.findById(workspace.id, documentId);
      expect(processed?.status).toBe("done");
      expect(processed?.kind).toBe("bank_statement");
      expect(processed?.intakeStatus).toBe("confirmed");
    },
  );

  describe("MT940 (decisions/0028-mt940-support.md)", () => {
    it("parses an MT940 statement deterministically: bank_statement, confirmed, N transactions, no classifier call", async () => {
      resetIntakeClassifierForTests();
      const founder = await createTestUser("mt940");
      currentUser = founder;
      const workspace = await createWorkspaceForUser(founder.id, "MT940 Flow GmbH");

      const classifySpy = vi.fn();
      const classifySpyRestore = vi.spyOn(getIntakeClassifier(), "classify").mockImplementation(classifySpy);

      try {
        const bytes = fixtureBytes("mt940-valid.mt940");
        const response = await POST(
          postRequest(uploadForm(bytes, "OLD_Musterbank_statement_21092026.mt940", "application/octet-stream")),
          {} as never,
        );
        expect(response.status).toBe(201);
        const { documentId } = (await response.json()) as { documentId: string };

        await runDueJobs({ workspaceId: workspace.id, limit: 5 });

        const documentRepo = createDrizzleDocumentRepository(getDb());
        const processed = await documentRepo.findById(workspace.id, documentId);
        expect(processed?.status).toBe("done");
        expect(processed?.kind).toBe("bank_statement");
        expect(processed?.intakeStatus).toBe("confirmed");
        // The fixture has 2 statements, 4 + 1 transactions.
        expect(processed?.intakeResult).toMatchObject({ type: "bank_statement", statementCount: 2, transactionCount: 5 });
        expect(classifySpy).not.toHaveBeenCalled();

        // "quota counted once": one structured file is one document.
        expect(await getRequestServices().documents.countStored(workspace.id)).toBe(1);
      } finally {
        classifySpyRestore.mockRestore();
      }
    });

    it("rejects a repeat upload of the identical MT940 bytes with duplicate_document", async () => {
      const founder = await createTestUser("mt940-dup");
      currentUser = founder;
      const workspace = await createWorkspaceForUser(founder.id, "MT940 Duplicate GmbH");

      const bytes = fixtureBytes("mt940-valid.mt940");
      const first = await POST(postRequest(uploadForm(bytes, "umsaetze.mt940", "text/plain")), {} as never);
      expect(first.status).toBe(201);
      const { documentId } = (await first.json()) as { documentId: string };

      const second = await POST(postRequest(uploadForm(bytes, "umsaetze-erneut.mt940", "text/plain")), {} as never);
      expect(second.status).toBe(409);
      expect(await second.json()).toEqual({ errorCode: "duplicate_document", existingDocumentId: documentId });

      expect(await getRequestServices().documents.countStored(workspace.id)).toBe(1);
    });

    it("rejects an MT940-shaped file with no parseable transactions with empty_mt940_file, nothing stored", async () => {
      const founder = await createTestUser("mt940-empty");
      currentUser = founder;
      const workspace = await createWorkspaceForUser(founder.id, "MT940 Empty GmbH");

      const bytes = fixtureBytes("mt940-malformed.mt940");
      const response = await POST(postRequest(uploadForm(bytes, "kaputt.mt940", "text/plain")), {} as never);

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ errorCode: "empty_mt940_file" });
      expect(await getRequestServices().documents.countStored(workspace.id)).toBe(0);
    });
  });
});
