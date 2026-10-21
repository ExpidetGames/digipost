// Real Postgres (WEBAPP_TEMPLATE_SPEC.md §10.1/§10.3, `pnpm test:docker` reference,
// `pnpm test:db` on the host against `docker/compose.yml`). Each test uses its own fixture
// user(s)/workspace(s) so tests never interfere with each other without needing an outer
// rollback wrapper; the dedicated "rolls back" test proves the Unit of Work's actual
// transaction/rollback behavior.
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { getDb } from "@/persistence/foundation/client";
import { isDbError } from "@/persistence/foundation/db-errors";
import {
  createDrizzleWorkspaceInvitationRepository,
  createDrizzleWorkspaceMemberRepository,
  createDrizzleWorkspaceRepository,
} from "@/persistence/repositories/drizzle/workspaces-repository";
import { createDrizzleUnitOfWork } from "@/persistence/repositories/drizzle/unit-of-work";
import { accounts, importBatches, settlementLines, transactions } from "@/persistence/schema/accounts";
import { user } from "@/persistence/schema/auth";
import { quotaPackagePurchases, workspaceMonthlyUsage } from "@/persistence/schema/billing";
import { contactChangeProposals, contacts, documentContacts } from "@/persistence/schema/contacts";
import { documents } from "@/persistence/schema/documents";
import { intakeSourceFingerprints } from "@/persistence/schema/intake-fingerprints";
import { jobs } from "@/persistence/schema/jobs";
import { documentTransactions, paymentAliases, paymentNoDocumentRules, paymentRejections } from "@/persistence/schema/payments";
import { workspaceInvitations, workspaceMembers } from "@/persistence/schema/workspaces";

const db = getDb();

async function createTestUser(label = "user"): Promise<{ id: string; email: string }> {
  const email = `${label}-${randomUUID()}@example.test`;
  const [row] = await db.insert(user).values({ name: "Test User", email, emailVerified: false }).returning({ id: user.id });
  if (!row) throw new Error("failed to insert test user fixture");
  return { id: row.id, email };
}

