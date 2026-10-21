# Workspaces and access: tenancy model and permission bundles

Document type: decision
Lifecycle: active
Owner: src/modules/workspaces, src/platform/access
Scope: The tenancy model (workspace, membership, invitation), onboarding, and how
authorization is modeled for the rest of the product
Canonical responsibility: Active source for why a user belongs to at most one workspace,
why there is exactly one admin per workspace and no further roles, how onboarding and
invitations work, and why authorization is expressed as permission bundles rather than
role-string checks
Maintenance triggers:
- The one-workspace-per-user or one-admin-per-workspace rule changes
- A role beyond `admin`/`member` is introduced
- The invitation flow's expiry, cap, or token format changes
Last verified: 2026-09-19, P1 (tenancy)

> **Superseded on one point:** a user may now belong to several workspaces and switch
> between them (decisions/0070-several-workspaces-per-user.md). The permission bundles, the
> one-admin-per-workspace rule and everything else below still hold.

## Status
Accepted

## Context

Digipost is a multi-tenant SaaS: every document, team member, and routing rule belongs to
exactly one workspace (Firma/Team). Before any of that can exist, the product needs a
tenancy model answering three PRD open questions: how a user's first workspace comes into
being (onboarding), how a workspace gains more members (invitations), and how much of a
permission system this warrants at launch.

The PRD is explicit that there is "kein Rechte-Management" beyond a single admin per
workspace: no custom roles, no per-permission toggles, no ownership transfer flow. At the
same time, `WEBAPP_TEMPLATE_SPEC.md` §6.6 already prescribes modeling authorization as
permission bundles bound to a role, specifically so the UI and every server-side check
name a capability (`members.manage`, `documents.write`, ...) rather than branching on a
role string - a rule worth following even with only two roles, because it is what lets a
future third role (or a narrower bundle for an existing one) stay a one-file change in
`src/platform/access` instead of a grep across every module that currently assumes
`role === "admin"` means "can do everything".

This ADR also records that P1 removed the `projects` example module
(`src/modules/projects`) that earlier phases used to demonstrate the schema -> repository
-> use case -> Server Action -> page vertical slice: `src/modules/workspaces` and
`src/platform/access` are that reference slice now.

## Decision

1. **One workspace per user, exactly one admin per workspace.** A user's membership row
   (`workspace_members`) has a unique `userId`: a user belongs to at most one workspace at
   a time. A partial unique index on `workspace_members (workspaceId) WHERE role =
   'admin'` enforces exactly one admin per workspace at the database level, not only in
   application code. There is no `owner` role and no further role beyond `admin`/`member`.
