// Owner: src/modules/contacts (decisions/0019-contacts.md). `CONTACT_FORMAT_WARNING` backs
// `format-checks.ts`'s non-blocking IBAN/VAT warnings - a UI (C3) translates these codes to
// copy, never the reverse (AGENTS.md "Code"). The persistence use case's own `as const`
// error-code set (`CONTACT_ERROR`, thrown as `UseCaseError`) lives in
// `src/persistence/use-cases/contacts-use-cases.ts`, matching every other owner area's
// pattern (`DOCUMENT_ERROR`/`WORKSPACE_ERROR` also live beside their use case, not in the
// module) - this module has no Server Action layer yet (C3 adds one) to need its own mapped
// action-error-code set the way `src/modules/workspaces/core/error-codes.ts` does today.
export const CONTACT_FORMAT_WARNING = {
  invalidIban: "invalid_iban_format",
  invalidVatId: "invalid_vat_format",
} as const;
export type ContactFormatWarning = (typeof CONTACT_FORMAT_WARNING)[keyof typeof CONTACT_FORMAT_WARNING];

/**
 * C3 addition (contacts UI): the Server Action layer's own error-code set, mirroring
 * `src/persistence/use-cases/contacts-use-cases.ts`'s `CONTACT_ERROR` plus `invalid_input`
 * (Zod parse failures) and `src/platform/access`'s `WorkspaceAccessErrorCode` - same pattern
 * as `src/modules/documents/core/error-codes.ts`'s `DOCUMENT_ACTION_ERROR_CODES`. Lives
 * beside `CONTACT_FORMAT_WARNING` rather than in a new file, matching how this module keeps
 * every stable error-code set in this one file.
 */
export const CONTACT_ACTION_ERROR_CODES = [
  "invalid_input",
  "not_found",
  "document_not_found",
  "proposal_not_found",
  "cannot_merge_self",
  // decisions/0037-correction-buttons.md: `markContactAsOwnCompanyAction`/
  // `markContactAsOwnBankAction` also call `src/modules/workspaces`'s `addCompanyAlias`/
  // `addCompanyIban` (`src/persistence/use-cases/workspaces-use-cases.ts`'s `WORKSPACE_ERROR`)
  // before ever deleting the contact - `alias_too_generic`/`invalid_iban` are that use case's
  // own stable codes, surfaced here unchanged rather than remapped to `invalid_input`, so the
  // admin sees the same specific message `/dashboard/settings/company` already shows for the
  // same underlying rejection. `contact_missing_iban` is this module's own code: "Das ist
  // unsere Bank" refuses to delete the contact when it carries no usable IBAN at all, rather
  // than either failing silently or deleting a contact with nothing to remember.
  "alias_too_generic",
  "invalid_iban",
  "contact_missing_iban",
  "unauthenticated",
  "no_workspace",
  "forbidden",
  "unknown",
] as const;
export type ContactActionErrorCode = (typeof CONTACT_ACTION_ERROR_CODES)[number];
