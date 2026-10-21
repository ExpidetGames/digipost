// Contact helpers for e2e setup (WEBAPP_TEMPLATE_SPEC.md §10.4, decisions/0019-contacts.md).
// Talks to Postgres directly with `pg` (e2e imports no app code, `tests/e2e/helpers/db.ts`'s
// own header doc) - `tests/e2e/contacts.spec.ts` builds test contacts, documents, and
// proposals this way rather than driving the pipeline/UI to produce them, the same
// `createWorkspaceForUser`-style shortcut `tests/e2e/helpers/workspace.ts` already uses.
// Cleanup is implicit: `contacts`/`document_contacts`/`contact_change_proposals`/`documents`
// all cascade from `workspaces` (`on delete cascade`), which `tests/e2e/helpers/fixtures.ts`'s
// `adminUser` fixture already deletes in its own teardown.
import { ownerQuery } from "./db";

export type TestContact = { id: string; name: string };

/** Inserts a verified, manually-created contact directly - the same end state
 * `createContactAction` produces for the fields it is given. Every column beyond
 * `name`/`workspace_id` is optional on the table (`src/persistence/schema/contacts.ts`), so
 * only what a test actually needs is passed. */
export async function createTestContact(
  workspaceId: string,
  fields: {
    name: string;
    iban?: string;
    verifiedAt?: Date | null;
    relationType?: string;
  } = { name: "Testkontakt" },
): Promise<TestContact> {
  const nameNormalized = fields.name.trim().toLowerCase();
  const ibanNormalized = fields.iban ? fields.iban.replace(/\s+/g, "").toUpperCase() : null;
  const verifiedAt = fields.verifiedAt === undefined ? new Date() : fields.verifiedAt;

  const [row] = await ownerQuery<{ id: string; name: string }>(
    `insert into public.contacts
       (workspace_id, name, iban, relation_type, source, verified_at, name_normalized, iban_normalized)
     values ($1, $2, $3, $4, 'manual', $5, $6, $7)
     returning id, name`,
    [workspaceId, fields.name, fields.iban ?? null, fields.relationType ?? null, verifiedAt, nameNormalized, ibanNormalized],
  );
  if (!row) throw new Error(`createTestContact(${fields.name}) returned no row`);
  return row;
}

export type TestDocument = { id: string; originalFileName: string };

/** Inserts a minimal `done` document directly - just enough to satisfy `documents`'s
 * `not null` columns (`src/persistence/schema/documents.ts`) so a contact can be linked to
 * something real; no storage object is created (this spec never opens the document's own
 * file, only its detail page link/title). */
export async function createTestDocument(workspaceId: string, originalFileName = "testrechnung.pdf"): Promise<TestDocument> {
  const [row] = await ownerQuery<{ id: string; original_file_name: string }>(
    `insert into public.documents
       (workspace_id, original_file_name, mime_type, page_count, size_bytes, storage_key, status)
     values ($1, $2, 'application/pdf', 1, 1024, $3, 'done')
     returning id, original_file_name`,
    [workspaceId, originalFileName, `workspaces/${workspaceId}/documents/e2e-fixture/original.pdf`],
  );
  if (!row) throw new Error("createTestDocument returned no row");
  return { id: row.id, originalFileName: row.original_file_name };
}

export async function linkTestDocumentContact(
  documentId: string,
  contactId: string,
  role: "sender" | "recipient" | "on_behalf_of" | "mentioned" = "sender",
): Promise<void> {
  await ownerQuery(`insert into public.document_contacts (document_id, contact_id, role) values ($1, $2, $3)`, [
    documentId,
    contactId,
    role,
  ]);
}

/** Inserts a `pending` change proposal directly - the state `upsertFromExtraction` would
 * have produced for a contradicting extracted value (decisions/0019-contacts.md's
 * no-silent-overwrite rule), without driving the OCR/extraction pipeline to get there. */
export async function createTestProposal(
  workspaceId: string,
  contactId: string,
  fields: { field: string; currentValue: string | null; proposedValue: string | null; documentId?: string | null },
): Promise<{ id: string }> {
  const [row] = await ownerQuery<{ id: string }>(
    `insert into public.contact_change_proposals
       (workspace_id, contact_id, document_id, field, current_value, proposed_value, status)
     values ($1, $2, $3, $4, $5, $6, 'pending')
     returning id`,
    [workspaceId, contactId, fields.documentId ?? null, fields.field, fields.currentValue, fields.proposedValue],
  );
  if (!row) throw new Error("createTestProposal returned no row");
  return row;
}
