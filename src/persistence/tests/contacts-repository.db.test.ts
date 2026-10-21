// Real Postgres (WEBAPP_TEMPLATE_SPEC.md §10.1/§10.3): proves the properties a fake cannot -
// workspace scoping on every method, the partial unique index on
// `(workspace_id, vat_id_normalized)`, cascading deletes for `document_contacts`, and
// `moveContactLinks`/`moveContactProposals`'s repoint-and-dedupe behavior (`mergeContacts`).
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { getDb } from "@/persistence/foundation/client";
import {
  createDrizzleContactProposalRepository,
  createDrizzleContactRepository,
  createDrizzleDocumentContactRepository,
} from "@/persistence/repositories/drizzle/contacts-repository";
import { createDrizzleDocumentRepository } from "@/persistence/repositories/drizzle/documents-repository";
import { createDrizzleWorkspaceRepository } from "@/persistence/repositories/drizzle/workspaces-repository";
import { user } from "@/persistence/schema/auth";
import { documents } from "@/persistence/schema/documents";

const db = getDb();

async function createTestWorkspace(name: string) {
  return createDrizzleWorkspaceRepository(db).create({ name });
}

async function createTestUser(label = "user"): Promise<{ id: string }> {
  const email = `${label}-${randomUUID()}@example.test`;
  const [row] = await db.insert(user).values({ name: "Test User", email, emailVerified: false }).returning({ id: user.id });
  if (!row) throw new Error("failed to insert test user fixture");
  return { id: row.id };
}

async function createTestDocument(workspaceId: string, suffix: string) {
  return createDrizzleDocumentRepository(db).create({
    id: randomUUID(),
    workspaceId,
    uploadedByUserId: null,
    originalFileName: `dokument-${suffix}.pdf`,
    mimeType: "application/pdf",
    pageCount: 1,
    sizeBytes: 1,
    storageKey: `k-${suffix}-${randomUUID()}`,
    fileHash: randomUUID(),
  });
}

function baseContactFields(overrides: { workspaceId: string; name: string; nameNormalized: string; vatIdNormalized?: string | null }) {
  return {
    legalForm: null,
    addressLine1: null,
    addressLine2: null,
    postalCode: null,
    city: null,
    country: "DE",
    vatId: null,
    taxNumber: null,
    registerCourt: null,
    registerNumber: null,
    leitwegId: null,
    iban: null,
    bic: null,
    bankName: null,
    accountHolder: null,
    sepaCreditorId: null,
    phone: null,
    email: null,
    website: null,
    contactPerson: null,
    customerNumber: null,
    supplierNumber: null,
    paymentTermsDays: null,
    relationType: null,
    notes: null,
    source: "auto" as const,
    verifiedAt: null,
    verifiedByUserId: null,
    firstSeenDocumentId: null,
    vatIdNormalized: null,
    ibanNormalized: null,
    ...overrides,
  };
}

