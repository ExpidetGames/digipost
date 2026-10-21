// Owner: src/modules/contacts (decisions/0019-contacts.md). Only repositories of this owner
// write to these tables (§5.7 "only the owner writes").
//
// `contacts`: workspace-scoped "Firmenkontakte" extracted from documents (or created by
// hand). Only `name` is required - extraction must never fail for a missing field. Two
// columns exist purely so matching (`@/modules/contacts`'s `pickBestMatch`) can compare
// cheaply and consistently: `name_normalized`/`vat_id_normalized`/`iban_normalized` are
// always computed by the use case from the module's pure normalizers, never typed by hand
// and never computed in SQL (unlike `documents.search_vector`, there is no single SQL
// expression that reproduces "strip legal-form suffixes" - this needed application code, not
// a generated column).
//
// Provenance/trust columns (`source`, `verified_at`, `verified_by_user_id`) back
// decisions/0019's verification semantics: a pipeline-created contact starts unverified
// (`source: "auto"`, `verified_at: null`); ANY pipeline-made change (even filling a
// previously-empty field) resets `verified_at` back to `null`; a human creating or saving a
// contact by hand always sets `verified_at`/`verified_by_user_id` (they just looked at it).
// The pipeline NEVER overwrites a non-empty field, verified or not - a contradicting
// extracted value always becomes a `contact_change_proposals` row instead (see that table's
// own comment for why: a changed IBAN on a supplier invoice is a classic invoice-fraud
// pattern, and silently overwriting it would be the worst possible behavior).
//
// No unique index on `(workspace_id, iban_normalized)`, unlike the one on
// `(workspace_id, vat_id_normalized)`: a bank account can legitimately be shared by two
// distinct legal entities (a factoring arrangement, a tax advisor collecting payments for
// several clients, a group's shared treasury account), so two different, correctly-modeled
// contacts sharing one IBAN is a real, non-error state this schema must allow. Matching
// still uses `iban_normalized` (decisions/0019's rule 3) but only treats it as a match when
// exactly one contact in the workspace currently holds that IBAN - `@/modules/contacts`'s
// `pickBestMatch` treats more than one as ambiguous, not a match.
import { check, index, integer, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { CONTACT_PROPOSAL_STATUSES, CONTACT_RELATION_TYPES, CONTACT_SOURCES, DOCUMENT_CONTACT_ROLES } from "@/modules/contacts";

import { user } from "./auth";
import { documents } from "./documents";
import { workspaces } from "./workspaces";

export const contacts = pgTable(
  "contacts",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),

    // Identity
    name: text().notNull(),
    legalForm: text(),
    addressLine1: text(),
    addressLine2: text(),
    postalCode: text(),
    city: text(),
    country: text().default("DE"),

    // Tax / register
    vatId: text(),
    taxNumber: text(),
    registerCourt: text(),
    registerNumber: text(),
    leitwegId: text(),

    // Banking
    iban: text(),
    bic: text(),
    bankName: text(),
    accountHolder: text(),
    sepaCreditorId: text(),

    // Communication
    phone: text(),
    email: text(),
    website: text(),
    contactPerson: text(),

    // Relationship
    customerNumber: text(),
    supplierNumber: text(),
    paymentTermsDays: integer(),
    relationType: text({ enum: CONTACT_RELATION_TYPES }),
    notes: text(),

    // Provenance / trust
    source: text({ enum: CONTACT_SOURCES }).notNull(),
    verifiedAt: timestamp({ withTimezone: true }),
    verifiedByUserId: uuid().references(() => user.id, { onDelete: "set null" }),
    firstSeenDocumentId: uuid().references(() => documents.id, { onDelete: "set null" }),

    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),

    // Matching columns, maintained by application code from `@/modules/contacts`'s pure
    // normalizers - never written directly from raw user/extraction input.
    nameNormalized: text().notNull(),
    vatIdNormalized: text(),
    ibanNormalized: text(),
  },
  (t) => [
    check(
      "contacts_relation_type_check",
      sql`${t.relationType} is null or ${t.relationType} in ('supplier', 'customer', 'authority', 'insurance', 'bank', 'other')`,
    ),
    check("contacts_source_check", sql`${t.source} in ('auto', 'manual')`),
    uniqueIndex("contacts_workspace_vat_normalized_key")
      .on(t.workspaceId, t.vatIdNormalized)
      .where(sql`${t.vatIdNormalized} is not null`),
    // Not unique (see header comment) - only an index, for `pickBestMatch`'s rule-3 lookup.
    index("contacts_workspace_iban_normalized_idx").on(t.workspaceId, t.ibanNormalized),
    index("contacts_workspace_name_normalized_postal_idx").on(t.workspaceId, t.nameNormalized, t.postalCode),
    index("contacts_workspace_name_idx").on(t.workspaceId, t.name),
  ],
);

