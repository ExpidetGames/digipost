// Typed in-memory fakes for `ContactRepository`/`DocumentContactRepository`/
// `ContactProposalRepository` (WEBAPP_TEMPLATE_SPEC.md §10.2): unit tests for
// `createContactUseCases` inject these instead of mocking with `vi.fn()`/`as never` casts.
import type {
  ContactChangeProposalRow,
  ContactProposalRepository,
  ContactRepository,
  ContactRow,
  CreateContactRow,
  CreateProposalRow,
  DocumentContactRepository,
  DocumentContactRow,
} from "@/persistence/repositories/contracts";

export function contactRow(overrides: Partial<ContactRow> & Pick<ContactRow, "workspaceId" | "name" | "nameNormalized" | "source">): ContactRow {
  return {
    id: crypto.randomUUID(),
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
    verifiedAt: null,
    verifiedByUserId: null,
    firstSeenDocumentId: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    vatIdNormalized: null,
    ibanNormalized: null,
    ...overrides,
  };
}

export function createFakeContactRepository(seed: ContactRow[] = []): { repo: ContactRepository; state: ContactRow[] } {
  const rows = [...seed];

  const repo: ContactRepository = {
    async create(input: CreateContactRow) {
      const row = contactRow(input);
      rows.push(row);
      return row;
    },
    async findById(workspaceId, id) {
      return rows.find((c) => c.id === id && c.workspaceId === workspaceId) ?? null;
    },
    async list(workspaceId, filter) {
      let items = rows.filter((c) => c.workspaceId === workspaceId);
      if (filter.q) {
        const q = filter.q.toLowerCase();
        items = items.filter(
          (c) => c.name.toLowerCase().includes(q) || c.vatId?.toLowerCase().includes(q) || c.customerNumber?.toLowerCase().includes(q),
        );
      }
      if (filter.relationType) items = items.filter((c) => c.relationType === filter.relationType);
      if (filter.verified === true) items = items.filter((c) => c.verifiedAt !== null);
      if (filter.verified === false) items = items.filter((c) => c.verifiedAt === null);
      items = [...items].sort((a, b) => a.name.localeCompare(b.name));

      const offset = (filter.page - 1) * filter.pageSize;
      const page = items.slice(offset, offset + filter.pageSize);
      return { items: page, hasMore: items.length > offset + filter.pageSize };
    },
    async listAllForWorkspace(workspaceId) {
      return rows.filter((c) => c.workspaceId === workspaceId);
    },
    async updateFields(workspaceId, id, patch) {
      const row = rows.find((c) => c.id === id && c.workspaceId === workspaceId);
      if (!row) return null;
      Object.assign(row, patch);
      row.updatedAt = new Date();
      return row;
    },
    async deleteById(workspaceId, id) {
      const index = rows.findIndex((c) => c.id === id && c.workspaceId === workspaceId);
      if (index === -1) return null;
      const [row] = rows.splice(index, 1);
      return row ?? null;
    },
  };

  return { repo, state: rows };
}