2. **Onboarding via a form, not an invitation, for the first user.** A signed-in user
   without a membership is redirected to `/onboarding` (`src/proxy.ts`'s matcher plus
   `src/platform/access/server`'s `requireWorkspaceMember()`), where they name a company
   and become its admin in one step (`createWorkspaceAction` -> `createForUser`, one
   transaction: create the workspace row, then the admin membership row). A user who
   already has a membership visiting `/onboarding` is redirected to `/dashboard` instead.
3. **Every further member joins by invitation, never self-registration into an existing
   workspace.** An invitation (`workspace_invitations`) stores the invitee's normalized
   (trimmed, lowercased) email, a sha256 hash of a random 32-byte token (the plain token is
   returned exactly once, embedded in the invitation e-mail's link, and never stored),
   the inviting admin, a 7-day expiry, and an `acceptedAt` that starts `null`. Re-inviting
   the same email replaces the pending invitation (a partial unique index on
   `(workspaceId, email) WHERE acceptedAt IS NULL` backs this at the database level too);
   a workspace may have at most 50 pending invitations at once. Acceptance
   (`acceptInvitationAction` -> `acceptInvitation`) validates the invitation is pending,
   unexpired, and addressed to the signed-in user's own email (case-insensitively), and
   that the user has no membership yet, then marks it accepted and inserts the membership
   row in one transaction - a partial accept (invitation marked, membership insert failed,
   or vice versa) is not observable.
4. **`workspaces` does not cascade from `auth.user` deletion.** There is no foreign key
   from `workspaces` to `user`; only `workspace_members.userId` cascades. Deleting a user
   removes their membership but never the workspace itself, so a workspace can outlive
   every one of its original members. Test fixtures that create a workspace (
   `tests/e2e/helpers/workspace.ts`) must delete it explicitly.
5. **Authorization is permission bundles, never role strings, per
   `WEBAPP_TEMPLATE_SPEC.md` §6.6.** `src/platform/access`'s `PERMISSIONS` names five
   capabilities (`members.manage`, `billing.manage`, `routing.manage`, `documents.read`,
   `documents.write`); `ROLE_PERMISSIONS` grants `admin` all of them and `member` only the
   two document permissions (PRD: any workspace member may read/write documents; only the
   admin manages members, billing, and routing rules). Every check - a page/layout
   (`requireWorkspaceMember`, redirecting), a Server Action (`requirePermission`,
   returning an error code), or a future JSON API route (`workspaceAccess`, throwing) -
   resolves the caller's own workspace from their session, never from client input, and
   asks "does this role's bundle include this permission", never "is this role admin".
6. **The `projects` example module is removed.** `src/modules/workspaces` (schema,
   repository, use case, actions, read models, UI) plus `src/platform/access` replace it as
   the reference vertical slice; `src/platform/api-pipeline` itself (the step pipeline,
   `requireCronSecret`, `requireSessionAccess`) is kept as neutral infrastructure. A later
   phase's cron route (`src/app/api/cron/process-jobs`, the jobs recipe) is the pipeline's
   next real example.

## Consequences

- Positive: the "exactly one admin" and "at most one workspace per user" invariants hold
  even against a concurrent request or an application bug, because they are database
  constraints, not only application-level checks (`WORKSPACE_ERROR.alreadyInWorkspace`
  also catches the unique-violation race, not only the pre-check).
- Positive: no module ever needs to ask "is this user an admin" directly; every
  authorization decision reads as a named capability, so a future permission or a third
  role changes one file (`src/platform/access/core/permissions.ts`).
- Positive: the invitation token is never stored in plaintext, matching the same
  hashed-token pattern Better Auth's own magic-link plugin already uses
  (decisions/0005-better-auth-magic-link-drizzle-adapter.md).
- Negative: because a workspace does not cascade from user deletion, every place that
  creates a workspace for a test (unit fakes aside) must also remember to delete it -
  `tests/e2e/helpers/workspace.ts` documents this explicitly for e2e fixtures, and this is
  the one cleanup step a fixture based on `tests/e2e/helpers/fixtures.ts`'s plain `user`
  fixture does not get "for free" via `on delete cascade`.
- Negative: "at most one workspace per user" means there is no multi-workspace-membership
  UI to build later without a schema change (dropping the unique index, adding a
  workspace-switcher) - acceptable for this product's PRD, called out here so a future
  multi-workspace requirement is recognized as a new ADR, not a small tweak.
- Implementation status: **implemented** (P1). `src/persistence/schema/workspaces.ts`,
  `src/persistence/repositories/{contracts,drizzle}/workspaces-repository.ts`,
  `src/persistence/use-cases/workspaces-use-cases.ts`, `src/platform/access`,
  `src/modules/workspaces`, `src/app/(app)/layout.tsx`, `src/app/(app)/dashboard/team/`,
  `src/app/(onboarding)/onboarding/`, `src/app/(onboarding)/invite/[token]/`, and
  `src/proxy.ts`'s matcher all land in this phase, covered by unit, `*.db.test.ts`,
  integration, and e2e tests (`src/modules/workspaces/README.md`'s "Tests" section).

## Supersedes / Superseded By
- None
