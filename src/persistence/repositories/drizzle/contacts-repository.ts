// Owner: src/modules/contacts (decisions/0019-contacts.md). Encapsulates access only: no
// validation, no matching, no verification-state decisions (WEBAPP_TEMPLATE_SPEC.md §5.3) -
// all of that lives in `@/modules/contacts`'s pure core and
// `src/persistence/use-cases/contacts-use-cases.ts`.
import { and, desc, eq, exists, ilike, isNotNull, isNull, or, sql } from "drizzle-orm";

import type { DbExecutor } from "@/persistence/foundation/db-types";
import { contactChangeProposals, contacts, documentContacts } from "@/persistence/schema/contacts";
import { documents } from "@/persistence/schema/documents";
import type {
  ContactProposalRepository,
  ContactRepository,
  DocumentContactRepository,
} from "@/persistence/repositories/contracts/contacts-repository";

export function createDrizzleContactRepository(db: DbExecutor): ContactRepository {
  return {
    async create(input) {
      const [row] = await db.insert(contacts).values(input).returning();
      if (!row) throw new Error("insert into contacts returned no row");
      return row;
    },

    async findById(workspaceId, id) {
      const [row] = await db
        .select()
        .from(contacts)
        .where(and(eq(contacts.id, id), eq(contacts.workspaceId, workspaceId)))
        .limit(1);
      return row ?? null;
    },

    async list(workspaceId, filter) {
      const conditions = [eq(contacts.workspaceId, workspaceId)];

      const q = filter.q?.trim();
      if (q) {
        const pattern = `%${q}%`;
        const searchCondition = or(ilike(contacts.name, pattern), ilike(contacts.vatId, pattern), ilike(contacts.customerNumber, pattern));
        if (searchCondition) conditions.push(searchCondition);
      }
      if (filter.relationType) conditions.push(eq(contacts.relationType, filter.relationType));
      if (filter.verified === true) conditions.push(isNotNull(contacts.verifiedAt));
      if (filter.verified === false) conditions.push(isNull(contacts.verifiedAt));

      const offset = (filter.page - 1) * filter.pageSize;
      const limit = filter.pageSize + 1;

      const rows = await db
        .select()
        .from(contacts)
        .where(and(...conditions))
        // `name, id` tie-break for the same reason `documents.list` orders by `id` behind
        // `createdAt`: a deterministic order is required for offset pagination to never
        // skip/duplicate a row across pages.
        .orderBy(contacts.name, contacts.id)
        .limit(limit)
        .offset(offset);

      const hasMore = rows.length > filter.pageSize;
      return { items: hasMore ? rows.slice(0, filter.pageSize) : rows, hasMore };
    },

    listAllForWorkspace: (workspaceId) => db.select().from(contacts).where(eq(contacts.workspaceId, workspaceId)),

    async updateFields(workspaceId, id, patch) {
      const [row] = await db
        .update(contacts)
        .set({ ...patch, updatedAt: new Date() })
        .where(and(eq(contacts.id, id), eq(contacts.workspaceId, workspaceId)))
        .returning();
      return row ?? null;
    },

    async deleteById(workspaceId, id) {
      const [row] = await db
        .delete(contacts)
        .where(and(eq(contacts.id, id), eq(contacts.workspaceId, workspaceId)))
        .returning();
      return row ?? null;
    },
  };
}

