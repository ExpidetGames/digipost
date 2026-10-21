// Owner: src/modules/contacts (decisions/0019-contacts.md). Contracts only: no Drizzle
// import here besides type-only schema references, erased at runtime (WEBAPP_TEMPLATE_SPEC.md
// §5.1 "contracts separate from Drizzle").
//
// Three repositories, one owner, matching the three tables in
// `src/persistence/schema/contacts.ts`. Every workspace-scoped method takes and filters on
// `workspaceId` explicitly, even though the use case will already have resolved it from the
// caller's own session membership (`src/persistence/README.md`'s "only the owner writes"
// note). `document_contacts` has no `workspace_id` column of its own (both `document_id` and
// `contact_id` already resolve to a workspace via their own FKs) - `link`/`unlink` still take
// `documentId`/`contactId` directly, since the use case has already verified both belong to
// the caller's workspace before ever calling them (nothing is read back from those two
// methods, so there is nothing for a cross-workspace id to leak). `listForDocument`/
// `listForContact` are different: they RETURN rows to a caller, so F5's review pass
// (decisions/0027-hardening-and-deletion.md) added an explicit `workspaceId` parameter and a
// join-based filter to both - every existing caller already pre-validated the id against the
// workspace before this change, but the query itself enforcing it too means a future caller
// that forgets that pre-check fails closed instead of silently leaking a cross-workspace
// document/contact link.
import type { InferSelectModel } from "drizzle-orm";

import type { contactChangeProposals, contacts, documentContacts } from "@/persistence/schema/contacts";

export type ContactRow = InferSelectModel<typeof contacts>;
export type DocumentContactRow = InferSelectModel<typeof documentContacts>;
export type ContactChangeProposalRow = InferSelectModel<typeof contactChangeProposals>;

export type CreateContactRow = {
  workspaceId: string;
  name: string;
  legalForm?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  postalCode?: string | null;
  city?: string | null;
  country?: string | null;
  vatId?: string | null;
  taxNumber?: string | null;
  registerCourt?: string | null;
  registerNumber?: string | null;
  leitwegId?: string | null;
  iban?: string | null;
  bic?: string | null;
  bankName?: string | null;
  accountHolder?: string | null;
  sepaCreditorId?: string | null;
  phone?: string | null;
  email?: string | null;
  website?: string | null;
  contactPerson?: string | null;
  customerNumber?: string | null;
  supplierNumber?: string | null;
  paymentTermsDays?: number | null;
  relationType?: ContactRow["relationType"];
  notes?: string | null;
  /** `"auto"` for a pipeline-created contact, `"manual"` for one a human created by hand -
   * immutable after creation (an edit never changes how a contact originated). */
  source: ContactRow["source"];
  verifiedAt: Date | null;
  verifiedByUserId?: string | null;
  firstSeenDocumentId?: string | null;
  /** Computed by `@/modules/contacts`'s pure normalizers, never typed by hand. */
  nameNormalized: string;
  vatIdNormalized?: string | null;
  ibanNormalized?: string | null;
};

/** A partial update to a contact's own fields - used both by `upsertFromExtraction`'s
 * fill-empty-fields step and by `updateManual`/`mergeContacts`. Deliberately excludes
 * `workspaceId` (never changes) and `source` (immutable after creation, see `CreateContactRow`). */
export type ContactFieldsPatch = Partial<
  Omit<CreateContactRow, "workspaceId" | "source"> & { nameNormalized: string; vatIdNormalized: string | null; ibanNormalized: string | null }
>;

export type ListContactsFilter = {
  /** Matched against name, VAT id, and customer number (case-insensitive substring). */
  q?: string;
  relationType?: ContactRow["relationType"];
  /** `true` = only verified contacts (`verified_at is not null`), `false` = only unverified,
   * `undefined` = no filter. */
  verified?: boolean;
  /** 1-based. */
  page: number;
  pageSize: number;
};

export type ListContactsResult = {
  items: ContactRow[];
  /** Whether a page after this one has at least one more matching row - offset pagination
   * without a separate `count(*)` query, same shape as `DocumentRepository.list`. */
  hasMore: boolean;
};