/**
 * Which contact played what part on a given document. More than one contact can carry the
 * SAME role on the same document (e.g. two `mentioned` contacts), and a single document can
 * have contacts in several different roles at once - a debt-collection letter, a lawyer
 * writing on behalf of a client, or an insurer/tax advisor CC'd on the same letter routinely
 * put two or more foreign companies on one piece of mail, and the inbox must still know
 * which one actually sent it (`role: "sender"`) versus who it is merely about
 * (`"on_behalf_of"`/`"mentioned"`).
 */
export const documentContacts = pgTable(
  "document_contacts",
  {
    documentId: uuid()
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    contactId: uuid()
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    role: text({ enum: DOCUMENT_CONTACT_ROLES }).notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.documentId, t.contactId, t.role] }),
    check("document_contacts_role_check", sql`${t.role} in ('sender', 'recipient', 'on_behalf_of', 'mentioned')`),
    // The composite primary key's own index already covers "every contact for a document"
    // (a leftmost-prefix lookup on `document_id`); only the reverse direction needs an
    // index of its own.
    index("document_contacts_contact_idx").on(t.contactId),
  ],
);

/**
 * A pipeline-extracted value that CONTRADICTS a field already set on an already-VERIFIED (or
 * simply non-empty) contact never overwrites it (decisions/0019-contacts.md's
 * no-silent-overwrite rule) - it is recorded here instead, `pending` until a human
 * `acceptProposal`s or `rejectProposal`s it (`src/persistence/use-cases/contacts-use-cases.ts`).
 * `current_value`/`proposed_value` are stored as plain text (not typed per-field) since a
 * proposal is a display/decision record, never written back through anything but the
 * explicit `acceptProposal` path.
 */
export const contactChangeProposals = pgTable(
  "contact_change_proposals",
  {
    id: uuid().primaryKey().defaultRandom(),
    // Denormalized from `contacts.workspace_id` (both cascade together): every proposal
    // query in `src/persistence/use-cases/contacts-use-cases.ts` (`listProposals`) needs a
    // "for this workspace" filter, and a direct column avoids a join for that common case -
    // the same tradeoff `documents.workspace_id` makes despite other document columns also
    // implying a workspace indirectly.
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    contactId: uuid()
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    // Nullable, `onDelete: "set null"`: a proposal is a fraud-relevant audit record: it
    // should survive the source document being deleted later, even though it loses the
    // ability to show that document's own content at that point.
    documentId: uuid().references(() => documents.id, { onDelete: "set null" }),
    field: text().notNull(),
    currentValue: text(),
    proposedValue: text(),
    status: text({ enum: CONTACT_PROPOSAL_STATUSES }).notNull().default("pending"),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp({ withTimezone: true }),
    decidedByUserId: uuid().references(() => user.id, { onDelete: "set null" }),
  },
  (t) => [
    check("contact_change_proposals_status_check", sql`${t.status} in ('pending', 'accepted', 'rejected')`),
    index("contact_change_proposals_workspace_status_idx").on(t.workspaceId, t.status),
    index("contact_change_proposals_contact_idx").on(t.contactId),
  ],
);
