# The navigation is grouped by use case, and a planned capability says so

Document type: decision
Lifecycle: active
Owner: src/modules/dashboard-shell
Scope: `NAV_SECTIONS` and its two helpers, how `ui/nav-links.tsx` renders them, and the removal
of the in-page finance tab bar
Canonical responsibility: Active source for how the authenticated app is divided into areas and
how a not-yet-built area is presented
Maintenance triggers:
- A planned entry gets its route (drop its `href: null`, remove it from the "planned" list below)
- A new capability needs a place in the sidebar
- The permission gating a section's entries changes
Last verified: 2026-09-23, against the shipped pages under `src/app/(app)/dashboard`

## Status

Accepted. Supersedes the flat `NAV_ITEMS` list introduced with the template and extended by
decisions/0016, 0017, 0020, 0022 and 0024.

## Context

The sidebar listed eight entries in the order the features had been built: Posteingang, Post
erfassen, Kontakte, Team, Zuständigkeiten, Tarif & Nutzung, Firmendaten, Erkannte Quellen,
Finanzen. That order mirrors this repository's own tables and phases, not anything a user does.
Three concrete problems followed from it:

- Settings (Team, Zuständigkeiten, Firmendaten, Erkannte Quellen, Tarif & Nutzung) took five of
  nine slots and sat between the two things a user opens daily.
- The finance area's three pages (Konten, Zuordnung, Offene Posten) were reachable only through
  a tab bar repeated inside each of those three pages. They are separate jobs ("stimmt mein
  Konto", "was ist ungeklärt", "wer schuldet mir was"), not tabs of one page, and they were
  invisible from anywhere else in the app.
- The product's own shape was invisible. A user could not tell that a work list, an e-mail
  intake channel and a month-end area are intended, so an area we have not built reads as an
  area that does not exist.

## Decision

The sidebar is grouped by the moment a user is in, and each group is a room:

| Section | Entries |
| --- | --- |
| (no heading) | Start (planned) |
| Post | Posteingang, Post erfassen, E-Mail-Eingang (planned) |
| Finanzen | Konten, Zuordnung, Offene Posten, all `finance.read` |
| Abschluss | Monatsabschluss (planned), Steuerberater-Export (planned), both `finance.read` |
| (no heading) | Kontakte |
| Verwaltung | Team, Zuständigkeiten, Firmendaten, Erkannte Quellen, Tarif & Nutzung |

("Geld" was renamed to "Finanzen" later, and "Zuständigkeiten" is gone entirely with
decisions/0063-no-category-no-assignment-no-routing.md. The table above is the shape this
decision established; `NAV_SECTIONS` is the current truth.)

Three rules carry it:

- **A planned capability is listed with `href: null`** and renders as a row with a "Demnächst"
  badge, never as a link: the shape of the product is visible, and nobody can click their way
  to a page that does not exist. Planned today: Start (the work list: what waits for
  confirmation, what failed, what is overdue, which payments have no document yet: built since,
  see `/dashboard/start`), E-Mail-Eingang (a forwarding address per workspace), Monatsabschluss (is the month complete) and Steuerberater-Export.
- **A section disappears with its heading** once every entry in it is filtered out by
  `permission`. A member therefore sees no empty "Finanzen" or "Abschluss" block, which keeps
  decisions/0024's rule ("finance is admin-only, end to end") visible in the chrome itself.
  Filtering stays display only: the real authorization is still the page's own `notFound()`.
- **The active entry is the longest matching `href`**, matched at a segment boundary. This
  replaces the previous special case for `/dashboard` and additionally gives every page without
  a nav entry of its own a sensible marker: `/dashboard/documents/<id>` marks Posteingang,
  `/dashboard/finance/<accountId>` marks Konten.

The finance tab bar is removed from all three finance pages, along with its `Payments.financeTabs`
copy. The sidebar is now the only place those three pages are navigated from.

## Consequences

- Adding a capability means choosing the moment it belongs to, not appending to a list.
- The four planned entries are a promise visible to every user of a workspace. Removing one is a
  product decision, not a cleanup.
- Page headings are unchanged ("Finanzen" on `/dashboard/finance`, "Zuordnung",
  "Offene Posten"), so a heading and its nav label may differ; the nav label names the job
  ("Konten"), the heading names the page.
- E2E tests that asserted a member sees no finance link now assert the whole group is absent,
  which is the stronger statement.

## Alternatives considered

- **A placeholder route per planned entry.** Rejected: a page that says "coming soon" is a page
  to maintain, route-test and translate, and it tells a user nothing the badge does not.
- **Keeping the finance tab bar as well.** Rejected: two navigations for the same three pages,
  one of which only exists once you are already inside the area.
- **Settings behind a single "Einstellungen" entry with a sub-page.** Rejected for now: it hides
  five working pages behind an extra click to solve a problem the grouping already solves.
