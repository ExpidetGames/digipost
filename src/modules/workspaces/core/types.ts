// Neutral UI-facing DTOs (WEBAPP_TEMPLATE_SPEC.md §5.6's Read Model maps persistence rows to
// these, never the other way around). Dates are ISO strings, not `Date`: they cross the
// Server Component -> Client Component boundary as plain JSON.
import type { Role } from "@/platform/access";

export type WorkspaceSummary = { id: string; name: string; tier: string };

export type WorkspaceMemberListItem = {
  id: string;
  userId: string;
  email: string;
  name: string;
  role: Role;
  joinedAt: string;
};

export type PendingInvitationListItem = {
  id: string;
  email: string;
  expiresAt: string;
  createdAt: string;
};

export type InvitationPreviewView = {
  workspaceName: string;
  // `null` when the inviting user's account has since been deleted (P6 review finding A9).
  inviterEmail: string | null;
  email: string;
  expiresAt: string;
};

/** `/dashboard/settings/company`'s ("Firmendaten") own view of `CompanyProfile`
 * (`src/persistence/use-cases/workspaces-use-cases.ts`, C2,
 * decisions/0021-extraction-direction-and-invoice-fields.md, extended by H1's
 * decisions/0034-extended-company-profile.md). */
export type CompanyProfileView = {
  workspaceName: string;
  addressLine1: string | null;
  addressLine2: string | null;
  postalCode: string | null;
  city: string | null;
  country: string | null;
  vatId: string | null;
  aliases: string[];
  ibans: string[];
  domains: string[];
  taxNumber: string | null;
  registerCourt: string | null;
  registerNumber: string | null;
  profileText: string | null;
};
