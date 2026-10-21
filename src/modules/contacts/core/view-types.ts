// C3 addition (contacts UI): neutral UI-facing DTOs, dates as ISO strings, mirroring
// `src/modules/documents/core/types.ts`'s/`src/modules/workspaces/core/types.ts`'s own
// convention. Kept in a separate file from `./types.ts` (C1's domain types: enums,
// `ExtractedContactData`, `ContactMatchCandidate`, `OwnCompanyProfile`) so this phase's
// additions never touch that file.
import type { ContactRelationType, DocumentContactRole } from "./types";

export type ContactListItem = {
  id: string;
  name: string;
  relationType: ContactRelationType | null;
  vatId: string | null;
  customerNumber: string | null;
  verified: boolean;
  /** Aggregated per-row for the list view (decisions/0019-contacts.md's C1 contract has no
   * count-bearing list method - see this module's README "Known gaps" for the accepted
   * N+1 tradeoff this read model makes to fill that in). */
  documentsCount: number;
  pendingProposalsCount: number;
};

export type ContactListView = {
  items: ContactListItem[];
  hasMore: boolean;
  page: number;
};

/** Every editable field, always a string for a form's `defaultValue`/controlled input -
 * `paymentTermsDays` included as a string too, parsed back to a number by
 * `manualContactUpdateSchema`'s `z.coerce.number()` on submit. */
export type ContactFieldsView = {
  name: string;
  legalForm: string;
  addressLine1: string;
  addressLine2: string;
  postalCode: string;
  city: string;
  country: string;
  vatId: string;
  taxNumber: string;
  registerCourt: string;
  registerNumber: string;
  leitwegId: string;
  iban: string;
  bic: string;
  bankName: string;
  accountHolder: string;
  sepaCreditorId: string;
  phone: string;
  email: string;
  website: string;
  contactPerson: string;
  customerNumber: string;
  supplierNumber: string;
  paymentTermsDays: string;
  relationType: ContactRelationType | "";
  notes: string;
};

export type ContactDocumentLinkView = {
  documentId: string;
  role: DocumentContactRole;
  originalFileName: string;
  documentCreatedAt: string;
};

export type ContactProposalView = {
  id: string;
  field: string;
  currentValue: string | null;
  proposedValue: string | null;
  createdAt: string;
};

export type ContactDetailView = {
  id: string;
  fields: ContactFieldsView;
  verified: boolean;
  verifiedAt: string | null;
  verifiedByName: string | null;
  documents: ContactDocumentLinkView[];
  pendingProposals: ContactProposalView[];
};

export type ContactMergeOption = { id: string; name: string };

/** One row in the `/dashboard/contacts` "Änderungsvorschläge" section - the global entry
 * point to pending proposals (scope item 3): resolves each proposal's own contact name so
 * the list page never needs a second round trip per row. */
export type PendingProposalSummary = {
  id: string;
  contactId: string;
  contactName: string;
  field: string;
  currentValue: string | null;
  proposedValue: string | null;
};
