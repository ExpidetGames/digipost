# src/modules/dashboard-shell

Document type: reference
Lifecycle: active
Owner: src/modules/dashboard-shell
Scope: The authenticated app frame: sidebar/mobile navigation, and the header (signed-in
user's email, workspace name, sign-out)
Canonical responsibility: Everything `src/app/(app)/layout.tsx` delegates to except the real
session+tenancy check itself
Maintenance triggers:
- A new capability needs a sidebar entry (`core/nav-items.ts`)
- A planned entry gets its route (drop its `href: null`)
- A section's first entry changes (its heading's navigation target changes with it)
- The header's content or the mobile-nav breakpoint changes
- The workspace switcher's list, ordering, or entries change
- A nav entry needs to be hidden from members who lack a permission
Last verified: 2026-10-22, decisions/0075-email-intake.md: "E-Mail-Eingang" is a real link to
`/dashboard/email-intake`. Previously 2026-10-03, decisions/0070-several-workspaces-per-user.md: the sidebar's and
mobile header's plain workspace name became `ui/workspace-switcher.tsx`, listing every
workspace the signed-in user belongs to, marking the active one, and offering "Weitere Firma
anlegen" (`/onboarding`). `DashboardShell` gained `activeWorkspaceId` and `workspaces`, both
supplied by `src/app/(app)/layout.tsx` from `src/modules/workspaces`'
`listWorkspacesProjection`. A user with a single workspace sees exactly what they saw before
(the plain name, no control). Previously, 2026-09-23,
decisions/0063-no-category-no-assignment-no-routing.md: the
"Zuständigkeiten" (`/dashboard/routing`, `routing.manage`) nav entry is removed from
`core/nav-items.ts`'s "Verwaltung" section along with routing itself
(`src/modules/workspaces/README.md`). Previously, the same day,
decisions/0057-sections-are-disclosures.md: a labelled section is
now a disclosure with exactly one open at a time, and its heading navigates to the section's
first built entry. Previously, the same day, decisions/0055-navigation-by-use-case.md: the flat
`NAV_ITEMS` list
became `NAV_SECTIONS`, grouped by use case (Post, Finanzen, Abschluss, Verwaltung) with two
standalone entries, planned capabilities listed with `href: null` and a "Demnächst" badge, and
the finance pages' own tab bar removed in favour of the "Finanzen" section. Previously, 2026-09-20,
F2 (decisions/0024-accounts-and-transactions.md): added the
"Finanzen" nav entry (`/dashboard/finance`, `src/modules/accounts`, admin-only,
`finance.read` - the first entry whose underlying capability has NO member-level counterpart
at all, unlike every entry below). Previously, F1b (decisions/0022-intake-wiring.md): added
the "Erkannte Quellen" nav entry (`/dashboard/settings/intake`, `src/modules/documents`,
admin-only, `intake.manage`). 2026-09-19, P3 (billing): added the "Tarif & Nutzung" nav entry
(`/dashboard/billing`, `src/modules/billing`, decisions/0017-billing-tiers-and-packages.md,
no `permission` filter - every member sees the page). P2b (processing pipeline): `NavItem`
gained an optional `permission` field and `DashboardShell`/`NavLinks` now take the caller's
resolved permissions, filtering out "Zuständigkeiten" for anyone without `routing.manage`
(decisions/0016-processing-pipeline-and-ai.md)

## Purpose

Pure UI chrome around whatever a `(app)` page renders: a fixed sidebar on desktop, a
toggled panel below the header on mobile (no modal/dialog dependency needed, plain
conditional rendering), and a header showing the signed-in user's email plus a sign-out
button. Owns no auth or tenancy logic: `src/app/(app)/layout.tsx` calls
`requireWorkspaceMember()` (`src/platform/access/server`) for the real session+workspace
check (WEBAPP_TEMPLATE_SPEC.md §6.4/§6.6) and passes only the resulting email and
workspace name in.

## Public interfaces

