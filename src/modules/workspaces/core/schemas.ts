// Neutral validation for the workspaces module's Server Action inputs (WEBAPP_TEMPLATE_SPEC.md
// §2.5: every boundary is parsed with Zod). `src/persistence/use-cases/workspaces-use-cases.ts`
// re-checks the name length independently: this only produces a normalized value and a
// stable `invalid_input` error code before the request ever reaches the use case.
import { z } from "zod";

import {
  COMPANY_PROFILE_TEXT_MAX_LENGTH,
  MAX_COMPANY_PROFILE_LIST_ENTRIES,
  WORKSPACE_NAME_MAX_LENGTH,
  WORKSPACE_NAME_MIN_LENGTH,
} from "@/persistence/use-cases/workspaces-use-cases";

const workspaceName = z.string().trim().min(WORKSPACE_NAME_MIN_LENGTH).max(WORKSPACE_NAME_MAX_LENGTH);
const invitationEmail = z.string().trim().toLowerCase().max(320).pipe(z.email());

/** Company profile fields (decisions/0019-contacts.md's "own-company exclusion",
 * decisions/0021-extraction-direction-and-invoice-fields.md, C2): `addressLine2` and `vatId`
 * are optional, everything else required. `country` defaults to `"DE"` when blank/absent -
 * matching `contacts.country`'s own default and `updateCompanyProfile`'s own fallback
 * (`src/persistence/use-cases/workspaces-use-cases.ts`). A blank/absent optional field is
 * normalized to `undefined` here, the same "blank means not provided" convention
 * `@/modules/contacts`'s `manualContactCreateSchema` already uses. */
function optionalCompanyText(max: number) {
  return z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((value) => (value ? value : undefined));
}

const companyAddressFields = {
  addressLine1: z.string().trim().min(1).max(200),
  addressLine2: optionalCompanyText(200),
  postalCode: z.string().trim().min(1).max(20),
  city: z.string().trim().min(1).max(120),
  country: optionalCompanyText(2),
  vatId: optionalCompanyText(20),
};

/** Extended company profile fields (decisions/0034-extended-company-profile.md, H1): only
 * SHAPE is validated here (array length/entry length, plain trimming) - the semantic checks
 * (a malformed IBAN, a non-host-looking domain, a too-generic alias) are the persistence use
 * case's job (`updateCompanyProfile`'s own stable error codes,
 * `src/persistence/use-cases/workspaces-use-cases.ts`), the same "Zod validates shape, the use
 * case validates meaning" split `companyAddressFields` above already follows for `country`'s
 * 2-letter cap. A blank entry (an empty textarea line) is tolerated here and dropped later by
 * `normalizeCompanyAliases`/the IBAN/domain normalizers - never rejected at this layer. */
function stringListField(maxEntryLength: number) {
  return z
    .array(z.string().trim().max(maxEntryLength))
    .max(MAX_COMPANY_PROFILE_LIST_ENTRIES)
    .optional()
    .transform((values) => values ?? []);
}

const extendedCompanyProfileFields = {
  /** One brand name/short form per entry (`ui/company-profile-form.tsx`: a textarea, one per
   * line). Max entry length is generous (a company name), not `COMPANY_ALIAS_MIN_LENGTH`'s
   * own lower bound - the generic/too-short guard is the use case's `alias_too_generic`. */
  aliases: stringListField(120),
  /** One IBAN per entry, as typed (spaces allowed - `normalizeIban` strips them); 34 is the
   * longest IBAN in use worldwide, matching `@/modules/contacts`'s own `ibanField` cap. */
  ibans: stringListField(34),
  /** One domain per entry, a bare host or a full URL (`normalizeCompanyDomain` strips the
   * rest); 253 is the maximum legal DNS name length. */
  domains: stringListField(253),
  taxNumber: optionalCompanyText(30),
  registerCourt: optionalCompanyText(120),
  registerNumber: optionalCompanyText(30),
  profileText: optionalCompanyText(COMPANY_PROFILE_TEXT_MAX_LENGTH),
};

/** `/onboarding`'s form: a new workspace's company name AND address, plus an optional VAT id
 * and (H1) the brand-name aliases only - onboarding stays short, the full extended profile
 * (IBANs, domains, tax/register data, free text) lives in the settings form only. Stored via
 * `createForUser` (the name) and `updateCompanyProfile` (everything else) in the same Server
 * Action call. */
export const createWorkspaceInputSchema = z.object({
  name: workspaceName,
  ...companyAddressFields,
  aliases: extendedCompanyProfileFields.aliases,
});
/** `/dashboard/settings/company`'s ("Firmendaten") edit form - the address/VAT id shape plus
 * the full extended company profile (decisions/0034-extended-company-profile.md), without the
 * workspace name (which this page does not edit). */
export const companyProfileInputSchema = z.object({ ...companyAddressFields, ...extendedCompanyProfileFields });
export const inviteMemberInputSchema = z.object({ email: invitationEmail });
export const revokeInvitationInputSchema = z.object({ invitationId: z.uuid() });
export const removeMemberInputSchema = z.object({ memberId: z.uuid() });
/** The workspace switcher's input (decisions/0070-several-workspaces-per-user.md). `z.uuid()`
 * only rejects a malformed id; whether the caller may actually have that workspace is decided
 * server-side by `getMembershipInWorkspace`, never by this schema. */
export const switchWorkspaceInputSchema = z.object({ workspaceId: z.uuid() });
/** `/dashboard/settings/company`'s danger zone (F5, decisions/0027-hardening-and-deletion.md):
 * the caller must re-type the workspace's exact current name. This schema only rejects an
 * empty/oversized string; the actual name comparison happens server-side, in
 * `WorkspaceUseCases.deleteWorkspace`, against the real current name - never trusted from
 * the client. */
export const deleteWorkspaceInputSchema = z.object({ confirmName: workspaceName });
// Tokens are 32 random bytes, hex-encoded (64 characters) - a generous range keeps this
// schema from being the thing that breaks if the token's byte length ever changes.
export const acceptInvitationInputSchema = z.object({ token: z.string().trim().min(32).max(256) });
