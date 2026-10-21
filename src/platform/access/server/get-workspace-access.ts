// The non-redirecting workspace access lookup (WEBAPP_TEMPLATE_SPEC.md §6.6). Server
// Actions and API routes need a result they can translate into an `ActionResult`/JSON
// error code, never a `redirect()` - a Server Action or route handler has no page to
// redirect from mid-request. `server/require-workspace-member.ts` (pages/layouts) and
// `server/workspace-access-step.ts` (the api-pipeline access step) both build on
// `resolveAccess` below so the membership lookup itself lives in exactly one place.
import "server-only";

import { getCurrentUser, type CurrentUser } from "@/platform/auth/server";
import { getRequestServices } from "@/persistence/composition/request-services";
import type { MembershipWithWorkspace } from "@/persistence/use-cases/workspaces-use-cases";

import { permissionsForRole, type Permission, type Role } from "../core/permissions";

import { readActiveWorkspaceId } from "./active-workspace-cookie";

export type WorkspaceAccess = {
  user: CurrentUser;
  membershipId: string;
  role: Role;
  workspace: { id: string; name: string; tier: string };
  permissions: readonly Permission[];
};

export type WorkspaceAccessErrorCode = "unauthenticated" | "no_workspace" | "forbidden";

export type WorkspaceAccessResult =
  | { status: "ok"; access: WorkspaceAccess }
  | { status: "error"; errorCode: WorkspaceAccessErrorCode };

function toAccess(user: CurrentUser, membership: MembershipWithWorkspace): WorkspaceAccess {
  return {
    user,
    membershipId: membership.membershipId,
    role: membership.role,
    workspace: { id: membership.workspace.id, name: membership.workspace.name, tier: membership.workspace.tier },
    permissions: permissionsForRole(membership.role),
  };
}

/**
 * The ONE place the caller's active workspace is decided
 * (decisions/0070-several-workspaces-per-user.md). `null` when `user` has no workspace
 * membership at all; every other caller (page guard, Server Action guard, api-pipeline
 * access step) builds on this, so the membership -> active workspace -> permissions mapping
 * exists exactly once.
 *
 * The active-workspace cookie is client input and is treated as such: it only selects among
 * the memberships this request just read from the database. A cookie naming a workspace the
 * user is not a member of (forged, stale after leaving, or simply another tenant's id) falls
 * through to the deterministic fallback - the caller's OLDEST membership - and grants
 * nothing; the response is indistinguishable from one where the cookie named a workspace
 * that does not exist at all.
 */
export async function resolveAccess(user: CurrentUser): Promise<WorkspaceAccess | null> {
  const memberships = await getRequestServices().workspaces.listMembershipsForUser(user.id);
  if (memberships.length === 0) return null;

  const requestedWorkspaceId = await readActiveWorkspaceId();
  const requested = requestedWorkspaceId
    ? memberships.find((m) => m.workspace.id === requestedWorkspaceId)
    : undefined;

  // `memberships[0]` is the oldest membership: `listMembershipsForUser` orders by
  // `joined_at` then `id`, a total order, so the fallback never flips between two requests.
  const active = requested ?? memberships[0];
  if (!active) return null;

  return toAccess(user, active);
}

/**
 * Resolves the signed-in user's workspace membership without ever redirecting. Server
 * Actions call this (via `requirePermission`) and map `status: "error"` to their own
 * `ActionResult` error code; `server/require-workspace-member.ts` is the redirecting
 * equivalent for pages/layouts.
 */
export async function getWorkspaceAccess(): Promise<WorkspaceAccessResult> {
  const user = await getCurrentUser();
  if (!user) return { status: "error", errorCode: "unauthenticated" };

  const access = await resolveAccess(user);
  if (!access) return { status: "error", errorCode: "no_workspace" };

  return { status: "ok", access };
}