describe("createDrizzleWorkspaceRepository", () => {
  it("creates and finds a workspace by id", async () => {
    const repo = createDrizzleWorkspaceRepository(db);
    const created = await repo.create({ name: "Muster GmbH" });

    expect(created).toMatchObject({ name: "Muster GmbH", tier: "free" });
    expect(await repo.findById(created.id)).toMatchObject({ id: created.id, name: "Muster GmbH" });
  });

  it("returns null (not an error) for an unknown id", async () => {
    const repo = createDrizzleWorkspaceRepository(db);
    expect(await repo.findById(randomUUID())).toBeNull();
  });

  it("updateTier changes the workspace's tier (P3, decisions/0017-billing-tiers-and-packages.md)", async () => {
    const repo = createDrizzleWorkspaceRepository(db);
    const created = await repo.create({ name: "Tarifwechsel GmbH" });

    const updated = await repo.updateTier(created.id, "pro");

    expect(updated).toMatchObject({ id: created.id, tier: "pro" });
    expect(await repo.findById(created.id)).toMatchObject({ tier: "pro" });
  });

  it("updateTier returns null for an unknown id", async () => {
    const repo = createDrizzleWorkspaceRepository(db);
    expect(await repo.updateTier(randomUUID(), "pro")).toBeNull();
  });

  // decisions/0034-extended-company-profile.md (H1): the seven new columns round-trip
  // through the repository, including empty arrays (the default for a fresh workspace) and
  // that a full write persists exactly what was written (the repository itself never
  // normalizes anything - that is `workspaces-use-cases.ts`'s job, covered by its own unit
  // tests).
  describe("updateCompanyProfile - extended fields", () => {
    it("defaults the array columns to empty arrays for a freshly created workspace", async () => {
      const repo = createDrizzleWorkspaceRepository(db);
      const created = await repo.create({ name: "Fresh Co" });

      expect(created).toMatchObject({ companyAliases: [], companyIbans: [], companyDomains: [] });
      expect(await repo.findById(created.id)).toMatchObject({
        companyAliases: [],
        companyIbans: [],
        companyDomains: [],
        companyTaxNumber: null,
        companyRegisterCourt: null,
        companyRegisterNumber: null,
        companyProfileText: null,
      });
    });

    it("round-trips the extended profile fields exactly as written", async () => {
      const repo = createDrizzleWorkspaceRepository(db);
      const created = await repo.create({ name: "Extended Co" });

      const updated = await repo.updateCompanyProfile(created.id, {
        companyAddressLine1: "Musterstraße 1",
        companyAddressLine2: null,
        companyPostalCode: "10115",
        companyCity: "Berlin",
        companyCountry: "DE",
        companyVatId: "DE111222333",
        companyAliases: ["Musterfirma", "Erika Maria Beispiel GbR"],
        companyIbans: ["DE89370400440532013000"],
        companyDomains: ["musterfirma.de"],
        companyTaxNumber: "12/345/67890",
        companyRegisterCourt: "Amtsgericht Charlottenburg",
        companyRegisterNumber: "HRB 123456",
        companyProfileText: 'Wir treten als "musterfirma" auf.',
      });

      expect(updated).toMatchObject({
        companyAliases: ["Musterfirma", "Erika Maria Beispiel GbR"],
        companyIbans: ["DE89370400440532013000"],
        companyDomains: ["musterfirma.de"],
        companyTaxNumber: "12/345/67890",
        companyRegisterCourt: "Amtsgericht Charlottenburg",
        companyRegisterNumber: "HRB 123456",
        companyProfileText: 'Wir treten als "musterfirma" auf.',
      });
      expect(await repo.findById(created.id)).toMatchObject({
        companyAliases: ["Musterfirma", "Erika Maria Beispiel GbR"],
        companyIbans: ["DE89370400440532013000"],
        companyDomains: ["musterfirma.de"],
      });
    });

    it("can clear the array columns back to empty and the text columns back to null", async () => {
      const repo = createDrizzleWorkspaceRepository(db);
      const created = await repo.create({ name: "Clear Co" });
      await repo.updateCompanyProfile(created.id, {
        companyAddressLine1: null,
        companyAddressLine2: null,
        companyPostalCode: null,
        companyCity: null,
        companyCountry: "DE",
        companyVatId: null,
        companyAliases: ["Musterfirma"],
        companyIbans: ["DE89370400440532013000"],
        companyDomains: ["musterfirma.de"],
        companyTaxNumber: "123",
        companyRegisterCourt: "Amtsgericht Charlottenburg",
        companyRegisterNumber: "HRB 123456",
        companyProfileText: "old text",
      });

      const cleared = await repo.updateCompanyProfile(created.id, {
        companyAddressLine1: null,
        companyAddressLine2: null,
        companyPostalCode: null,
        companyCity: null,
        companyCountry: "DE",
        companyVatId: null,
        companyAliases: [],
        companyIbans: [],
        companyDomains: [],
        companyTaxNumber: null,
        companyRegisterCourt: null,
        companyRegisterNumber: null,
        companyProfileText: null,
      });

      expect(cleared).toMatchObject({
        companyAliases: [],
        companyIbans: [],
        companyDomains: [],
        companyTaxNumber: null,
        companyRegisterCourt: null,
        companyRegisterNumber: null,
        companyProfileText: null,
      });
    });
  });
});

