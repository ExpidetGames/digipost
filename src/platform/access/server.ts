import "server-only";

/**
 * Privileged entrypoint of `src/platform/access` (WEBAPP_TEMPLATE_SPEC.md §6.6). Never
 * imported from client-reachable code.
 */
export {
  getWorkspaceAccess,
  resolveAccess,
  type WorkspaceAccess,
  type WorkspaceAccessErrorCode,
  type WorkspaceAccessResult,
} from "./server/get-workspace-access";
/** decisions/0070-several-workspaces-per-user.md: the writers are for
 * `src/modules/workspaces`' Server Actions only (a cookie cannot be set while rendering a
 * Server Component). Reading is `resolveAccess`'s own business and needs no other caller. */
export {
  ACTIVE_WORKSPACE_COOKIE,
  clearActiveWorkspaceCookie,
  setActiveWorkspaceCookie,
} from "./server/active-workspace-cookie";
export { requirePermission } from "./server/require-permission";
export { requireWorkspaceMember } from "./server/require-workspace-member";
export { WorkspaceAccessError, workspaceAccess } from "./server/workspace-access-step";