export interface ContactRepository {
  create(input: CreateContactRow): Promise<ContactRow>;
  findById(workspaceId: string, id: string): Promise<ContactRow | null>;
  list(workspaceId: string, filter: ListContactsFilter): Promise<ListContactsResult>;
  /** Every contact in the workspace, unpaginated - the candidate pool for
   * `@/modules/contacts`'s pure `pickBestMatch` (acceptable at this product's scale, a small
   * business's own contact book). Never used for display; `list` is the paginated,
   * filterable read model for that. */
  listAllForWorkspace(workspaceId: string): Promise<ContactRow[]>;
  updateFields(workspaceId: string, id: string, patch: ContactFieldsPatch): Promise<ContactRow | null>;
  /** `null` (not an error) if the contact does not exist in this workspace. */
  deleteById(workspaceId: string, id: string): Promise<ContactRow | null>;
}

export type DocumentContactWithContact = DocumentContactRow & { contactName: string };
export type DocumentContactWithDocument = DocumentContactRow & { originalFileName: string; documentCreatedAt: Date };

export interface DocumentContactRepository {
  /** Idempotent: linking the same `(documentId, contactId, role)` twice is a no-op (backed
   * by the composite primary key, via `onConflictDoNothing`). */
  link(input: { documentId: string; contactId: string; role: DocumentContactRow["role"] }): Promise<void>;
  unlink(documentId: string, contactId: string, role: DocumentContactRow["role"]): Promise<void>;
  /** `replaceDocumentLinks` (decisions/0035-contact-links-replace-and-bank-detection.md):
   * removes EVERY link this document currently has, regardless of role, so a reprocessing
   * run can rewrite them from scratch instead of appending to the pile left by earlier runs.
   * Workspace-scoped the same way `listForDocument`/`listForContact` are (F5,
   * decisions/0027-hardening-and-deletion.md): a `documentId` that does not belong to
   * `workspaceId` removes nothing, enforced by the query itself, not only by the caller
   * having already validated it. */
  unlinkAllForDocument(workspaceId: string, documentId: string): Promise<void>;
  /** F5 (decisions/0027-hardening-and-deletion.md): `workspaceId` is enforced by an explicit
   * join filter (`documents.workspace_id`), not only by the caller having already validated
   * `documentId` - a mismatched `workspaceId` returns `[]`, never another workspace's links. */
  listForDocument(workspaceId: string, documentId: string): Promise<DocumentContactWithContact[]>;
  /** F5: same defense-in-depth as `listForDocument` above, filtered on `contacts.workspace_id`. */
  listForContact(workspaceId: string, contactId: string): Promise<DocumentContactWithDocument[]>;
  /** `mergeContacts`: repoints every link from `fromContactId` to `toContactId`, skipping any
   * link `toContactId` already has for the same `(documentId, role)` (the composite primary
   * key would otherwise reject the repoint) rather than failing the whole merge. */
  moveContactLinks(fromContactId: string, toContactId: string): Promise<void>;
}

export type CreateProposalRow = {
  workspaceId: string;
  contactId: string;
  documentId: string | null;
  field: string;
  currentValue: string | null;
  proposedValue: string | null;
};

export interface ContactProposalRepository {
  create(input: CreateProposalRow): Promise<ContactChangeProposalRow>;
  findById(workspaceId: string, id: string): Promise<ContactChangeProposalRow | null>;
  listForWorkspace(workspaceId: string, filter?: { status?: ContactChangeProposalRow["status"] }): Promise<ContactChangeProposalRow[]>;
  listForContact(workspaceId: string, contactId: string): Promise<ContactChangeProposalRow[]>;
  /** `null` (not an error) if the proposal does not exist in this workspace, or is not
   * currently `pending` (`decide` never re-decides an already-decided proposal). */
  decide(
    workspaceId: string,
    id: string,
    input: { status: "accepted" | "rejected"; decidedByUserId: string; decidedAt: Date },
  ): Promise<ContactChangeProposalRow | null>;
  /** `mergeContacts`: repoints every proposal from `fromContactId` to `toContactId` - a
   * proposal against the (now-deleted) source contact must still be reachable from the
   * surviving one. */
  moveContactProposals(fromContactId: string, toContactId: string): Promise<void>;
}
