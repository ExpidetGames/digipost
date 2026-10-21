import { requireWorkspaceMember } from "@/platform/access/server";
import { listWorkspacesProjection } from "@/modules/workspaces/server";
import { DashboardShell } from "@/modules/dashboard-shell/client";

// Every page below depends on the session cookie; never attempt static prerendering
// (WEBAPP_TEMPLATE_SPEC.md §6.4: "Seiten mit Session sind dynamisch").
export const dynamic = "force-dynamic";

/**
 * Authenticated, workspace-scoped shell. `requireWorkspaceMember()`
 * (`src/platform/access/server`) validates the Better Auth session for real, then
 * resolves the caller's workspace membership - redirecting to `/login` (no session) or
 * `/onboarding` (signed in, no workspace yet) as needed. `src/proxy.ts` only checked
 * cookie presence, so a forged or expired cookie never gets past this point. Pages and
 * Server Actions below authenticate/authorize themselves again (WEBAPP_TEMPLATE_SPEC.md
 * §6.4: "Actions sind eigene Endpunkte"). `DashboardShell` (src/modules/dashboard-shell) owns
 * the sidebar/header chrome; this seam only does the auth+tenancy check and hands it the
 * resulting email and workspace name.
 *
 * `listWorkspacesProjection` (decisions/0070-several-workspaces-per-user.md) adds the
 * workspace switcher's list. It is read here, not inside `requireWorkspaceMember()`: which
 * workspace the caller may act in is an authorization decision, which workspaces they could
 * switch to is `src/modules/workspaces`' read model, and only this shell needs it.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const access = await requireWorkspaceMember();
  const workspaces = await listWorkspacesProjection(access.user.id);

  return (
    <DashboardShell
      userEmail={access.user.email}
      workspaceName={access.workspace.name}
      activeWorkspaceId={access.workspace.id}
      workspaces={workspaces.map(({ id, name }) => ({ id, name }))}
      permissions={access.permissions}
    >
      {children}
    </DashboardShell>
  );
}
