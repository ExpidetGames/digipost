"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";

import type { PendingInvitationListItem, WorkspaceMemberListItem } from "../core/types";
import { InviteMemberForm } from "./invite-member-form";
import { InvitationItem } from "./invitation-item";
import { LeaveWorkspaceButton } from "./leave-workspace-button";
import { MemberItem } from "./member-item";

/** The `/dashboard/team` page's client island. Holds members/invitations as local state,
 * seeded from the server-rendered read model, updated directly from each Server Action's
 * own response data (instant feedback, WEBAPP_TEMPLATE_SPEC.md §8's ~100ms rule). Everyone
 * sees the member list and pending invitations; only `canManageMembers` (the caller's own
 * `members.manage` permission, resolved server-side by `src/platform/access`) renders the
 * invite form and the revoke/remove controls. */
export function TeamPageClient({
  members: initialMembers,
  invitations: initialInvitations,
  canManageMembers,
  currentMembershipId,
}: {
  members: WorkspaceMemberListItem[];
  invitations: PendingInvitationListItem[];
  canManageMembers: boolean;
  currentMembershipId: string;
}) {
  const t = useTranslations("Team");
  const [members, setMembers] = useState(initialMembers);
  const [invitations, setInvitations] = useState(initialInvitations);
  // F5 (decisions/0027-hardening-and-deletion.md): "Arbeitsbereich verlassen" is only for a
  // non-admin member - an admin who wants out deletes the workspace instead (the danger zone
  // on `/dashboard/settings/company`), since there is no admin-transfer flow. Derived from
  // the member list itself (already scoped to this workspace) rather than a separate prop,
  // so it always agrees with what the list actually shows for "you".
  const currentMember = members.find((m) => m.id === currentMembershipId);
  const canLeave = currentMember !== undefined && currentMember.role !== "admin";

  function handleInvited(invitation: PendingInvitationListItem) {
    setInvitations((current) => [invitation, ...current]);
  }

  function handleRevoked(id: string) {
    setInvitations((current) => current.filter((i) => i.id !== id));
  }

  function handleRemoved(id: string) {
    setMembers((current) => current.filter((m) => m.id !== id));
  }

  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-xl font-semibold text-foreground">{t("heading")}</h1>
        <p className="text-sm text-muted-foreground">{t("description")}</p>
      </div>

      {canManageMembers ? <InviteMemberForm onInvited={handleInvited} /> : null}

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-foreground">{t("members.heading")}</h2>
        <ul className="flex flex-col gap-2">
          {members.map((member) => (
            <MemberItem
              key={member.id}
              member={member}
              isSelf={member.id === currentMembershipId}
              canManageMembers={canManageMembers}
              onRemoved={handleRemoved}
            />
          ))}
        </ul>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-foreground">{t("invitations.heading")}</h2>
        {invitations.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("invitations.empty")}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {invitations.map((invitation) => (
              <InvitationItem
                key={invitation.id}
                invitation={invitation}
                canManageMembers={canManageMembers}
                onRevoked={handleRevoked}
              />
            ))}
          </ul>
        )}
      </section>

      {canLeave ? (
        <section className="flex flex-col gap-3">
          <LeaveWorkspaceButton />
        </section>
      ) : null}
    </div>
  );
}
