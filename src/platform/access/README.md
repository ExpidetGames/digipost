# src/platform/access

Document type: reference
Lifecycle: active
Owner: src/platform/access
Scope: Workspace authorization: permission bundles per role, the redirecting page/layout
guard, the non-redirecting Server Action guard, and the api-pipeline access step
Canonical responsibility: The one place a role is translated into what it may do
(WEBAPP_TEMPLATE_SPEC.md §6.6); every other owner checks a named permission, never a role
string
Maintenance triggers:
- A new permission is added, or a role's bundle changes
- How the caller's ACTIVE workspace is resolved changes (the active-workspace cookie,
  decisions/0070-several-workspaces-per-user.md)
- `src/modules/workspaces`'s `getMembershipForUser` use case's return shape changes
- A new route or Server Action needs workspace-scoped access
Last verified: 2026-10-22, decisions/0075-email-intake.md: added `PERMISSIONS.mailIntakeManage`
(`"mail_intake.manage"`, admin-only) - gates every E-Mail-Eingang action and the received-mail
log; every member still sees the address. Previously 2026-10-03, decisions/0070-several-workspaces-per-user.md: a user may belong
to several workspaces, so `resolveAccess` now also decides WHICH one a request acts in. It
reads the active-workspace cookie (`server/active-workspace-cookie.ts`), uses the workspace
it names only if the caller's membership list (read from the database on every request)
contains it, and otherwise falls back to the caller's oldest membership. `server.ts` gained
`ACTIVE_WORKSPACE_COOKIE`/`setActiveWorkspaceCookie`/`clearActiveWorkspaceCookie` for
`src/modules/workspaces`' Server Actions (a cookie cannot be set while rendering a Server
Component). `WorkspaceAccess`'s shape is unchanged. Previously, 2026-09-23,
decisions/0063-no-category-no-assignment-no-routing.md:
`PERMISSIONS.routingManage` (`"routing.manage"`) and its bundle entry are removed - routing is
gone end to end (`src/modules/workspaces/README.md`, `src/modules/dashboard-shell/README.md`).
Previously, 2026-09-20, F5 (decisions/0027-hardening-and-deletion.md): added
`PERMISSIONS.workspaceManage` (`"workspace.manage"`, admin-only) - gates
`deleteWorkspaceAction`/`/dashboard/settings/company`'s danger zone, deliberately its own
bundle rather than reusing `membersManage` (deleting the workspace is irreversible; removing
a member is not). This README's permission list has not been kept exhaustive across every
phase that added one (`financeRead`/`financeManage`, `companyProfileManage`, `intakeManage`,
and now `workspaceManage` all exist - `src/platform/access/core/permissions.ts` is the
single source of truth for the full current list, read it directly rather than trusting an
enumeration here). 2026-09-20, F1b (decisions/0022-intake-wiring.md): added
`PERMISSIONS.intakeManage` (`"intake.manage"`, admin-only) - gates
`resetIntakeFingerprintAction`/`/dashboard/settings/intake` ("Zuordnung zurücksetzen"), the
same "workspace settings, not everyday document work" shape as `companyProfileManage`/
`routingManage`; confirming a new tabular-import proposal stays behind `documentsWrite`
(every member). 2026-09-19, P2b (processing pipeline): `PERMISSIONS.routingManage` gained its
first real consumer (`setRoutingRuleAction`, `/dashboard/routing`,
decisions/0016-processing-pipeline-and-ai.md); `src/modules/dashboard-shell`'s `NavItem`
gained an optional `permission` field that reads this owner's `Permission` type

## Purpose