describe("createDrizzleWorkspaceMemberRepository", () => {
  it("scopes findById to the given workspace", async () => {
    const workspaceRepo = createDrizzleWorkspaceRepository(db);
    const memberRepo = createDrizzleWorkspaceMemberRepository(db);
    const workspaceA = await workspaceRepo.create({ name: "A" });
    const workspaceB = await workspaceRepo.create({ name: "B" });
    const userA = await createTestUser();
    const member = await memberRepo.create({ workspaceId: workspaceA.id, userId: userA.id, role: "admin" });

    expect(await memberRepo.findById(workspaceA.id, member.id)).toMatchObject({ id: member.id });
    expect(await memberRepo.findById(workspaceB.id, member.id)).toBeNull();
  });

  // decisions/0070-several-workspaces-per-user.md: the unique on `user_id` alone is gone;
  // this used to assert the opposite. The composite unique that replaced it, and the
  // ordering the fallback depends on, are `workspaces-multi-membership.db.test.ts`.
  it("allows one user to belong to several workspaces", async () => {
    const workspaceRepo = createDrizzleWorkspaceRepository(db);
    const memberRepo = createDrizzleWorkspaceMemberRepository(db);
    const workspaceA = await workspaceRepo.create({ name: "A" });
    const workspaceB = await workspaceRepo.create({ name: "B" });
    const person = await createTestUser();
    await memberRepo.create({ workspaceId: workspaceA.id, userId: person.id, role: "admin" });

    await memberRepo.create({ workspaceId: workspaceB.id, userId: person.id, role: "member" });

    const memberships = await memberRepo.listByUserIdWithWorkspace(person.id);
    expect(memberships.map((m) => m.workspace.name)).toEqual(["A", "B"]);
    expect(memberships.map((m) => m.member.role)).toEqual(["admin", "member"]);
  });

  it("enforces exactly one admin per workspace (partial unique index)", async () => {
    const workspaceRepo = createDrizzleWorkspaceRepository(db);
    const memberRepo = createDrizzleWorkspaceMemberRepository(db);
    const workspace = await workspaceRepo.create({ name: "One Admin Co" });
    const firstAdmin = await createTestUser();
    const secondAdmin = await createTestUser();
    await memberRepo.create({ workspaceId: workspace.id, userId: firstAdmin.id, role: "admin" });

    const attempt = memberRepo.create({ workspaceId: workspace.id, userId: secondAdmin.id, role: "admin" });
    try {
      await attempt;
      expect.unreachable("expected a second admin for the same workspace to fail");
    } catch (err) {
      expect(isDbError(err, "unique")).toBe(true);
    }
  });

  it("allows multiple members with role member in the same workspace", async () => {
    const workspaceRepo = createDrizzleWorkspaceRepository(db);
    const memberRepo = createDrizzleWorkspaceMemberRepository(db);
    const workspace = await workspaceRepo.create({ name: "Team Co" });
    const admin = await createTestUser();
    const memberOne = await createTestUser();
    const memberTwo = await createTestUser();
    await memberRepo.create({ workspaceId: workspace.id, userId: admin.id, role: "admin" });
    await memberRepo.create({ workspaceId: workspace.id, userId: memberOne.id, role: "member" });
    await memberRepo.create({ workspaceId: workspace.id, userId: memberTwo.id, role: "member" });

    const listed = await memberRepo.listByWorkspace(workspace.id);
    expect(listed.map((m) => m.userId).sort()).toEqual([admin.id, memberOne.id, memberTwo.id].sort());
  });

  it("listByWorkspace joins the member's email and name", async () => {
    const workspaceRepo = createDrizzleWorkspaceRepository(db);
    const memberRepo = createDrizzleWorkspaceMemberRepository(db);
    const workspace = await workspaceRepo.create({ name: "Join Co" });
    const admin = await createTestUser("joinadmin");
    await memberRepo.create({ workspaceId: workspace.id, userId: admin.id, role: "admin" });

    const listed = await memberRepo.listByWorkspace(workspace.id);
    expect(listed).toEqual([expect.objectContaining({ userId: admin.id, email: admin.email, name: "Test User" })]);
  });

  it("deleteById scopes to the given workspace: a different workspace's id does not delete the row", async () => {
    const workspaceRepo = createDrizzleWorkspaceRepository(db);
    const memberRepo = createDrizzleWorkspaceMemberRepository(db);
    const workspaceA = await workspaceRepo.create({ name: "A" });
    const workspaceB = await workspaceRepo.create({ name: "B" });
    const person = await createTestUser();
    const member = await memberRepo.create({ workspaceId: workspaceA.id, userId: person.id, role: "admin" });

    expect(await memberRepo.deleteById(workspaceB.id, member.id)).toBeNull();
    expect(await memberRepo.findById(workspaceA.id, member.id)).not.toBeNull();
    expect(await memberRepo.deleteById(workspaceA.id, member.id)).toMatchObject({ id: member.id });
    expect(await memberRepo.findById(workspaceA.id, member.id)).toBeNull();
  });
});

