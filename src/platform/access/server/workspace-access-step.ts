// The api-pipeline access step for a JSON API route that requires workspace membership
// (WEBAPP_TEMPLATE_SPEC.md §6.6/§7, the tenancy counterpart to
// `src/platform/api-pipeline/server/require-session-access.ts`). No route adopts this yet
// (a later phase's document upload/download routes do); it exists so the pipeline supports
// workspace-scoped access the same way it already supports a plain session or a cron
// bearer secret.
import "server-only";

import { getWorkspaceAccess, type WorkspaceAccess, type WorkspaceAccessErrorCode } from "./get-workspace-access";
import type { Permission } from "../core/permissions";

/** Thrown by `workspaceAccess` when the request carries no valid session, the user has
 * no workspace, or the workspace's role lacks the required permission. A route's own
 * `access.mapError` narrows `.code` to an HTTP status (401/403). */
export class WorkspaceAccessError extends Error {
  override readonly name = "WorkspaceAccessError";
  constructor(readonly code: WorkspaceAccessErrorCode) {
    super(code);
  }
}

/**
 * `access: { run: () => workspaceAccess(PERMISSIONS.documentsWrite) }` in a route built on
 * `src/platform/api-pipeline`'s `createApiHandler`. Workspace id always comes from the
 * resolved session membership, never from client input.
 */
export async function workspaceAccess(permission?: Permission): Promise<WorkspaceAccess> {
  const result = await getWorkspaceAccess();
  if (result.status === "error") throw new WorkspaceAccessError(result.errorCode);
  if (permission && !result.access.permissions.includes(permission)) {
    throw new WorkspaceAccessError("forbidden");
  }
  return result.access;
}