export function createDrizzleDocumentContactRepository(db: DbExecutor): DocumentContactRepository {
  return {
    async link({ documentId, contactId, role }) {
      await db.insert(documentContacts).values({ documentId, contactId, role }).onConflictDoNothing();
    },

    async unlink(documentId, contactId, role) {
      await db
        .delete(documentContacts)
        .where(and(eq(documentContacts.documentId, documentId), eq(documentContacts.contactId, contactId), eq(documentContacts.role, role)));
    },

    // Workspace-scoped via an `exists` subquery rather than a join (Postgres `DELETE` has no
    // plain join syntax) - same defense-in-depth reasoning as `listForDocument`/
    // `listForContact` below: a `documentId` from another workspace matches the `exists`
    // clause for no row and this call is a no-op.
    async unlinkAllForDocument(workspaceId, documentId) {
      await db.delete(documentContacts).where(
        and(
          eq(documentContacts.documentId, documentId),
          exists(
            db
              .select({ one: sql`1` })
              .from(documents)
              .where(and(eq(documents.id, documentId), eq(documents.workspaceId, workspaceId))),
          ),
        ),
      );
    },

    // F5 (decisions/0027-hardening-and-deletion.md): joins `documents` purely to add the
    // `workspace_id` filter (`document_contacts` itself has no such column) - every existing
    // caller already pre-validated `documentId` against the workspace, but this makes the
    // guarantee hold at the query level too.
    listForDocument: (workspaceId, documentId) =>
      db
        .select({
          documentId: documentContacts.documentId,
          contactId: documentContacts.contactId,
          role: documentContacts.role,
          createdAt: documentContacts.createdAt,
          contactName: contacts.name,
        })
        .from(documentContacts)
        .innerJoin(contacts, eq(contacts.id, documentContacts.contactId))
        .innerJoin(documents, eq(documents.id, documentContacts.documentId))
        .where(and(eq(documentContacts.documentId, documentId), eq(documents.workspaceId, workspaceId)))
        .orderBy(documentContacts.role),

    // F5: same defense-in-depth as `listForDocument` above, filtered on `contacts.workspace_id`
    // (already joined here for `originalFileName`/`documentCreatedAt`, `contacts` is the new join).
    listForContact: (workspaceId, contactId) =>
      db
        .select({
          documentId: documentContacts.documentId,
          contactId: documentContacts.contactId,
          role: documentContacts.role,
          createdAt: documentContacts.createdAt,
          originalFileName: documents.originalFileName,
          documentCreatedAt: documents.createdAt,
        })
        .from(documentContacts)
        .innerJoin(documents, eq(documents.id, documentContacts.documentId))
        .innerJoin(contacts, eq(contacts.id, documentContacts.contactId))
        .where(and(eq(documentContacts.contactId, contactId), eq(contacts.workspaceId, workspaceId)))
        .orderBy(desc(documents.createdAt)),

    async moveContactLinks(fromContactId, toContactId) {
      const links = await db.select().from(documentContacts).where(eq(documentContacts.contactId, fromContactId));
      for (const link of links) {
        await db
          .insert(documentContacts)
          .values({ documentId: link.documentId, contactId: toContactId, role: link.role })
          .onConflictDoNothing();
      }
      await db.delete(documentContacts).where(eq(documentContacts.contactId, fromContactId));
    },
  };
}

export function createDrizzleContactProposalRepository(db: DbExecutor): ContactProposalRepository {
  return {
    async create(input) {
      const [row] = await db.insert(contactChangeProposals).values(input).returning();
      if (!row) throw new Error("insert into contact_change_proposals returned no row");
      return row;
    },

    async findById(workspaceId, id) {
      const [row] = await db
        .select()
        .from(contactChangeProposals)
        .where(and(eq(contactChangeProposals.id, id), eq(contactChangeProposals.workspaceId, workspaceId)))
        .limit(1);
      return row ?? null;
    },

    listForWorkspace: (workspaceId, filter) =>
      db
        .select()
        .from(contactChangeProposals)
        .where(
          filter?.status
            ? and(eq(contactChangeProposals.workspaceId, workspaceId), eq(contactChangeProposals.status, filter.status))
            : eq(contactChangeProposals.workspaceId, workspaceId),
        )
        .orderBy(desc(contactChangeProposals.createdAt)),

    listForContact: (workspaceId, contactId) =>
      db
        .select()
        .from(contactChangeProposals)
        .where(and(eq(contactChangeProposals.workspaceId, workspaceId), eq(contactChangeProposals.contactId, contactId)))
        .orderBy(desc(contactChangeProposals.createdAt)),

    async decide(workspaceId, id, { status, decidedByUserId, decidedAt }) {
      const [row] = await db
        .update(contactChangeProposals)
        .set({ status, decidedByUserId, decidedAt })
        .where(
          and(
            eq(contactChangeProposals.id, id),
            eq(contactChangeProposals.workspaceId, workspaceId),
            eq(contactChangeProposals.status, "pending"),
          ),
        )
        .returning();
      return row ?? null;
    },

    async moveContactProposals(fromContactId, toContactId) {
      await db.update(contactChangeProposals).set({ contactId: toContactId }).where(eq(contactChangeProposals.contactId, fromContactId));
    },
  };
}
