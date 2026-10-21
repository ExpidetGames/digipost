// Neutral entrypoint of src/modules/contacts (WEBAPP_TEMPLATE_SPEC.md §4.2): pure domain
// logic only (no I/O, no `server-only`, no `"use client"`) - safe to import from
// `src/persistence/schema/**` (the enum constants), `src/persistence/use-cases/contacts-use-cases.ts`
// (everything), and later from C2's pipeline code and C3's UI alike.
export {
  COMPARABLE_CONTACT_FIELDS,
  CONTACT_PROPOSAL_STATUSES,
  CONTACT_RELATION_TYPES,
  CONTACT_SOURCES,
  DOCUMENT_CONTACT_ROLES,
  type ComparableContactField,
  type ContactMatchCandidate,
  type ContactProposalStatus,
  type ContactRelationType,
  type ContactSource,
  type DocumentContactRole,
  type ExtractedContactData,
  type OwnCompanyProfile,
} from "./core/types";
export {
  nameSimilarity,
  normalizeIban,
  normalizeName,
  normalizePlainText,
  normalizeVatId,
  shortenCompanyName,
  SHORT_COMPANY_NAME_MAX_LENGTH,
} from "./core/normalizers";
export {
  MATCH_RULES,
  normalizeExtractedForMatching,
  pickBestMatch,
  type MatchResult,
  type MatchRule,
  type MatchStrength,
  type NormalizedExtractedContact,
} from "./core/matching";
export {
  computeContactUpdatePlan,
  type ContactFieldPatch,
  type ExistingContactForDiff,
  type FieldProposal,
} from "./core/verification";
export { isOwnCompany, OWN_COMPANY_NAME_SIMILARITY_THRESHOLD } from "./core/own-company";
export { isLikelyBank } from "./core/bank-detection";
export { checkContactFormats, isPlausibleVatId, isValidIbanFormat } from "./core/format-checks";
export {
  CONTACT_ACTION_ERROR_CODES,
  CONTACT_FORMAT_WARNING,
  type ContactActionErrorCode,
  type ContactFormatWarning,
} from "./core/error-codes";
export {
  contactListQuerySchema,
  manualContactCreateSchema,
  manualContactUpdateSchema,
  updateContactInputSchema,
  verifyContactInputSchema,
  deleteContactInputSchema,
  markContactAsOwnCompanyInputSchema,
  markContactAsOwnBankInputSchema,
  mergeContactsInputSchema,
  acceptProposalInputSchema,
  rejectProposalInputSchema,
  unlinkDocumentInputSchema,
  type ManualContactCreateInput,
  type ManualContactUpdateInput,
  type UpdateContactInput,
} from "./core/schemas";
