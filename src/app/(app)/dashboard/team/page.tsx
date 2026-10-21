import { requireWorkspaceMember } from "@/platform/access/server";
import { PERMISSIONS } from "@/platform/access";
import { listTeamProjection } from "@/modules/workspaces/server";
import { TeamPageClient } from "@/modules/workspaces/client";

// Seam (WEBAPP_TEMPLATE_SPEC.md §5.6): re-authenticates and re-resolves the workspace
// membership (the layout already did, but this page is its own entry point too), fetches
// the team read model, and hands it to the client island with the caller's own
// `members.manage` permission and membership id (so the UI never branches on a role
// string, and never lets a member remove themself).
export default async function TeamPage() {
  const access = await requireWorkspaceMember();
  const team = await listTeamProjection(access.workspace.id);

  return (
    <TeamPageClient
      members={team.members}
      invitations={team.invitations}
      canManageMembers={access.permissions.includes(PERMISSIONS.membersManage)}
      currentMembershipId={access.membershipId}
    />
  );
}
