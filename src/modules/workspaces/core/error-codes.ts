// Stable error codes (AGENTS.md "Code": `as const` sets, never raw text). `ui/*.tsx` maps
// these to next-intl message keys under the relevant namespace's `errors` object. Mirrors
// `src/persistence/use-cases/workspaces-use-cases.ts`'s `WORKSPACE_ERROR` plus
// `invalid_input` (Zod parse failures in `actions.ts`, before a use case ever runs),
// `src/platform/access`'s `WorkspaceAccessErrorCode` (`unauthenticated`/`no_workspace`/
// `forbidden`, surfaced by `requirePermission`), and `unknown` (anything else).
export const WORKSPACE_ACTION_ERROR_CODES = [
  "invalid_input",
  "already_in_workspace",
  "not_found",
  "cannot_remove_self",
  "invitation_cap_reached",
  "invitation_not_found",
  "invitation_expired",
  "invitation_already_used",
  "invitation_email_mismatch",
  "confirmation_mismatch",
  "cannot_leave_as_admin",
  // decisions/0034-extended-company-profile.md: `createWorkspaceAction` also calls
  // `updateCompanyProfile` right after `createForUser` (same as `updateCompanyProfileAction`
  // below), and onboarding collects `aliases` - the only extended-profile field that can
  // possibly fail there.
  "alias_too_generic",
  "unauthenticated",
  "no_workspace",
  "forbidden",
  "unknown",
] as const;
export type WorkspaceActionErrorCode = (typeof WORKSPACE_ACTION_ERROR_CODES)[number];

/** `updateCompanyProfileAction` (C2, decisions/0021-extraction-direction-and-invoice-fields.md;
 * extended by decisions/0034-extended-company-profile.md's H1). Mirrors `WORKSPACE_ERROR.notFound`
 * (a workspace deleted concurrently), the three extended-profile validation codes
 * (`aliasTooGeneric`/`invalidIban`/`invalidDomain`), plus `invalid_input` and
 * `src/platform/access`'s `WorkspaceAccessErrorCode`. */
export const COMPANY_PROFILE_ACTION_ERROR_CODES = [
  "invalid_input",
  "not_found",
  "alias_too_generic",
  "invalid_iban",
  "invalid_domain",
  "unauthenticated",
  "no_workspace",
  "forbidden",
  "unknown",
] as const;
export type CompanyProfileActionErrorCode = (typeof COMPANY_PROFILE_ACTION_ERROR_CODES)[number];