describe("createDrizzleWorkspaceInvitationRepository", () => {
  async function setupWorkspaceWithAdmin(name = "Invite Co") {
    const workspaceRepo = createDrizzleWorkspaceRepository(db);
    const memberRepo = createDrizzleWorkspaceMemberRepository(db);
    const workspace = await workspaceRepo.create({ name });
    const admin = await createTestUser("admin");
    await memberRepo.create({ workspaceId: workspace.id, userId: admin.id, role: "admin" });
    return { workspace, admin };
  }

  it("finds an invitation by its token hash", async () => {
    const { workspace, admin } = await setupWorkspaceWithAdmin();
    const invitationRepo = createDrizzleWorkspaceInvitationRepository(db);
    const created = await invitationRepo.create({
      workspaceId: workspace.id,
      email: "invitee@example.test",
      tokenHash: "a".repeat(64),
      invitedByUserId: admin.id,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });

    expect(await invitationRepo.findByTokenHash("a".repeat(64))).toMatchObject({ id: created.id });
    expect(await invitationRepo.findByTokenHash("b".repeat(64))).toBeNull();
  });

  it("findByTokenHashWithDetails joins the workspace name and inviter email", async () => {
    const { workspace, admin } = await setupWorkspaceWithAdmin("Detail Co");
    const invitationRepo = createDrizzleWorkspaceInvitationRepository(db);
    await invitationRepo.create({
      workspaceId: workspace.id,
      email: "invitee@example.test",
      tokenHash: "c".repeat(64),
      invitedByUserId: admin.id,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });

    const details = await invitationRepo.findByTokenHashWithDetails("c".repeat(64));
    expect(details).toMatchObject({ workspaceName: "Detail Co", inviterEmail: admin.email });
  });

  it(
    "survives the inviting user's account being deleted: invitedByUserId is set null, " +
      "the row (and its findByTokenHashWithDetails read) still resolves (P6 review finding A9)",
    async () => {
      const { workspace, admin } = await setupWorkspaceWithAdmin("Deleted Inviter Co");
      const invitationRepo = createDrizzleWorkspaceInvitationRepository(db);
      const created = await invitationRepo.create({
        workspaceId: workspace.id,
        email: "invitee@example.test",
        tokenHash: "9".repeat(64),
        invitedByUserId: admin.id,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      });

      // Deleting the inviting user's own membership row first (a real deletion would also
      // remove their workspace membership; only the auth `user` row matters for this
      // column's `onDelete` behavior).
      await db.delete(workspaceMembers).where(eq(workspaceMembers.userId, admin.id));
      await db.delete(user).where(eq(user.id, admin.id));

      const stillFound = await invitationRepo.findByTokenHash("9".repeat(64));
      expect(stillFound).toMatchObject({ id: created.id, invitedByUserId: null });

      // Before the fix, this join was an innerJoin on `user`: with the inviter's row gone,
      // the whole invitation would silently disappear from this lookup instead of just
      // losing its inviterEmail.
      const details = await invitationRepo.findByTokenHashWithDetails("9".repeat(64));
      expect(details).toMatchObject({ workspaceName: "Deleted Inviter Co", inviterEmail: null });
    },
  );

  it("countPending counts only unaccepted invitations", async () => {
    const { workspace, admin } = await setupWorkspaceWithAdmin();
    const invitationRepo = createDrizzleWorkspaceInvitationRepository(db);
    await invitationRepo.create({
      workspaceId: workspace.id,
      email: "pending@example.test",
      tokenHash: "d".repeat(64),
      invitedByUserId: admin.id,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });
    const accepted = await invitationRepo.create({
      workspaceId: workspace.id,
      email: "accepted@example.test",
      tokenHash: "e".repeat(64),
      invitedByUserId: admin.id,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });
    await invitationRepo.markAccepted(accepted.id, new Date());

    expect(await invitationRepo.countPending(workspace.id)).toBe(1);
  });

  it("deletePendingByEmail removes only the matching pending invitation", async () => {
    const { workspace, admin } = await setupWorkspaceWithAdmin();
    const invitationRepo = createDrizzleWorkspaceInvitationRepository(db);
    await invitationRepo.create({
      workspaceId: workspace.id,
      email: "again@example.test",
      tokenHash: "f".repeat(64),
      invitedByUserId: admin.id,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });

    await invitationRepo.deletePendingByEmail(workspace.id, "again@example.test");

    expect(await invitationRepo.countPending(workspace.id)).toBe(0);
  });

  it("enforces at most one pending invitation per email per workspace", async () => {
    const { workspace, admin } = await setupWorkspaceWithAdmin();
    const invitationRepo = createDrizzleWorkspaceInvitationRepository(db);
    await invitationRepo.create({
      workspaceId: workspace.id,
      email: "dup@example.test",
      tokenHash: "1".repeat(64),
      invitedByUserId: admin.id,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });

    const attempt = invitationRepo.create({
      workspaceId: workspace.id,
      email: "dup@example.test",
      tokenHash: "2".repeat(64),
      invitedByUserId: admin.id,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });
    try {
      await attempt;
      expect.unreachable("expected a second pending invitation for the same email to fail");
    } catch (err) {
      expect(isDbError(err, "unique")).toBe(true);
    }
  });

  it("deleteById only deletes a pending invitation scoped to the workspace", async () => {
    const { workspace, admin } = await setupWorkspaceWithAdmin();
    const otherWorkspaceRepo = createDrizzleWorkspaceRepository(db);
    const otherWorkspace = await otherWorkspaceRepo.create({ name: "Other" });
    const invitationRepo = createDrizzleWorkspaceInvitationRepository(db);
    const invitation = await invitationRepo.create({
      workspaceId: workspace.id,
      email: "revoke-me@example.test",
      tokenHash: "3".repeat(64),
      invitedByUserId: admin.id,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });

    expect(await invitationRepo.deleteById(otherWorkspace.id, invitation.id)).toBeNull();
    expect(await invitationRepo.deleteById(workspace.id, invitation.id)).toMatchObject({ id: invitation.id });
  });
});