describe("createDrizzleContactRepository", () => {
  it("scopes findById/list/listAllForWorkspace by workspace", async () => {
    const workspaceA = await createTestWorkspace("Contacts Scope A");
    const workspaceB = await createTestWorkspace("Contacts Scope B");
    const repo = createDrizzleContactRepository(db);

    const contact = await repo.create(baseContactFields({ workspaceId: workspaceA.id, name: "Scoped GmbH", nameNormalized: "scoped" }));

    expect(await repo.findById(workspaceB.id, contact.id)).toBeNull();
    expect(await repo.findById(workspaceA.id, contact.id)).toMatchObject({ id: contact.id });

    const listedFromB = await repo.list(workspaceB.id, { page: 1, pageSize: 10 });
    expect(listedFromB.items).toHaveLength(0);
    const allFromA = await repo.listAllForWorkspace(workspaceA.id);
    expect(allFromA.map((c) => c.id)).toContain(contact.id);
  });

  it("enforces the partial unique index on (workspace_id, vat_id_normalized)", async () => {
    const workspace = await createTestWorkspace("Vat Unique Co");
    const repo = createDrizzleContactRepository(db);

    await repo.create(baseContactFields({ workspaceId: workspace.id, name: "A GmbH", nameNormalized: "a", vatIdNormalized: "DE123456789" }));

    await expect(
      repo.create(baseContactFields({ workspaceId: workspace.id, name: "B GmbH", nameNormalized: "b", vatIdNormalized: "DE123456789" })),
    ).rejects.toThrow();
  });

  it("allows two contacts with a null vat_id_normalized (the partial index does not apply)", async () => {
    const workspace = await createTestWorkspace("Null Vat Co");
    const repo = createDrizzleContactRepository(db);

    await repo.create(baseContactFields({ workspaceId: workspace.id, name: "A GmbH", nameNormalized: "a" }));
    await expect(repo.create(baseContactFields({ workspaceId: workspace.id, name: "B GmbH", nameNormalized: "b" }))).resolves.toBeTruthy();
  });

  it("allows two DIFFERENT contacts in the same workspace to share an iban_normalized (no unique index there)", async () => {
    const workspace = await createTestWorkspace("Shared Iban Co");
    const repo = createDrizzleContactRepository(db);

    const seeded = await repo.create(baseContactFields({ workspaceId: workspace.id, name: "A GmbH", nameNormalized: "a" }));
    const a = await repo.updateFields(workspace.id, seeded.id, { ibanNormalized: "DE111111111111111111" });
    const b = await repo.create({ ...baseContactFields({ workspaceId: workspace.id, name: "B GmbH", nameNormalized: "b" }), ibanNormalized: "DE111111111111111111" });

    expect(a?.ibanNormalized).toBe("DE111111111111111111");
    expect(b.ibanNormalized).toBe("DE111111111111111111");
  });

  it("deleteById is scoped to the workspace", async () => {
    const workspaceA = await createTestWorkspace("Delete Scope A");
    const workspaceB = await createTestWorkspace("Delete Scope B");
    const repo = createDrizzleContactRepository(db);
    const contact = await repo.create(baseContactFields({ workspaceId: workspaceA.id, name: "A GmbH", nameNormalized: "a" }));

    expect(await repo.deleteById(workspaceB.id, contact.id)).toBeNull();
    expect(await repo.deleteById(workspaceA.id, contact.id)).toMatchObject({ id: contact.id });
  });
});

