# src/modules/workspaces

Document type: reference
Lifecycle: active
Owner: src/modules/workspaces
Scope: Tenancy: workspace creation (onboarding), team membership, and invitations - the
`/onboarding`, `/dashboard/team`, and `/invite/[token]` pages' non-seam code
Canonical responsibility: Everything those pages delegate to except their own page shells;
the schema/repository/use-case/action/page vertical slice for tenancy
(WEBAPP_TEMPLATE_SPEC.md §14 "Mandanten" recipe, decisions/0014-workspaces-and-access.md)
Maintenance triggers:
- The tenancy model changes (roles beyond admin/member, how the active workspace is picked)
- The invitation flow's expiry, cap, or token format changes
- `src/platform/access`'s permission bundles change what this module's actions check
- The company-profile onboarding/settings fields or the "profile incomplete" banner's
  condition change (decisions/0021-extraction-direction-and-invoice-fields.md, C2)
Last verified: 2026-10-03, decisions/0070-several-workspaces-per-user.md: a user may belong to
SEVERAL workspaces. `workspace_members.user_id` lost its unique constraint; a composite unique
on `(workspace_id, user_id)` plus a plain index on `user_id` replaced it (migration
`0021_glamorous_epoch.sql`). `WorkspaceUseCases` gained `listMembershipsForUser(userId)`
(every membership, oldest first) and `getMembershipInWorkspace({ userId, workspaceId })` (the
gate behind the active-workspace cookie); `getMembershipForUser` now means "the caller's
OLDEST membership", the deterministic fallback `resolveAccess` uses. `createForUser` no longer
rejects a user who already has a workspace, and `acceptInvitation`'s `already_in_workspace`
now means "already in THIS workspace" only. New `switchWorkspaceAction` (verifies the
membership against the database BEFORE writing the cookie, `not_found` otherwise);
`createWorkspaceAction`/`acceptInvitationAction` make the new/joined workspace active;
`leaveWorkspaceAction`/`deleteWorkspaceAction` land on another of the caller's workspaces when
one is left, on `/onboarding` when none is. New read model `listWorkspacesProjection(userId)`
for the sidebar switcher (`src/modules/dashboard-shell`). `/onboarding` no longer redirects a
user who already has a membership: it is "Weitere Firma anlegen" for them. Previously,
2026-09-23, decisions/0063-no-category-no-assignment-no-routing.md: document
category, document assignment, and routing are all removed end to end. The `category_routes`
table, `CategoryRouteRepository` (contract, drizzle, and fakes), `setRoutingRuleAction`,
`listRoutingRules`/`listRoutingProjection`/`RoutingRuleListItem`/`RoutingRuleView`,
`ui/routing-page-client.tsx`'s `RoutingPageClient`, `/dashboard/routing` (deleted),
`PERMISSIONS.routingManage` ("routing.manage") and its bundle entry, and the routing nav
entry in `src/modules/dashboard-shell/core/nav-items.ts` are all gone. `deleteMembershipAndCleanUp`
(shared by `removeMember` and `leaveWorkspace`) no longer clears the removed member's
document assignments or routing rules on the way out - it only deletes the membership row -
since neither assignment nor routing exists to clean up any more.
Previously, 2026-09-22, H5 (decisions/0037-correction-buttons.md, "Das sind
wir"/"Das ist unsere Bank"): `WorkspaceUseCases` gained two narrow methods,
`addCompanyAlias({ workspaceId, alias })`/`addCompanyIban({ workspaceId, iban })`
(`src/persistence/use-cases/workspaces-use-cases.ts`), each adding a single entry to the
existing `company_aliases`/`company_ibans` list - locking the workspace row first (the same
`lockForUpdate` reasoning `invite()`'s own TOCTOU fix below already documents), reusing
`updateCompanyProfile`'s own normalization/validation exactly (`alias_too_generic`,
`invalid_iban`, the 20-entry cap), and idempotent: an alias/IBAN that already normalizes to an
existing entry is a no-op success. `src/modules/contacts/actions.ts` (a different owner) calls
these before its own `deleteContact`, never writing to `workspaces` directly - see that ADR
for the full orchestration; this module's own responsibility ends at the two use-case methods
and their tests (`src/persistence/tests/workspaces-use-cases.test.ts`,
`src/persistence/tests/company-profile-corrections.db.test.ts`).
Previously, 2026-09-22, H1 (decisions/0034-extended-company-profile.md, wave 1 of the "AI
is told what to look for" feature): the company profile (`workspaces.company_*`) gained seven
extended fields - `company_aliases`/`company_ibans`/`company_domains` (`text[]`, default
`'{}'`) and `company_tax_number`/`company_register_court`/`company_register_number`/
`company_profile_text` (nullable `text`). `WorkspaceUseCases.updateCompanyProfile` normalizes
and validates all three list fields before writing (trims/de-duplicates aliases, rejects one
that is too short or a bare legal form with `alias_too_generic`; normalizes/validates IBANs
with `invalid_iban`; normalizes/validates domains with `invalid_domain` - the three new pure
functions plus `isGenericCompanyAlias`/`normalizeCompanyDomain`/`isLikelyCompanyHost`/
`normalizeCompanyAliases` live beside `WORKSPACE_ERROR` in
`src/persistence/use-cases/workspaces-use-cases.ts`). `OnboardingForm` gained only the
`aliases` field (kept short by product decision); `CompanyProfileForm` gained the full
extended set, one entry per line in a plain textarea for each list field. See that ADR for the
full rule order this feeds into `@/modules/contacts`'s `isOwnCompany` (a different owner's
file, not this module's).
Previously, 2026-09-20, F5 (hardening, decisions/0027-hardening-and-deletion.md): added
`deleteWorkspaceAction`/`leaveWorkspaceAction` (`PERMISSIONS.workspaceManage`, admin-only,
for the former; no bundle for the latter, member-initiated on the caller's own row only),
the `WorkspaceDangerZone` (`/dashboard/settings/company`) and `LeaveWorkspaceButton`
(`/dashboard/team`) client components, and `WorkspaceUseCases.deleteWorkspace`/
`leaveWorkspace` (`src/persistence/use-cases/workspaces-use-cases.ts`) - the latter's
membership/document-assignment/routing-rule cleanup factored out of `removeMember` into a
shared `deleteMembershipAndCleanUp` helper so both use the identical cleanup. See that ADR
for the cascade-delete design and the object-storage cleanup (job plus synchronous
best-effort attempt). 2026-09-20, C2 (decisions/0021-extraction-direction-and-invoice-fields.md): the
onboarding form now also collects the new workspace's company address (line 1 required, line
2 optional, postal code/city required, country defaulting to "DE") and an optional VAT id,
stored via `updateCompanyProfile` right after `createForUser` in the same
`createWorkspaceAction` call. A new admin-only page, `/dashboard/settings/company`
("Firmendaten", `ui/company-profile-form.tsx`), edits the same fields for an existing
workspace, gated by a new permission bundle this module's dependency (`src/platform/access`)
gained for it: `PERMISSIONS.companyProfileManage` (`"company_profile.manage"`). A
dismissible-per-session banner (`ui/company-profile-banner.tsx`, `sessionStorage` via
`useSyncExternalStore`) on `/dashboard` (rendered by that page, not this module - see
`src/modules/documents/README.md`) points admins at the settings page when the company
profile is still incomplete (`server/read-models.ts`'s `isCompanyProfileIncomplete`). C1
(contacts, decisions/0019-contacts.md): the persistence use case
(`src/persistence/use-cases/workspaces-use-cases.ts`) gained `getCompanyProfile`/
`updateCompanyProfile`, backed by six new nullable `workspaces.company_*` columns
(`src/persistence/schema/workspaces.ts`) - the workspace's own address/VAT id, so
`@/modules/contacts`'s pure `isOwnCompany` check can keep the processing pipeline from ever
filing the workspace's own company as one of its contacts. This module owns those columns
and that use case, same as every other `workspaces`-owned field; the onboarding step and
settings page around them landed in C2 above. P6 review: `invite()` now locks the workspace row before
checking the pending-invitation cap (A6, TOCTOU fix); `removeMemberAction` revalidates
`/dashboard` and `/dashboard/routing` too, not just `/dashboard/team` (A5); routing-rule
category names now go through `@/modules/documents`'s `resolveCategoryLabel` (C1). P3
(billing): added `getWorkspaceWithAdminContact` (the
persistence use case's read used by `src/modules/billing`'s 80% quota-warning e-mail,
decisions/0017-billing-tiers-and-packages.md). P2b (processing pipeline) added
per-category routing rules (`/dashboard/routing`, "Zuständigkeiten") and extended
`removeMember` to also clear the removed member's routing rules,
decisions/0016-processing-pipeline-and-ai.md

## Purpose

A workspace (Firma/Team) has a name and a tier; a user may belong to SEVERAL workspaces
(decisions/0070-several-workspaces-per-user.md: one login, several companies, kept completely
separate), but never twice to the same one, with a role of `admin` or `member` per workspace
and exactly one admin per workspace (both enforced at the database level, not only in
application code - `src/persistence/schema/workspaces.ts`). Which of them is ACTIVE for a
given request is not stored here at all: it lives in a cookie and is resolved in exactly one
place, `src/platform/access`'s `resolveAccess`. Tier and quota are per workspace, so a second
company starts on the free tier with its own quota - nothing is shared across a user's
workspaces.
There is no role beyond that (PRD: "kein Rechte-Management"): what an `admin` may do that a
`member` cannot is expressed as permission bundles in `src/platform/access`, not as a role
string check anywhere in this module.

A signed-in user without a membership is redirected to `/onboarding`
(`src/platform/access/server/require-workspace-member.ts`), where they name a company and
become its admin. A user who already has one is NOT redirected away from `/onboarding` any
more (decisions/0070): the same page is "Weitere Firma anlegen" for them, and the workspace
they create there becomes their active one. The admin invites members by email: an invitation row (hashed token,
7-day expiry, replaces any existing pending invitation for the same email, capped at 50
pending per workspace) plus a German invitation e-mail (`server/emails/invitation-email.tsx`)
containing the `/invite/<token>` link. The invitee signs in via magic link and accepts -
acceptance and the membership insert happen in one transaction
(`src/persistence/use-cases/workspaces-use-cases.ts`'s `acceptInvitation`).

## Public interfaces

- `actions.ts` (`"use server"`): `createWorkspaceAction`, `inviteMemberAction`,
  `revokeInvitationAction`, `removeMemberAction`, `acceptInvitationAction`,
  `switchWorkspaceAction` (decisions/0070: any member, acts only on the caller's own cookie,
  and verifies the membership against the database before writing it - `redirect`s to
  `/dashboard` on success),
  `leaveWorkspaceAction` (any member,
  rejects the workspace's own admin), `deleteWorkspaceAction` (admin-only,
  `workspace.manage`, F5) - each returning
  `ActionResult<TData, WorkspaceActionErrorCode>`
  (`@/shared/action-result`), except the last two which `redirect("/onboarding")` on success
  instead of returning.
- `server.ts` (`import "server-only"`): `getMembershipProjection(userId)` (the caller's
  oldest membership), `listWorkspacesProjection(userId)` (decisions/0070: every workspace the
  caller belongs to, oldest first - the sidebar switcher's list),
  `listTeamProjection(workspaceId)`, `getInvitationPreview(token)` - the read models the
  pages call.
- `client.ts` (`"use client"`): `OnboardingForm`, `InviteAcceptForm`, `TeamPageClient`,
  `WorkspaceDangerZone`, `LeaveWorkspaceButton` (F5).

No `index.ts`: nothing here needs a neutral entry point reachable from both client and
server code.

## Structure

- `core/types.ts` - `WorkspaceSummary`, `WorkspaceMemberListItem`,
  `PendingInvitationListItem`, `InvitationPreviewView`: UI-facing
  DTOs (dates as ISO strings, not `Date`).
- `core/schemas.ts` - Zod input schemas for this module's actions, reusing the persistence use
  case's `WORKSPACE_NAME_MIN_LENGTH`/`WORKSPACE_NAME_MAX_LENGTH` constants.
- `core/error-codes.ts` - `WORKSPACE_ACTION_ERROR_CODES`/`WorkspaceActionErrorCode` - an
  `as const` set the UI translates via each namespace's own `errors.*` keys (`Onboarding.errors`,
  `Team.errors`, `Invite.errors`).
- `actions.ts` - this module's Server Actions. `mapUseCaseError` translates
  a thrown `UseCaseError` (`WORKSPACE_ERROR` codes) into this module's own error codes;
  `requirePermission`'s `status: "error"` result (`unauthenticated`/`no_workspace`/
  `forbidden`) is forwarded as-is, since those codes are already part of the error-code
  set. Workspace id always comes from the resolved session membership
  (`requirePermission`/`requireUser`), never from client input.
- `server/read-models.ts` (published through `server.ts`) - `getMembershipProjection`,
  `listTeamProjection`, `getInvitationPreview`, each `cache`d per
  request.
- `server/emails/invitation-email.tsx` - the invitation e-mail (React Email, German,
  `STRUCTURE.md`'s `vendor-sdk` rule confines `@react-email/` to this directory plus
  `src/platform/auth/server/emails/` and `src/platform/mailer/`).
- `ui/onboarding-form.tsx` - the `/onboarding` form: workspace name, company address, an
  optional VAT id (C2), and (H1) an optional `aliases` textarea, kept short on purpose.
- `ui/company-profile-form.tsx` - `/dashboard/settings/company`'s ("Firmendaten") edit form,
  admin-only (C2), extended by H1 (decisions/0034-extended-company-profile.md) with the full
  extended profile: aliases/IBANs/domains (one entry per line, a plain textarea each),
  tax number, register court/number, and the free-text field.
- `ui/company-profile-banner.tsx` - the dashboard's dismissible-per-session "please complete
  your company profile" banner (C2), rendered by `src/app/(app)/dashboard/page.tsx`.
- `ui/invite-member-form.tsx`, `ui/member-item.tsx`, `ui/invitation-item.tsx`,
  `ui/team-page-client.tsx` - the `/dashboard/team` page's client island: everyone sees the
  member list and pending invitations; only `canManageMembers` (the caller's own
  `members.manage` permission) renders the invite form and the revoke/remove controls.
- `ui/invite-accept-form.tsx` - the `/invite/[token]` page's accept button, rendered only
  once the server-side preview (`getInvitationPreview`) already succeeded.
- `ui/workspace-danger-zone.tsx` - `/dashboard/settings/company`'s danger zone (F5,
  decisions/0027-hardening-and-deletion.md): typed re-entry of the exact workspace name
  before "Endgültig löschen" enables, re-checked server-side regardless.
- `ui/leave-workspace-button.tsx` - `/dashboard/team`'s "Arbeitsbereich verlassen" (F5),
  rendered only for the caller's own row when its role is not `admin`.

## Dependencies on other owners

`@/platform/auth/server` (`requireUser`, `actions.ts` only),
`@/platform/access/server` (`requirePermission`, the member-management actions),
`@/platform/access` (`PERMISSIONS`, `Role` type), `@/platform/mailer/server`
(`createSmtpMailer`, `inviteMemberAction`), `@/platform/env/server` (`serverEnv`, for
`APP_URL` when building the invite link), `@/persistence/composition/request-services`
(`getRequestServices`), `@/persistence/use-cases/workspaces-use-cases` (`WORKSPACE_ERROR`,
the name-length constants), `@/persistence/use-cases/errors` (`UseCaseError`),
`@/shared/action-result` (`ActionResult`), `@/shared/ui-primitives` (`Button`, `Input`,
`Label`).
`@/platform/object-storage/server` (`getObjectStorage`, F5: `deleteWorkspaceAction`'s
immediate best-effort `listObjects`/`deleteObjects` after the use case's own transaction
commits), `next/navigation` (`redirect`, F5: `leaveWorkspaceAction`/`deleteWorkspaceAction`
both redirect to `/onboarding` on success rather than returning an `ActionResult`).

## Consumers

`src/app/(onboarding)/onboarding/page.tsx` (seam): `getMembershipProjection` to redirect an
already-onboarded user to `/dashboard`, `OnboardingForm` (from `client.ts`).
`src/app/(onboarding)/invite/[token]/page.tsx` (seam): `getInvitationPreview`,
`InviteAcceptForm`. `src/app/(app)/dashboard/team/page.tsx` (seam):
`listTeamProjection`, `TeamPageClient`.
`src/platform/access/server/require-workspace-member.ts`:
reads workspace membership through `getRequestServices().workspaces` (not through this
module directly - `src/platform/access` calls the persistence use case itself, the same
seam this module's own read models use).
`src/persistence/composition/job-handlers.ts` (P3, decisions/0017-billing-tiers-and-packages.md)
calls the persistence use case's `getWorkspaceWithAdminContact` directly (a composition-rank
file, not this module's own `server.ts`/`client.ts`) to address the 80% quota-warning
e-mail to the workspace's current admin.

## Tests

`tests/schemas.test.ts` (input validation, trimming, length limits, email normalization),
`tests/actions.test.ts` (session/permission requirements, Zod rejection without calling the
use case, `UseCaseError`/`WorkspaceAccessResult` code mapping, `revalidatePath` calls, the
invitation e-mail send call and its best-effort failure handling),
`tests/onboarding-form.test.tsx` (Testing Library + jsdom: submit flow, pending state,
mapped error message, redirect on success), `tests/company-profile-form.test.tsx` (H1,
decisions/0034-extended-company-profile.md: the extended profile fields render pre-filled,
submit as one-array-entry-per-textarea-line, and the `alias_too_generic`/`invalid_iban`
errors surface their German copy). `src/persistence/tests/workspaces-use-cases.test.ts`
also unit-tests the extended profile's pure normalizers (`normalizeCompanyDomain`/
`isLikelyCompanyHost`/`normalizeCompanyAliases`/`isGenericCompanyAlias`) directly, and
`updateCompanyProfile`'s own validation/normalization behavior (trimming, de-duplication,
the three new stable error codes), plus (H5, decisions/0037-correction-buttons.md)
`addCompanyAlias`/`addCompanyIban`: adding, idempotent re-adding, the too-generic-alias/
malformed-IBAN/20-entry-cap rejections leaving the profile unchanged, and `not_found` for a
missing workspace; `src/persistence/tests/workspaces-repository.db.test.ts`
proves the seven new columns round-trip through the repository against real Postgres,
including a fresh workspace's empty-array defaults, and
`src/persistence/tests/company-profile-corrections.db.test.ts` proves `addCompanyAlias`/
`addCompanyIban` land normalized on a real workspace row, together with
`src/modules/contacts`'s `deleteContact`, workspace-scoped. Cross-user/cross-workspace isolation and the
full onboard -> invite -> accept flow through the real actions/use cases against Postgres
is `tests/integration/workflows/workspaces-onboarding.integration.test.ts`;
decisions/0070's own integration suite (a second workspace, switching, a forged
active-workspace cookie degrading to the fallback, documents/accounts/transactions staying
separate, accepting an invitation while already a member, and leaving down to the last
workspace) is `tests/integration/workflows/workspace-switching.integration.test.ts`, with the
database-level half (the composite unique, the dropped one, the oldest-first ordering) in
`src/persistence/tests/workspaces-multi-membership.db.test.ts`. End-to-end
onboarding and invitation flows are `tests/e2e/onboarding.spec.ts` and
`tests/e2e/invitation.spec.ts`. F5 (decisions/0027-hardening-and-deletion.md):
`deleteWorkspace`/`leaveWorkspace` unit tests are in
`src/persistence/tests/workspaces-use-cases.test.ts` (confirmation mismatch, admin-cannot-leave,
membership cleanup, the enqueued workspace-less
`cleanup-workspace-storage` job); `deleteWorkspaceAction`/`leaveWorkspaceAction`'s own
`tests/actions.test.ts` cases mock `getObjectStorage`/`redirect`; the actual cross-table
cascade is proved against real Postgres in
`src/persistence/tests/workspaces-repository.db.test.ts`.

## How the `projects` example module was removed

P1 (this module's own phase) deleted `src/modules/projects` following its own README's "How
to delete this example module": its schema/repository/use-case, its `Repositories` slot,
its `/dashboard/projects` page, its `Projects` i18n namespace, its cron example
(`src/app/api/cron/purge-archived-projects/` and the matching `vercel.json` entry - a later
phase adds a new cron route), and its tests/fakes/e2e spec. `src/platform/api-pipeline`
itself (the step pipeline, `requireCronSecret`, `requireSessionAccess`) was kept: it is
neutral infrastructure, not part of the example. This module and `src/platform/access`
replace `projects` as the reference vertical slice.