describe("createDrizzleWorkspaceRepository.delete (F5, decisions/0027-hardening-and-deletion.md)", () => {
  // Proves the ADR's central claim against real Postgres: every workspace-owned table's
  // foreign key to `workspaces.id` cascades, so deleting the workspace row alone removes
  // every row this seed inserts across every owner's tables - no per-table delete sequence
  // needed, and nothing here relies on a specific delete order. Also proves a second,
  // untouched workspace's rows survive, so the delete never reaches beyond its own tenant.
  it("cascades to every workspace-owned table, and leaves another workspace's rows untouched", async () => {
    const workspaceRepo = createDrizzleWorkspaceRepository(db);
    const memberRepo = createDrizzleWorkspaceMemberRepository(db);
    const invitationRepo = createDrizzleWorkspaceInvitationRepository(db);

    const workspace = await workspaceRepo.create({ name: "Cascade Delete Co" });
    const other = await workspaceRepo.create({ name: "Untouched Co" });
    const admin = await createTestUser("cascade-admin");
    const member = await createTestUser("cascade-member");
    await memberRepo.create({ workspaceId: workspace.id, userId: admin.id, role: "admin" });
    await memberRepo.create({ workspaceId: workspace.id, userId: member.id, role: "member" });
    const otherAdmin = await createTestUser("other-admin");
    await memberRepo.create({ workspaceId: other.id, userId: otherAdmin.id, role: "admin" });

    await invitationRepo.create({
      workspaceId: workspace.id,
      email: "invitee@example.test",
      tokenHash: randomUUID(),
      invitedByUserId: admin.id,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    });

    const [document] = await db
      .insert(documents)
      .values({
        workspaceId: workspace.id,
        originalFileName: "rechnung.pdf",
        mimeType: "application/pdf",
        pageCount: 1,
        sizeBytes: 100,
        storageKey: `workspaces/${workspace.id}/documents/${randomUUID()}/original.pdf`,
      })
      .returning();
    if (!document) throw new Error("failed to insert document fixture");

    const [contact] = await db
      .insert(contacts)
      .values({ workspaceId: workspace.id, name: "Lieferant GmbH", source: "manual", nameNormalized: "lieferant gmbh" })
      .returning();
    if (!contact) throw new Error("failed to insert contact fixture");
    await db.insert(documentContacts).values({ documentId: document.id, contactId: contact.id, role: "sender" });
    await db.insert(contactChangeProposals).values({
      workspaceId: workspace.id,
      contactId: contact.id,
      documentId: document.id,
      field: "iban",
      currentValue: "DE00",
      proposedValue: "DE11",
    });

    const [account] = await db
      .insert(accounts)
      .values({ workspaceId: workspace.id, type: "bank", name: "Geschäftskonto" })
      .returning();
    if (!account) throw new Error("failed to insert account fixture");
    const [transaction] = await db
      .insert(transactions)
      .values({
        workspaceId: workspace.id,
        accountId: account.id,
        bookingDate: "2026-01-01",
        amountCents: 1000,
        creditDebit: "credit",
        idempotencyKey: randomUUID(),
      })
      .returning();
    if (!transaction) throw new Error("failed to insert transaction fixture");
    await db.insert(importBatches).values({
      workspaceId: workspace.id,
      accountId: account.id,
      rowsTotal: 1,
      rowsImported: 1,
      rowsDuplicate: 0,
    });
    await db.insert(settlementLines).values({
      workspaceId: workspace.id,
      clearingAccountId: account.id,
      sourceDocumentId: document.id,
      transactionId: transaction.id,
      type: "revenue",
      externalLineId: `revenue:row1:${randomUUID()}`,
    });

    await db.insert(documentTransactions).values({
      workspaceId: workspace.id,
      documentId: document.id,
      transactionId: transaction.id,
      kind: "exact",
      confidence: 1,
      matchedBy: "auto",
      allocatedAmountCents: 1000,
    });
    await db.insert(paymentAliases).values({
      workspaceId: workspace.id,
      counterpartyNameNormalized: "lieferant gmbh",
      contactId: contact.id,
    });
    await db.insert(paymentRejections).values({ workspaceId: workspace.id, documentId: document.id, transactionId: transaction.id });
    await db.insert(paymentNoDocumentRules).values({ workspaceId: workspace.id, counterpartyNameNormalized: "interne buchung" });

    await db.insert(jobs).values({ kind: "process-document", workspaceId: workspace.id, payload: { documentId: document.id } });
    await db.insert(workspaceMonthlyUsage).values({ workspaceId: workspace.id, period: "2026-01-01", documentsCreated: 1 });
    await db.insert(quotaPackagePurchases).values({
      workspaceId: workspace.id,
      packageKey: "s",
      extraDocuments: 250,
      priceCents: 1900,
      period: "2026-01-01",
      provider: "test",
    });
    await db.insert(intakeSourceFingerprints).values({
      workspaceId: workspace.id,
      fingerprint: randomUUID(),
      documentKind: "bank_statement",
      columnMapping: {},
    });

    // A second workspace's own document, to prove the delete below never reaches it.
    const [otherDocument] = await db
      .insert(documents)
      .values({
        workspaceId: other.id,
        originalFileName: "andere.pdf",
        mimeType: "application/pdf",
        pageCount: 1,
        sizeBytes: 50,
        storageKey: `workspaces/${other.id}/documents/${randomUUID()}/original.pdf`,
      })
      .returning();
    if (!otherDocument) throw new Error("failed to insert other-workspace document fixture");

    const deleted = await workspaceRepo.delete(workspace.id);
    expect(deleted).toMatchObject({ id: workspace.id });

    expect(await workspaceRepo.findById(workspace.id)).toBeNull();
    expect(await db.select().from(workspaceMembers).where(eq(workspaceMembers.workspaceId, workspace.id))).toHaveLength(0);
    expect(await db.select().from(workspaceInvitations).where(eq(workspaceInvitations.workspaceId, workspace.id))).toHaveLength(0);
    expect(await db.select().from(documents).where(eq(documents.workspaceId, workspace.id))).toHaveLength(0);
    expect(await db.select().from(contacts).where(eq(contacts.workspaceId, workspace.id))).toHaveLength(0);
    expect(await db.select().from(contactChangeProposals).where(eq(contactChangeProposals.workspaceId, workspace.id))).toHaveLength(0);
    expect(await db.select().from(accounts).where(eq(accounts.workspaceId, workspace.id))).toHaveLength(0);
    expect(await db.select().from(transactions).where(eq(transactions.workspaceId, workspace.id))).toHaveLength(0);
    expect(await db.select().from(importBatches).where(eq(importBatches.workspaceId, workspace.id))).toHaveLength(0);
    expect(await db.select().from(settlementLines).where(eq(settlementLines.workspaceId, workspace.id))).toHaveLength(0);
    expect(await db.select().from(documentTransactions).where(eq(documentTransactions.workspaceId, workspace.id))).toHaveLength(0);
    expect(await db.select().from(paymentAliases).where(eq(paymentAliases.workspaceId, workspace.id))).toHaveLength(0);
    expect(await db.select().from(paymentRejections).where(eq(paymentRejections.workspaceId, workspace.id))).toHaveLength(0);
    expect(await db.select().from(paymentNoDocumentRules).where(eq(paymentNoDocumentRules.workspaceId, workspace.id))).toHaveLength(0);
    expect(await db.select().from(jobs).where(eq(jobs.workspaceId, workspace.id))).toHaveLength(0);
    expect(await db.select().from(workspaceMonthlyUsage).where(eq(workspaceMonthlyUsage.workspaceId, workspace.id))).toHaveLength(0);
    expect(await db.select().from(quotaPackagePurchases).where(eq(quotaPackagePurchases.workspaceId, workspace.id))).toHaveLength(0);
    expect(await db.select().from(intakeSourceFingerprints).where(eq(intakeSourceFingerprints.workspaceId, workspace.id))).toHaveLength(0);
    // `document_contacts` has no `workspace_id` column of its own - scoped via the document
    // it cascaded from instead.
    expect(await db.select().from(documentContacts).where(eq(documentContacts.documentId, document.id))).toHaveLength(0);

    // The other workspace and its own document are untouched.
    expect(await workspaceRepo.findById(other.id)).toMatchObject({ id: other.id });
    expect(await db.select().from(documents).where(eq(documents.id, otherDocument.id))).toHaveLength(1);
  });

  it("returns null (not an error) for a workspace that does not exist", async () => {
    const workspaceRepo = createDrizzleWorkspaceRepository(db);
    expect(await workspaceRepo.delete(randomUUID())).toBeNull();
  });
});

