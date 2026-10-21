// Real Postgres (WEBAPP_TEMPLATE_SPEC.md §10.1/§10.3): proves
// `upsertFromExtraction`'s unique-violation retry actually resolves a real race, not only
// asserted against a fake (which cannot reproduce a genuine unique-constraint violation
// across two concurrent transactions). decisions/0019-contacts.md's concurrency guarantee:
// two parallel `upsertFromExtraction` calls for the same never-seen-before VAT id must end
// with exactly one contact.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { getDb } from "@/persistence/foundation/client";
import { createDrizzleRepositories } from "@/persistence/repositories/drizzle/create-repositories";
import { createDrizzleUnitOfWork } from "@/persistence/repositories/drizzle/unit-of-work";
import { createDrizzleDocumentRepository } from "@/persistence/repositories/drizzle/documents-repository";
import { createDrizzleWorkspaceRepository } from "@/persistence/repositories/drizzle/workspaces-repository";
import { contacts } from "@/persistence/schema/contacts";
import { createContactUseCases } from "@/persistence/use-cases/contacts-use-cases";

const db = getDb();

async function createTestWorkspace(name: string) {
  return createDrizzleWorkspaceRepository(db).create({ name });
}

async function createTestDocument(workspaceId: string, suffix: string) {
  return createDrizzleDocumentRepository(db).create({
    id: randomUUID(),
    workspaceId,
    uploadedByUserId: null,
    originalFileName: `race-${suffix}.pdf`,
    mimeType: "application/pdf",
    pageCount: 1,
    sizeBytes: 1,
    storageKey: `k-${suffix}-${randomUUID()}`,
    fileHash: randomUUID(),
  });
}

describe("upsertFromExtraction concurrency", () => {
  it("two concurrent upserts for the same vat id end with exactly one contact", async () => {
    const workspace = await createTestWorkspace("Contacts Concurrency Co");
    const repos = createDrizzleRepositories(db);
    const uow = createDrizzleUnitOfWork(db);
    const useCases = createContactUseCases({ repos, uow });

    const [docA, docB] = await Promise.all([createTestDocument(workspace.id, "a"), createTestDocument(workspace.id, "b")]);

    const [resultA, resultB] = await Promise.all([
      useCases.upsertFromExtraction({
        workspaceId: workspace.id,
        documentId: docA.id,
        role: "sender",
        extracted: { name: "Rennwerk GmbH", vatId: "DE123456789" },
      }),
      useCases.upsertFromExtraction({
        workspaceId: workspace.id,
        documentId: docB.id,
        role: "sender",
        extracted: { name: "Rennwerk GmbH", vatId: "DE123456789" },
      }),
    ]);

    expect(resultA.contactId).toBe(resultB.contactId);
    // Exactly one of the two calls actually inserted the row; the other matched it, whether
    // on its first attempt or via the unique-violation retry, depending on scheduling.
    expect([resultA.created, resultB.created].filter(Boolean)).toHaveLength(1);

    const rows = await db.select().from(contacts).where(eq(contacts.workspaceId, workspace.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].vatIdNormalized).toBe("DE123456789");

    const links = await repos.documentContact.listForContact(workspace.id, rows[0].id);
    expect(links.map((l) => l.documentId).sort()).toEqual([docA.id, docB.id].sort());
  });

  it("two concurrent upserts with no shared identifying key create two separate contacts (a known, accepted limitation - weak matches have no DB-level dedication)", async () => {
    const workspace = await createTestWorkspace("Weak Match Race Co");
    const repos = createDrizzleRepositories(db);
    const uow = createDrizzleUnitOfWork(db);
    const useCases = createContactUseCases({ repos, uow });

    const [docA, docB] = await Promise.all([createTestDocument(workspace.id, "c"), createTestDocument(workspace.id, "d")]);

    await Promise.all([
      useCases.upsertFromExtraction({ workspaceId: workspace.id, documentId: docA.id, role: "sender", extracted: { name: "Ohne Vat GmbH" } }),
      useCases.upsertFromExtraction({ workspaceId: workspace.id, documentId: docB.id, role: "sender", extracted: { name: "Ohne Vat GmbH" } }),
    ]);

    const rows = await db.select().from(contacts).where(eq(contacts.workspaceId, workspace.id));
    expect(rows).toHaveLength(2);
  });
});