There is no role beyond `admin`/`member` in this product (PRD: "kein
Rechte-Management") - modeling authorization as permission bundles rather than
role-string checks means the UI and every server-side check name a capability
(`members.manage`, `documents.write`, ...) instead of branching on `role === "admin"`,
so a future narrower role or a bundle change is a one-file diff here, not a grep across
the codebase. Workspace membership itself (which workspace a user belongs to, and their
role in it) is owned by `src/modules/workspaces`'s use case
(`getMembershipForUser`); this owner only turns that into an authorization decision.

Workspace id always comes from the resolved session membership, never from client input:
every function here takes no workspace id parameter at all, it resolves the caller's own
membership from `getCurrentUser()`.

Since decisions/0070-several-workspaces-per-user.md a caller may have more than one
membership, so `resolveAccess` also picks which one this request acts in. The active-workspace
cookie takes part in that pick, and it is client input like any other: it can only SELECT
among the memberships this request just read from the database, never add one. A cookie that
names a workspace the caller is not a member of (forged, stale after leaving it, or another
tenant's id) is simply not found in that list, and the resolution falls through to the
deterministic fallback - the caller's oldest membership. A malformed value never reaches the
database at all (it is dropped unless it parses as a uuid), and no response distinguishes "not
yours" from "does not exist".

## Public interfaces

- `index.ts` (neutral, safe from client-reachable code): `PERMISSIONS`, `ROLES`,
  `ROLE_PERMISSIONS`, `permissionsForRole`, `roleHasPermission`, `Permission`, `Role`.
  A client component may use these to hide a control the server would reject anyway -
  display only, never the real authorization check.
- `server.ts` (privileged, `import "server-only"`): `getWorkspaceAccess`,
  `resolveAccess`, `requirePermission`, `requireWorkspaceMember`, `workspaceAccess`,
  `WorkspaceAccessError`, and the `WorkspaceAccess`/`WorkspaceAccessErrorCode`/
  `WorkspaceAccessResult` types.

## Structure

- `core/permissions.ts` - `PERMISSIONS` (`as const` bundle of permission strings),
  `ROLE_PERMISSIONS` (which permissions each role's bundle grants), `permissionsForRole`,
  `roleHasPermission`.
- `server/active-workspace-cookie.ts` - `ACTIVE_WORKSPACE_COOKIE`
  (`digipost.active_workspace`, httpOnly, sameSite lax, path `/`, `secure` in production, one
  year), `readActiveWorkspaceId()` (never throws; `null` for absent, malformed, or
  non-uuid values), and the two writers `setActiveWorkspaceCookie`/
  `clearActiveWorkspaceCookie`, which only a Server Function or Route Handler may call
  (decisions/0070-several-workspaces-per-user.md).
- `server/get-workspace-access.ts` - `resolveAccess(user)` (the one place that calls
  `getRequestServices().workspaces.listMembershipsForUser` and the one place the active
  workspace is decided, `null` if the user has no membership yet) and `getWorkspaceAccess()` (the non-redirecting entry point: resolves
  the signed-in user via `getCurrentUser()`, then `resolveAccess`, returning a discriminated
  `{ status: "ok" | "error" }` result).
- `server/require-permission.ts` - `requirePermission(permission)`: `getWorkspaceAccess()`
  plus a permission check, still non-redirecting - the shape a Server Action maps straight
  to its own `ActionResult` error code.
- `server/require-workspace-member.ts` - `requireWorkspaceMember()`: the redirecting guard
  for pages/layouts under `(app)`. Calls `requireUser()` first (redirects a signed-out
  visitor to `/login?next=…`), then `resolveAccess`; redirects to `/onboarding` if the
  signed-in user has no workspace yet.
- `server/workspace-access-step.ts` - `workspaceAccess(permission?)`, an api-pipeline
  `access` step (`WorkspaceAccessError` for the route's own `mapError` to narrow to an
  HTTP status). No route adopts this yet; a later phase's document upload/download routes
  do.

## Dependencies on other owners

`@/platform/auth/server` (`getCurrentUser`, `requireUser`),
`@/persistence/composition/request-services` (`getRequestServices`, for
`workspaces.getMembershipForUser` only - this owner never touches a repository or a
Drizzle type directly).

## Consumers

`src/app/(app)/layout.tsx` (`requireWorkspaceMember`); `src/modules/workspaces/actions.ts`,
`src/modules/documents/actions.ts` (`requirePermission`, for the write actions);
`src/app/(app)/dashboard/team/page.tsx` (`requireWorkspaceMember`, then reads
`.permissions`/`.membershipId` to decide what the team page renders). `workspaceAccess`/
`WorkspaceAccessError` (P2a, decisions/0015-documents-and-quotas.md): `src/app/api/documents/route.ts`
(`POST`, as the `access` step of `src/platform/api-pipeline`'s handler,
`PERMISSIONS.documentsWrite`) and `src/app/api/documents/[id]/file/route.ts` (`GET`, called
directly rather than through the pipeline since that route bypasses it,
`PERMISSIONS.documentsRead`) - the pipeline's first real workspace-scoped route.

## Tests

`tests/get-workspace-access.test.ts` - `getWorkspaceAccess()`/`resolveAccess()` against a
mocked `@/platform/auth/server`, `@/persistence/composition/request-services` and
`next/headers` (unauthenticated, no workspace, ok with the right permission bundle for each
role) plus decisions/0070's cookie cases: a cookie naming a workspace the caller is not a
member of resolves to the fallback and is indistinguishable from no cookie at all, a
malformed one never reaches the database, and a legitimate one brings its OWN workspace's
role and bundle, not the fallback's. The database-level half is
`src/persistence/tests/workspaces-multi-membership.db.test.ts`, the end-to-end half
`tests/integration/workflows/workspace-switching.integration.test.ts`.
`tests/require-permission.test.ts` - permission-bundle enforcement (an `admin`-only
permission rejected for `member` with `forbidden`, granted for `admin`).
`tests/permissions.test.ts` - `permissionsForRole`/`roleHasPermission` pure logic. The
redirecting behavior of `requireWorkspaceMember` (both redirect targets) is covered by
`tests/e2e/onboarding.spec.ts`; `workspace-access-step.ts`'s `workspaceAccess` is exercised
by `tests/integration/http/documents-upload.integration.test.ts` and
`documents-file.integration.test.ts` (P2a) through the real `src/app/api/documents/**`
routes.
