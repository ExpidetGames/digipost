import "server-only";

import { cache } from "react";

import { getRequestServices } from "@/persistence/composition/request-services";
import { UseCaseError } from "@/persistence/use-cases/errors";
import { WORKSPACE_ERROR, type WorkspaceErrorCode } from "@/persistence/use-cases/workspaces-use-cases";

import type {
  CompanyProfileView,
  InvitationPreviewView,
  PendingInvitationListItem,
  WorkspaceMemberListItem,
  WorkspaceSummary,
} from "../core/types";

export type MembershipProjection = { membershipId: string; role: "admin" | "member"; workspace: WorkspaceSummary };

/** `null` when the signed-in user has no workspace yet (the `/onboarding` gate). Memoized
 * per request (`react cache`): a page and its Server Actions share one lookup. */
export const getMembershipProjection = cache(async (userId: string): Promise<MembershipProjection | null> => {
  const membership = await getRequestServices().workspaces.getMembershipForUser(userId);
  if (!membership) return null;
  return {
    membershipId: membership.membershipId,
    role: membership.role,
    workspace: { id: membership.workspace.id, name: membership.workspace.name, tier: membership.workspace.tier },
  };
});

/** Every workspace the signed-in user belongs to, oldest membership first - the workspace
 * switcher's list (decisions/0070-several-workspaces-per-user.md). Deliberately NOT part of
 * `WorkspaceAccess`: which workspace the caller may act in is an authorization decision
 * (`src/platform/access`), which workspaces they could switch to is this module's read model.
 * Memoized per request like every read model here. */
export const listWorkspacesProjection = cache(async (userId: string): Promise<WorkspaceSummary[]> => {
  const memberships = await getRequestServices().workspaces.listMembershipsForUser(userId);
  return memberships.map((m) => ({ id: m.workspace.id, name: m.workspace.name, tier: m.workspace.tier }));
});

export type TeamProjection = { members: WorkspaceMemberListItem[]; invitations: PendingInvitationListItem[] };

/** The `/dashboard/team` read model: every member plus every pending invitation. */
export const listTeamProjection = cache(async (workspaceId: string): Promise<TeamProjection> => {
  const { members, invitations } = await getRequestServices().workspaces.listMembers(workspaceId);
  return {
    members: members.map((m) => ({
      id: m.id,
      userId: m.userId,
      email: m.email,
      name: m.name,
      role: m.role,
      joinedAt: m.joinedAt.toISOString(),
    })),
    invitations: invitations.map((i) => ({
      id: i.id,
      email: i.email,
      expiresAt: i.expiresAt.toISOString(),
      createdAt: i.createdAt.toISOString(),
    })),
  };
});

/** `/dashboard/settings/company`'s ("Firmendaten") read model, and the source for the
 * dashboard's "please complete your company profile" banner (C2,
 * decisions/0021-extraction-direction-and-invoice-fields.md). `null` only in the
 * theoretically-impossible case of a workspace id that no longer exists (`getCompanyProfile`
 * returns `null` there) - the page/banner treat that the same as "not filled in yet". */
export const getCompanyProfileProjection = cache(async (workspaceId: string): Promise<CompanyProfileView | null> => {
  const profile = await getRequestServices().workspaces.getCompanyProfile(workspaceId);
  if (!profile) return null;
  return {
    workspaceName: profile.name,
    addressLine1: profile.addressLine1,
    addressLine2: profile.addressLine2,
    postalCode: profile.postalCode,
    city: profile.city,
    country: profile.country,
    vatId: profile.vatId,
    aliases: profile.aliases,
    ibans: profile.ibans,
    domains: profile.domains,
    taxNumber: profile.taxNumber,
    registerCourt: profile.registerCourt,
    registerNumber: profile.registerNumber,
    profileText: profile.profileText,
  };
});

/** Whether the workspace's own company profile is missing the fields the extraction pipeline
 * needs to recognize "das sind wir" (C2) - drives the dashboard's dismissible-per-session
 * banner. Deliberately checks `addressLine1`/`postalCode`/`city` only (not `vatId`, which
 * `isOwnCompany` can also match on alone, but is genuinely optional for many small
 * businesses) - matches `updateCompanyProfile`'s own required-field shape in the onboarding
 * and settings forms. */
export function isCompanyProfileIncomplete(profile: CompanyProfileView | null): boolean {
  if (!profile) return true;
  return !profile.addressLine1 || !profile.postalCode || !profile.city;
}

export type InvitationPreviewResult =
  | { status: "ok"; data: InvitationPreviewView }
  | { status: "error"; errorCode: WorkspaceErrorCode };

/** Read-only preview for the `/invite/[token]` page, reachable before the invitee has
 * accepted anything. Never throws: `previewInvitation`'s stable codes are mapped into a
 * discriminated result the page renders directly, the same shape `ActionResult` uses. */
export const getInvitationPreview = cache(async (token: string): Promise<InvitationPreviewResult> => {
  try {
    const preview = await getRequestServices().workspaces.previewInvitation(token);
    return {
      status: "ok",
      data: {
        workspaceName: preview.workspaceName,
        inviterEmail: preview.inviterEmail,
        email: preview.email,
        expiresAt: preview.expiresAt.toISOString(),
      },
    };
  } catch (err) {
    if (err instanceof UseCaseError) {
      return { status: "error", errorCode: err.code as WorkspaceErrorCode };
    }
    return { status: "error", errorCode: WORKSPACE_ERROR.invitationNotFound };
  }
});