describe("createDrizzleDocumentContactRepository", () => {
  it("link is idempotent and cascades when the document is deleted", async () => {
    const workspace = await createTestWorkspace("Link Cascade Co");
    const document = await createTestDocument(workspace.id, "1");
    const contactRepo = createDrizzleContactRepository(db);
    const linkRepo = createDrizzleDocumentContactRepository(db);
    const contact = await contactRepo.create(baseContactFields({ workspaceId: workspace.id, name: "A GmbH", nameNormalized: "a" }));

    await linkRepo.link({ documentId: document.id, contactId: contact.id, role: "sender" });
    await linkRepo.link({ documentId: document.id, contactId: contact.id, role: "sender" }); // idempotent
    expect(await linkRepo.listForDocument(workspace.id, document.id)).toHaveLength(1);

    await db.delete(documents).where(eq(documents.id, document.id));
    expect(await linkRepo.listForContact(workspace.id, contact.id)).toHaveLength(0);
  });

  it("cascades when the contact is deleted", async () => {
    const workspace = await createTestWorkspace("Link Cascade Contact Co");
    const document = await createTestDocument(workspace.id, "2");
    const contactRepo = createDrizzleContactRepository(db);
    const linkRepo = createDrizzleDocumentContactRepository(db);
    const contact = await contactRepo.create(baseContactFields({ workspaceId: workspace.id, name: "A GmbH", nameNormalized: "a" }));
    await linkRepo.link({ documentId: document.id, contactId: contact.id, role: "recipient" });

    await contactRepo.deleteById(workspace.id, contact.id);

    expect(await linkRepo.listForDocument(workspace.id, document.id)).toHaveLength(0);
  });

  it("moveContactLinks repoints links and skips a duplicate the target already has", async () => {
    const workspace = await createTestWorkspace("Merge Links Co");
    const documentShared = await createTestDocument(workspace.id, "shared");
    const documentSourceOnly = await createTestDocument(workspace.id, "source-only");
    const contactRepo = createDrizzleContactRepository(db);
    const linkRepo = createDrizzleDocumentContactRepository(db);
    const source = await contactRepo.create(baseContactFields({ workspaceId: workspace.id, name: "Source GmbH", nameNormalized: "source" }));
    const target = await contactRepo.create(baseContactFields({ workspaceId: workspace.id, name: "Target GmbH", nameNormalized: "target" }));

    // Both source and target already link the same document with the same role - the merge
    // must not fail on that duplicate (the composite primary key would otherwise reject it).
    await linkRepo.link({ documentId: documentShared.id, contactId: source.id, role: "sender" });
    await linkRepo.link({ documentId: documentShared.id, contactId: target.id, role: "sender" });
    await linkRepo.link({ documentId: documentSourceOnly.id, contactId: source.id, role: "mentioned" });

    await linkRepo.moveContactLinks(source.id, target.id);

    const targetLinks = await linkRepo.listForContact(workspace.id, target.id);
    expect(targetLinks.map((l) => l.documentId).sort()).toEqual([documentShared.id, documentSourceOnly.id].sort());
    expect(await linkRepo.listForContact(workspace.id, source.id)).toHaveLength(0);
  });

  it(
    "listForDocument/listForContact are scoped by workspaceId at the query level, not only by " +
      "the caller having pre-validated the id (F5, decisions/0027-hardening-and-deletion.md)",
    async () => {
      const workspaceA = await createTestWorkspace("Scope Check A");
      const workspaceB = await createTestWorkspace("Scope Check B");
      const document = await createTestDocument(workspaceA.id, "scope-check");
      const contactRepo = createDrizzleContactRepository(db);
      const linkRepo = createDrizzleDocumentContactRepository(db);
      const contact = await contactRepo.create(baseContactFields({ workspaceId: workspaceA.id, name: "A GmbH", nameNormalized: "a" }));
      await linkRepo.link({ documentId: document.id, contactId: contact.id, role: "sender" });

      // The real ids exist and are genuinely linked - only the WORKSPACE argument is wrong.
      expect(await linkRepo.listForDocument(workspaceA.id, document.id)).toHaveLength(1);
      expect(await linkRepo.listForDocument(workspaceB.id, document.id)).toHaveLength(0);
      expect(await linkRepo.listForContact(workspaceA.id, contact.id)).toHaveLength(1);
      expect(await linkRepo.listForContact(workspaceB.id, contact.id)).toHaveLength(0);
    },
  );

  it("unlinkAllForDocument removes every link for a document regardless of role", async () => {
    const workspace = await createTestWorkspace("Unlink All Co");
    const document = await createTestDocument(workspace.id, "unlink-all");
    const contactRepo = createDrizzleContactRepository(db);
    const linkRepo = createDrizzleDocumentContactRepository(db);
    const sender = await contactRepo.create(baseContactFields({ workspaceId: workspace.id, name: "Sender GmbH", nameNormalized: "sender" }));
    const mentioned = await contactRepo.create(baseContactFields({ workspaceId: workspace.id, name: "Mentioned GmbH", nameNormalized: "mentioned" }));
    await linkRepo.link({ documentId: document.id, contactId: sender.id, role: "sender" });
    await linkRepo.link({ documentId: document.id, contactId: mentioned.id, role: "mentioned" });
    expect(await linkRepo.listForDocument(workspace.id, document.id)).toHaveLength(2);

    await linkRepo.unlinkAllForDocument(workspace.id, document.id);

    expect(await linkRepo.listForDocument(workspace.id, document.id)).toHaveLength(0);
  });

  it("unlinkAllForDocument is workspace-scoped: a document id from another workspace removes nothing", async () => {
    const workspaceA = await createTestWorkspace("Unlink Scope A");
    const workspaceB = await createTestWorkspace("Unlink Scope B");
    const document = await createTestDocument(workspaceA.id, "unlink-scope");
    const contactRepo = createDrizzleContactRepository(db);
    const linkRepo = createDrizzleDocumentContactRepository(db);
    const contact = await contactRepo.create(baseContactFields({ workspaceId: workspaceA.id, name: "A GmbH", nameNormalized: "a" }));
    await linkRepo.link({ documentId: document.id, contactId: contact.id, role: "sender" });

    // `document` genuinely exists and is genuinely linked - only `workspaceB` is the wrong
    // workspace for it, the same "id is real, workspace argument is wrong" shape as the
    // `listForDocument`/`listForContact` scoping test above.
    await linkRepo.unlinkAllForDocument(workspaceB.id, document.id);

    expect(await linkRepo.listForDocument(workspaceA.id, document.id)).toHaveLength(1);
  });
});

