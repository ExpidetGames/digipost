// Owner-crossing wiring test (WEBAPP_TEMPLATE_SPEC.md §10.1): proves the real composition
// root's `contacts` use case (`getRequestServices().contacts`) works end to end against real
// Postgres - create a document, run `upsertFromExtraction`, assert the resulting link and
// contact, then a second document from the same sender links to the SAME contact (the whole
// point of matching). `src/persistence/tests/contacts-repository.db.test.ts` and
// `contacts-use-cases-concurrency.db.test.ts` cover the repository/use-case layer directly;
// this test is the one proof that the composition root actually wires it all together.
import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { getDb } from "@/persistence/foundation/client";
import { getRequestServices } from "@/persistence/composition/request-services";
import { createDrizzleDocumentRepository } from "@/persistence/repositories/drizzle/documents-repository";
import { createDrizzleWorkspaceRepository } from "@/persistence/repositories/drizzle/workspaces-repository";

const db = getDb();

async function createTestWorkspace(name: string) {
  return createDrizzleWorkspaceRepository(db).create({ name });
}

async function createTestDocument(workspaceId: string, suffix: string) {
  return createDrizzleDocumentRepository(db).create({
    id: randomUUID(),
    workspaceId,
    uploadedByUserId: null,
    originalFileName: `rechnung-${suffix}.pdf`,
    mimeType: "application/pdf",
    pageCount: 1,
    sizeBytes: 1,
    storageKey: `k-${suffix}-${randomUUID()}`,
    fileHash: randomUUID(),
  });
}

describe("contacts extraction (real composition root, real Postgres)", () => {
  it("upserts a new contact from an extraction and links the document", async () => {
    const services = getRequestServices();
    const workspace = await createTestWorkspace("Extraction Flow Co");
    const document = await createTestDocument(workspace.id, "1");

    const result = await services.contacts.upsertFromExtraction({
      workspaceId: workspace.id,
      documentId: document.id,
      role: "sender",
      extracted: {
        name: "Telekom Deutschland GmbH",
        addressLine1: "Landgrabenweg 151",
        postalCode: "53227",
        city: "Bonn",
        vatId: "DE 813 941 385",
      },
    });

    expect(result.created).toBe(true);
    expect(result.matchStrength).toBeNull();

    const detail = await services.contacts.getById(workspace.id, result.contactId);
    expect(detail.name).toBe("Telekom Deutschland GmbH");
    expect(detail.vatId).toBe("DE 813 941 385");
    expect(detail.source).toBe("auto");
    expect(detail.verifiedAt).toBeNull();
    expect(detail.documents).toEqual([
      expect.objectContaining({ documentId: document.id, role: "sender", originalFileName: "rechnung-1.pdf" }),
    ]);
  });

  it("links a second document from the same sender (matched by vat id) to the SAME contact", async () => {
    const services = getRequestServices();
    const workspace = await createTestWorkspace("Same Sender Co");
    const firstDocument = await createTestDocument(workspace.id, "first");
    const secondDocument = await createTestDocument(workspace.id, "second");

    const first = await services.contacts.upsertFromExtraction({
      workspaceId: workspace.id,
      documentId: firstDocument.id,
      role: "sender",
      extracted: { name: "Musterwerk GmbH", vatId: "DE123456789" },
    });
    const second = await services.contacts.upsertFromExtraction({
      workspaceId: workspace.id,
      documentId: secondDocument.id,
      role: "sender",
      // Same company, differently formatted vat id and a slightly different name spelling -
      // still resolves to the same contact (rule 1: vat id, normalized).
      extracted: { name: "musterwerk", vatId: "DE 123 456 789" },
    });

    expect(second.created).toBe(false);
    expect(second.matchStrength).toBe("strong");
    expect(second.contactId).toBe(first.contactId);

    const detail = await services.contacts.getById(workspace.id, first.contactId);
    expect(detail.documents.map((d) => d.documentId).sort()).toEqual([firstDocument.id, secondDocument.id].sort());

    const listed = await services.contacts.listForWorkspace(workspace.id, { page: 1, pageSize: 10 });
    expect(listed.items.filter((c) => c.id === first.contactId)).toHaveLength(1);
  });
});
