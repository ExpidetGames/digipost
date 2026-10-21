// Permission-gated variant of `getWorkspaceAccess` (WEBAPP_TEMPLATE_SPEC.md §6.6), for a
// Server Action that requires more than "any member" - e.g. `members.manage` for inviting
// or removing a team member. Never redirects; a Server Action maps `status: "error"` to
// its own `ActionResult` error code, same as `getWorkspaceAccess` itself.
import "server-only";

import { getWorkspaceAccess, type WorkspaceAccessResult } from "./get-workspace-access";
import type { Permission } from "../core/permissions";

export async function requirePermission(permission: Permission): Promise<WorkspaceAccessResult> {
  const result = await getWorkspaceAccess();
  if (result.status === "error") return result;
  if (!result.access.permissions.includes(permission)) return { status: "error", errorCode: "forbidden" };
  return result;
}