describe("createDrizzleContactProposalRepository", () => {
  it("scopes listForWorkspace and decide by workspace, and decide only affects a pending proposal", async () => {
    const workspaceA = await createTestWorkspace("Proposal Scope A");
    const workspaceB = await createTestWorkspace("Proposal Scope B");
    const contactRepo = createDrizzleContactRepository(db);
    const proposalRepo = createDrizzleContactProposalRepository(db);
    const contact = await contactRepo.create(baseContactFields({ workspaceId: workspaceA.id, name: "A GmbH", nameNormalized: "a" }));
    const decider = await createTestUser("decider");

    const proposal = await proposalRepo.create({
      workspaceId: workspaceA.id,
      contactId: contact.id,
      documentId: null,
      field: "phone",
      currentValue: "1",
      proposedValue: "2",
    });

    expect(await proposalRepo.findById(workspaceB.id, proposal.id)).toBeNull();
    expect(
      await proposalRepo.decide(workspaceB.id, proposal.id, { status: "accepted", decidedByUserId: decider.id, decidedAt: new Date() }),
    ).toBeNull();

    const decided = await proposalRepo.decide(workspaceA.id, proposal.id, {
      status: "accepted",
      decidedByUserId: decider.id,
      decidedAt: new Date(),
    });
    expect(decided?.status).toBe("accepted");

    // Deciding again (already decided, no longer pending) is a no-op returning null.
    expect(
      await proposalRepo.decide(workspaceA.id, proposal.id, { status: "rejected", decidedByUserId: decider.id, decidedAt: new Date() }),
    ).toBeNull();
  });

  it("moveContactProposals repoints every proposal to the target contact", async () => {
    const workspace = await createTestWorkspace("Merge Proposals Co");
    const contactRepo = createDrizzleContactRepository(db);
    const proposalRepo = createDrizzleContactProposalRepository(db);
    const source = await contactRepo.create(baseContactFields({ workspaceId: workspace.id, name: "Source GmbH", nameNormalized: "source" }));
    const target = await contactRepo.create(baseContactFields({ workspaceId: workspace.id, name: "Target GmbH", nameNormalized: "target" }));
    await proposalRepo.create({ workspaceId: workspace.id, contactId: source.id, documentId: null, field: "phone", currentValue: "1", proposedValue: "2" });

    await proposalRepo.moveContactProposals(source.id, target.id);

    expect(await proposalRepo.listForContact(workspace.id, source.id)).toHaveLength(0);
    expect(await proposalRepo.listForContact(workspace.id, target.id)).toHaveLength(1);
  });
});
