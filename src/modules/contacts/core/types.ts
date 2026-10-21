// Owner: src/modules/contacts (decisions/0019-contacts.md). Pure, framework-free domain
// types and enum constants. This is the SINGLE SOURCE for the enums below - `documents`'s
// FK targets (`workspaces.ts` importing `TIERS` from `@/modules/billing`, `ROLES` from
// `@/platform/access`) is the established pattern this file follows:
// `src/persistence/schema/contacts.ts` imports these constants for its `pgTable(..., {
// enum: ... })` columns rather than declaring its own copy.
export const CONTACT_SOURCES = ["auto", "manual"] as const;
export type ContactSource = (typeof CONTACT_SOURCES)[number];

/** "Firmenkontakte" relationship to the workspace's own company. Nullable on the row - a
 * contact extracted from a document may have no determinable relationship yet. */
export const CONTACT_RELATION_TYPES = ["supplier", "customer", "authority", "insurance", "bank", "other"] as const;
export type ContactRelationType = (typeof CONTACT_RELATION_TYPES)[number];

/** Why a contact is linked to a specific document. More than one contact can carry the
 * `sender` role for entirely legitimate reasons a single-sender assumption would break:
 * a debt-collection agency writing on behalf of a creditor, a lawyer writing for a client,
 * or an insurer/tax advisor CC'd on the same letter - `on_behalf_of` and `mentioned` exist
 * precisely so the inbox still knows which contact actually sent the letter. */
export const DOCUMENT_CONTACT_ROLES = ["sender", "recipient", "on_behalf_of", "mentioned"] as const;
export type DocumentContactRole = (typeof DOCUMENT_CONTACT_ROLES)[number];

/** A change proposal never auto-applies (see decisions/0019-contacts.md's no-silent-overwrite
 * rule): it stays `pending` until a human `accept`s or `reject`s it. */
export const CONTACT_PROPOSAL_STATUSES = ["pending", "accepted", "rejected"] as const;
export type ContactProposalStatus = (typeof CONTACT_PROPOSAL_STATUSES)[number];

/**
 * The full set of fields the processing pipeline (C2) can extract about a company contact
 * from a document. Only `name` is required - every other field is optional because
 * extraction must never fail just because a field is missing from the scanned letter.
 * Mirrors `contacts` table columns 1:1 (minus provenance/matching-derived columns, which the
 * use case computes) so `upsertFromExtraction`'s mapping stays a straight pass-through.
 */
export type ExtractedContactData = {
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
  notes?: string | null;
};

/** The subset of `ExtractedContactData`'s field names this module ever compares/fills -
 * `name` is handled separately (it always drives matching, never a plain fill/contradiction
 * diff entry) so it is excluded here. */
export const COMPARABLE_CONTACT_FIELDS = [
  "legalForm",
  "addressLine1",
  "addressLine2",
  "postalCode",
  "city",
  "country",
  "vatId",
  "taxNumber",
  "registerCourt",
  "registerNumber",
  "leitwegId",
  "iban",
  "bic",
  "bankName",
  "accountHolder",
  "sepaCreditorId",
  "phone",
  "email",
  "website",
  "contactPerson",
  "customerNumber",
  "supplierNumber",
  "paymentTermsDays",
  "notes",
] as const satisfies readonly (keyof ExtractedContactData)[];
export type ComparableContactField = (typeof COMPARABLE_CONTACT_FIELDS)[number];

/** The minimal shape `pickBestMatch` needs from an existing contact row - deliberately not
 * the persistence layer's `ContactRow` (this module never imports from `src/persistence`,
 * keeping it usable from both the use case and, later, C3's UI without a layering
 * violation). */
export type ContactMatchCandidate = {
  id: string;
  nameNormalized: string;
  postalCode: string | null;
  vatIdNormalized: string | null;
  registerCourt: string | null;
  registerNumber: string | null;
  ibanNormalized: string | null;
  customerNumber: string | null;
};

/** The workspace's own company profile (`workspaces-use-cases.ts`'s `getCompanyProfile`),
 * used by `isOwnCompany` below - kept minimal and persistence-free for the same reason as
 * `ContactMatchCandidate`. Extended by decisions/0034-extended-company-profile.md:
 * `aliases`/`ibans`/`domains` are expected ALREADY NORMALIZED by whoever builds this value
 * (`normalizeName`/`normalizeIban`/lowercased-host-only respectively, see
 * `src/persistence/use-cases/documents-use-cases.ts`'s `toOwnCompanyProfile`) - `isOwnCompany`
 * itself never re-normalizes them, only the `extracted` side it is comparing against.
 * `ibans` is real data (populated, validated, editable in settings) but deliberately NOT one
 * of `isOwnCompany`'s own match rules (see that function's doc comment for why) - it exists on
 * this type for OTHER consumers: the reminder-direction override and the bank-detection/
 * IBAN-stripping logic that runs independently of whether a party is "own company" at all. */
export type OwnCompanyProfile = {
  name: string;
  postalCode: string | null;
  vatId: string | null;
  /** Already normalized with `normalizeName` - a whole-name match, never a substring. */
  aliases: string[];
  /** Already normalized with `normalizeIban`. Not consulted by `isOwnCompany` itself - see
   * that function's own doc comment. */
  ibans: string[];
  /** Already lowercased, host only (no scheme, no `www.`, no path). */
  domains: string[];
  taxNumber: string | null;
  registerCourt: string | null;
  registerNumber: string | null;
};