`client.ts` (`"use client"`): `DashboardShell({ userEmail, workspaceName, activeWorkspaceId,
workspaces, permissions, children })`. No `actions.ts`, `server.ts`, or `index.ts`: this module owns no Server Actions
or reads of its own (sign-out is `src/modules/sign-in`'s action, imported directly the same
way `src/modules/workspaces`' UI imports its own actions) and nothing here needs a neutral
entry point.

## Structure

- `core/nav-items.ts` - `NAV_SECTIONS`, the one list both `ui/nav-links.tsx` instances (desktop
  sidebar, mobile panel) render from, grouped by the moment a user is in rather than by the
  tables behind it (decisions/0055-navigation-by-use-case.md): a standalone "Start", then
  "Post" (`/dashboard` "Posteingang", `/dashboard/scan` "Post erfassen", `/dashboard/email-intake`
  "E-Mail-Eingang", no permission filter, decisions/0075-email-intake.md),
  "Finanzen" (`/dashboard/finance` "Konten", `/dashboard/finance/zuordnung` "Zuordnung",
  `/dashboard/finance/offene-posten` "Offene Posten", all `finance.read`, F2/F3b,
  decisions/0024-accounts-and-transactions.md, decisions/0025-payment-matching-wiring.md),
  "Abschluss" ("Monatsabschluss", "Steuerberater-Export", both `finance.read`), a standalone
  `/dashboard/contacts` "Kontakte", and "Verwaltung" (`/dashboard/team` "Team",
  `/dashboard/settings/company`
  "Firmendaten" `company_profile.manage`, `/dashboard/settings/intake` "Erkannte Quellen"
  `intake.manage` decisions/0022-intake-wiring.md, `/dashboard/billing` "Tarif & Nutzung" - P3,
  decisions/0017-billing-tiers-and-packages.md, no `permission` filter: every member sees the
  page, only its own controls are permission-gated). P2c's camera scanner
  (`src/modules/scanner`) plugs into "Post erfassen"'s own page (a "Kamera" tab), not a nav
  entry of its own. A `NavEntry` with `href: null` is planned but not built and renders as a row with
  a "Demnächst" badge instead of a link. The optional `permission` field
  (`@/platform/access`'s `Permission`) hides an entry from anyone whose bundle does not include
  it, and `visibleNavSections` drops a section that ends up empty together with its heading, so
  a member sees no "Finanzen" or "Abschluss" block at all. This is display only: the real
  authorization always happens server-side on the page/action itself, `src/platform/access`'s
  own README. `activeNavHref` resolves the active entry as the longest `href` matching the
  current path at a segment boundary, which also marks the nearest ancestor for a page with no
  entry of its own (`/dashboard/documents/<id>` marks "Posteingang").
- `ui/nav-links.tsx` - the sections themselves, active-state aware (`usePathname` plus
  `activeNavHref`) and filtered through `visibleNavSections` before rendering; shared between
  the desktop sidebar and the mobile panel so they can never drift apart. A labelled section is
  a `role="group"` with its heading as the accessible name, and it is a disclosure
  (decisions/0057-sections-are-disclosures.md): exactly one section is open, by default the one
  `activeSectionKey` derives from the current path. A heading is two controls: the label is a link to
  `sectionTarget` (the section's first built route, opening the section by arriving there) and
  the chevron beside it is a button that only opens and closes, so a section can be inspected
  without leaving the current page. `aria-expanded`/`aria-controls` and a screen-reader-only
  name (`DashboardShell.nav.toggleSection`) sit on that button. A section with no built route at
  all ("Abschluss") has a label that toggles too, carrying the badge itself. A visitor's own override is held as `{ forPath, key }` so it lapses on the next
  navigation without an effect watching the router. A planned entry is a plain row with the
  `DashboardShell.nav.soon` badge, never a link.
- `ui/workspace-switcher.tsx` - the workspace switcher
  (decisions/0070-several-workspaces-per-user.md), rendered in place of the workspace name in
  both the desktop sidebar and the mobile header. A `<details>`/`<summary>` disclosure with
  one plain `<form>` per workspace submitting `src/modules/workspaces`'
  `switchWorkspaceAction`: keyboard reachable and working before hydration, so this shell
  keeps its single piece of client state (the mobile-nav toggle) rather than gaining a
  JS-driven menu. `useActionState` is there only to render the action's stable error code as
  German copy (`DashboardShell.workspaceSwitcher.errors.*`); the happy path is the action's
  own `redirect`. Fewer than two workspaces renders the plain name and nothing else. This is
  display only, as everywhere else here: `switchWorkspaceAction` re-checks the membership
  server-side before it writes anything.
- `ui/dashboard-shell.tsx` - the frame: desktop sidebar (`md:` and up, app name plus
  workspace name), which is `sticky top-0 h-screen self-start` so it stays put while the page
  scrolls. `self-start` is load-bearing: without it the aside stretches to the flex row's full
  height and `sticky` has nowhere to stick, which is why the sidebar used to scroll away on a
  long inbox. Its own `overflow-y-auto` keeps a nav taller than the viewport reachable. a header with a hamburger toggle below that breakpoint (app name plus
  workspace name there too), the toggled mobile nav panel, and the page content in a
  centered `<main>`. Forwards its own `permissions` prop to both `NavLinks` instances.

## Dependencies on other owners

`@/modules/sign-in/actions` (`signOutAction`), `@/modules/workspaces/actions`
(`switchWorkspaceAction`, decisions/0070-several-workspaces-per-user.md - imported the same
way `signOutAction` is), `@/platform/access` (`Permission`, type
only), `@/shared/ui-primitives` (`Button`, `cn`). `lucide-react` (already a project
dependency) for the hamburger/close glyphs and the section chevron.

## Consumers

`src/app/(app)/layout.tsx` (seam): calls `requireWorkspaceMember()`, then renders
`DashboardShell` with `userEmail={access.user.email}`, `workspaceName={access.workspace.name}`,
`activeWorkspaceId={access.workspace.id}`, `workspaces={...}` (from
`listWorkspacesProjection(access.user.id)`, decisions/0070-several-workspaces-per-user.md),
and `permissions={access.permissions}` around `{children}`.

## Tests

`tests/nav-items.test.ts` (unit): every entry's and every section heading's `labelKey` resolves
in `de.json` (the P6 review finding: a nav item shipped with the raw message key as its label),
no route is listed twice, every `/dashboard/finance` entry is gated behind `finance.read`, plus
`activeNavHref`'s longest-match rule, `visibleNavSections`' empty-section removal, and
`sectionTarget`/`activeSectionKey` (decisions/0057-sections-are-disclosures.md: which entry a
heading goes to, and which section starts open for a given path).

`tests/workspace-switcher.test.tsx` (Testing Library + jsdom,
decisions/0070-several-workspaces-per-user.md): a single-workspace user gets the plain name
and no control; several workspaces list, mark the active one (disabled, `aria-current`) and
offer "Weitere Firma anlegen"; a click submits that workspace's id to the mocked Server
Action; an error code renders its German copy.

Beyond that, `tests/e2e/onboarding.spec.ts` (which also drives the switcher itself) and
`tests/e2e/serial/auth.spec.ts` (sign-out, the
`/dashboard` heading) exercise the shell end to end, and `tests/e2e/finance.spec.ts` /
`tests/e2e/settlement.spec.ts` assert that a member sees no "Finanzen" group at all. Apart
from the switcher above, the `ui/` components hold no logic of their own beyond the
mobile-nav toggle, a single piece of local state. Add a Testing Library test here if that
changes.
