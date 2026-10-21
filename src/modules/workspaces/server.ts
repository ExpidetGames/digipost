import "server-only";

/** Public server entrypoint (WEBAPP_TEMPLATE_SPEC.md §4.2). Only Next seams
 * (`src/app/(app)/dashboard/team/page.tsx`, `src/app/(onboarding)/**`) import from here. */
export {
  getCompanyProfileProjection,
  getInvitationPreview,
  getMembershipProjection,
  isCompanyProfileIncomplete,
  listTeamProjection,
  listWorkspacesProjection,
  type InvitationPreviewResult,
  type MembershipProjection,
  type TeamProjection,
} from "./server/read-models";
