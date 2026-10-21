// Real Postgres (WEBAPP_TEMPLATE_SPEC.md §10.1/§10.3): proves what a fake cannot -
// `replaceDocumentLinks`'s remove-and-rewrite runs as one real transaction against a real
// document/contact/document_contacts state, and its workspace scope (`document_not_found`
// for a document id from another workspace) is enforced against the real
// `DocumentRepository.findById`, not only asserted with an in-memory fake.
// `src/persistence/tests/contacts-use-cases.test.ts`'s own `replaceDocumentLinks` describe
// block (fakes) covers the full behaviour matrix (bank/own-company skipping, own-IBAN
// stripping, one-role-per-contact, relationType) - this file only proves the parts that
// need a real database.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { getDb } from "@/persistence/foundation/client";
import { createDrizzleRepositories } from "@/persistence/repositories/drizzle/create-repositories";
import { createDrizzleUnitOfWork } from "@/persistence/repositories/drizzle/unit-of-work";
import { createDrizzleDocumentRepository } from "@/persistence/repositories/drizzle/documents-repository";
import { createDrizzleWorkspaceRepository } from "@/persistence/repositories/drizzle/workspaces-repository";
import { CONTACT_ERROR, createContactUseCases } from "@/persistence/use-cases/contacts-use-cases";
import { UseCaseError } from "@/persistence/use-cases/errors";

const db = getDb();

async function createTestWorkspace(name: string) {
  return createDrizzleWorkspaceRepository(db).create({ name });
}

async function createTestDocument(workspaceId: string, suffix: string) {
  return createDrizzleDocumentRepository(db).create({
    id: randomUUID(),
    workspaceId,
    uploadedByUserId: null,
    originalFileName: `replace-${suffix}.pdf`,
    mimeType: "application/pdf",
    pageCount: 1,
    sizeBytes: 1,
    storageKey: `k-${suffix}-${randomUUID()}`,
    fileHash: randomUUID(),
  });
}

describe("replaceDocumentLinks against real Postgres", () => {
  it("removes and rewrites a document's links in one transaction", async () => {
    const workspace = await createTestWorkspace("Replace Links Co");
    const repos = createDrizzleRepositories(db);
    const uow = createDrizzleUnitOfWork(db);
    const useCases = createContactUseCases({ repos, uow });
    const document = await createTestDocument(workspace.id, "1");

    const firstRun = await useCases.replaceDocumentLinks({
      workspaceId: workspace.id,
      documentId: document.id,
      ownCompany: null,
      ownIbans: [],
      parties: [{ role: "sender", relationType: "supplier", extracted: { name: "Erster Lauf GmbH", vatId: "DE111111111" } }],
    });
    expect(firstRun.linked).toBe(1);
    expect(await repos.documentContact.listForDocument(workspace.id, document.id)).toHaveLength(1);

    const secondRun = await useCases.replaceDocumentLinks({
      workspaceId: workspace.id,
      documentId: document.id,
      ownCompany: null,
      ownIbans: [],
      parties: [{ role: "sender", relationType: "supplier", extracted: { name: "Zweiter Lauf GmbH", vatId: "DE222222222" } }],
    });
    expect(secondRun.linked).toBe(1);

    const linksAfter = await repos.documentContact.listForDocument(workspace.id, document.id);
    expect(linksAfter).toHaveLength(1);
    expect(linksAfter[0].contactName).toBe("Zweiter Lauf GmbH");
  });

  it("is workspace-scoped: a document id from another workspace throws document_not_found and removes nothing", async () => {
    const workspaceA = await createTestWorkspace("Replace Scope A");
    const workspaceB = await createTestWorkspace("Replace Scope B");
    const repos = createDrizzleRepositories(db);
    const uow = createDrizzleUnitOfWork(db);
    const useCases = createContactUseCases({ repos, uow });
    const document = await createTestDocument(workspaceA.id, "2");

    await useCases.replaceDocumentLinks({
      workspaceId: workspaceA.id,
      documentId: document.id,
      ownCompany: null,
      ownIbans: [],
      parties: [{ role: "sender", relationType: "supplier", extracted: { name: "Vorhandene GmbH", vatId: "DE333333333" } }],
    });

    // `document` genuinely exists and is genuinely linked - only `workspaceB` is the wrong
    // workspace for it.
    await expect(
      useCases.replaceDocumentLinks({
        workspaceId: workspaceB.id,
        documentId: document.id,
        ownCompany: null,
        ownIbans: [],
        parties: [{ role: "sender", relationType: "supplier", extracted: { name: "Angreifer GmbH" } }],
      }),
    ).rejects.toThrow(new UseCaseError(CONTACT_ERROR.documentNotFound));

    // The existing link from workspace A is untouched by the rejected cross-workspace call.
    expect(await repos.documentContact.listForDocument(workspaceA.id, document.id)).toHaveLength(1);
  });
});