export function createFakeDocumentContactRepository(
  seed: DocumentContactRow[] = [],
  documents: Record<string, { originalFileName: string; createdAt: Date }> = {},
  contacts: Record<string, { name: string }> = {},
): { repo: DocumentContactRepository; state: DocumentContactRow[] } {
  const rows = [...seed];

  const repo: DocumentContactRepository = {
    async link({ documentId, contactId, role }) {
      const exists = rows.some((r) => r.documentId === documentId && r.contactId === contactId && r.role === role);
      if (exists) return;
      rows.push({ documentId, contactId, role, createdAt: new Date(0) });
    },
    async unlink(documentId, contactId, role) {
      const remaining = rows.filter((r) => !(r.documentId === documentId && r.contactId === contactId && r.role === role));
      rows.length = 0;
      rows.push(...remaining);
    },
    // Same caveat as `listForDocument` below: the real repository enforces `workspaceId` via
    // a join/`exists` subquery this fake has no join capability to reproduce, and every
    // caller (the use case) has already validated `documentId` against the workspace before
    // ever reaching this method. The real guarantee is proved against Postgres
    // (`src/persistence/tests/contacts-repository.db.test.ts`).
    async unlinkAllForDocument(_workspaceId, documentId) {
      const remaining = rows.filter((r) => r.documentId !== documentId);
      rows.length = 0;
      rows.push(...remaining);
    },
    // F5 (decisions/0027-hardening-and-deletion.md): the real repository now takes and
    // enforces `workspaceId` via a join (`src/persistence/repositories/drizzle/contacts-repository.ts`);
    // this fake accepts the same parameter for interface parity but cannot meaningfully
    // re-derive a workspace filter from `documentId`/`contactId` alone (it has no join
    // capability, and every caller of this use case already pre-validates the id anyway) - the
    // actual cross-workspace guarantee is proved against real Postgres
    // (`src/persistence/tests/contacts-repository.db.test.ts`), not by this in-memory fake.
    async listForDocument(_workspaceId, documentId) {
      return rows
        .filter((r) => r.documentId === documentId)
        .map((r) => ({ ...r, contactName: contacts[r.contactId]?.name ?? "Unknown" }));
    },
    async listForContact(_workspaceId, contactId) {
      return rows
        .filter((r) => r.contactId === contactId)
        .map((r) => ({
          ...r,
          originalFileName: documents[r.documentId]?.originalFileName ?? "unknown.pdf",
          documentCreatedAt: documents[r.documentId]?.createdAt ?? new Date(0),
        }));
    },
    async moveContactLinks(fromContactId, toContactId) {
      for (const link of rows.filter((r) => r.contactId === fromContactId)) {
        const alreadyExists = rows.some((r) => r.documentId === link.documentId && r.contactId === toContactId && r.role === link.role);
        if (!alreadyExists) rows.push({ ...link, contactId: toContactId });
      }
      const remaining = rows.filter((r) => r.contactId !== fromContactId);
      rows.length = 0;
      rows.push(...remaining);
    },
  };

  return { repo, state: rows };
}

export function proposalRow(
  overrides: Partial<ContactChangeProposalRow> & Pick<ContactChangeProposalRow, "workspaceId" | "contactId" | "field">,
): ContactChangeProposalRow {
  return {
    id: crypto.randomUUID(),
    documentId: null,
    currentValue: null,
    proposedValue: null,
    status: "pending",
    createdAt: new Date(0),
    decidedAt: null,
    decidedByUserId: null,
    ...overrides,
  };
}

export function createFakeContactProposalRepository(
  seed: ContactChangeProposalRow[] = [],
): { repo: ContactProposalRepository; state: ContactChangeProposalRow[] } {
  const rows = [...seed];

  const repo: ContactProposalRepository = {
    async create(input: CreateProposalRow) {
      const row = proposalRow(input);
      rows.push(row);
      return row;
    },
    async findById(workspaceId, id) {
      return rows.find((p) => p.id === id && p.workspaceId === workspaceId) ?? null;
    },
    async listForWorkspace(workspaceId, filter) {
      return rows.filter((p) => p.workspaceId === workspaceId && (!filter?.status || p.status === filter.status));
    },
    async listForContact(workspaceId, contactId) {
      return rows.filter((p) => p.workspaceId === workspaceId && p.contactId === contactId);
    },
    async decide(workspaceId, id, { status, decidedByUserId, decidedAt }) {
      const row = rows.find((p) => p.id === id && p.workspaceId === workspaceId && p.status === "pending");
      if (!row) return null;
      row.status = status;
      row.decidedByUserId = decidedByUserId;
      row.decidedAt = decidedAt;
      return row;
    },
    async moveContactProposals(fromContactId, toContactId) {
      for (const row of rows) {
        if (row.contactId === fromContactId) row.contactId = toContactId;
      }
    },
  };

  return { repo, state: rows };
}