describe("workspaces Unit of Work", () => {
  it("rolls back the membership insert when accept fails partway through", async () => {
    const workspaceRepo = createDrizzleWorkspaceRepository(db);
    const memberRepo = createDrizzleWorkspaceMemberRepository(db);
    const workspace = await workspaceRepo.create({ name: "Rollback Co" });
    const invitee = await createTestUser("invitee");
    const uow = createDrizzleUnitOfWork(db);

    await expect(
      uow.transaction(async (repos) => {
        await repos.workspaceMember.create({ workspaceId: workspace.id, userId: invitee.id, role: "member" });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(await memberRepo.findByWorkspaceAndUser(workspace.id, invitee.id)).toBeNull();
  });

  it("commits every write when the transaction succeeds", async () => {
    const workspaceRepo = createDrizzleWorkspaceRepository(db);
    const memberRepo = createDrizzleWorkspaceMemberRepository(db);
    const workspace = await workspaceRepo.create({ name: "Commit Co" });
    const invitee = await createTestUser("committed");
    const uow = createDrizzleUnitOfWork(db);

    await uow.transaction(async (repos) => {
      await repos.workspaceMember.create({ workspaceId: workspace.id, userId: invitee.id, role: "member" });
    });

    expect(await memberRepo.findByWorkspaceAndUser(workspace.id, invitee.id)).toMatchObject({ workspaceId: workspace.id });
  });
});
