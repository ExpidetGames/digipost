# A nav section is a disclosure, and its heading goes to the first entry

Document type: decision
Lifecycle: active
Owner: src/modules/dashboard-shell
Scope: How `NAV_SECTIONS` renders: one open section at a time, headings that navigate
Canonical responsibility: Active source for the sidebar's open/closed behaviour
Maintenance triggers:
- A section's first entry changes (the heading's target changes with it, by construction)
- A section that was all planned gets its first real route
Last verified: 2026-09-23

## Status

Accepted. Extends decisions/0055-navigation-by-use-case.md.

## Context

Grouping the sidebar by use case (decisions/0055) made it legible but not shorter: fifteen rows
plus four headings were all visible at once, and "Verwaltung" alone took five rows a user opens
a few times a month. The owner's words: the sidebar is too full.

A plain collapsible group would have made it shorter and worse, because the heading would then
be a control that only unfolds: one click to open, a second to go somewhere. The heading already
names a room that has a front door.

## Decision

- **A labelled section is a disclosure, and exactly one is open.** By default it is the section
  holding the current page, derived from the path (`activeSectionKey`), so a full page load
  needs no stored state and lands with the right section open.
- **A heading is two controls, not one.** The label is a link to the section's first built entry
  (`sectionTarget`) and opens the section by arriving there. The chevron beside it only opens
  and closes, so a user can look into a section without leaving the page they are on. A single
  control doing both was the first attempt and was wrong in practice: every peek moved the user.
- **A section whose entries are all still planned** ("Abschluss") has nowhere to navigate, so
  its label toggles like its chevron and carries the "Demnächst" badge itself: a closed sidebar
  still says the area is coming.
- **A visitor's own override is remembered together with the path it was made on**
  (`{ forPath, key }`). Opening a section without navigating (the planned-only case, or
  reopening a closed one) holds until the next navigation, which falls back to the active
  section. No effect watches the router, and no state survives a page change it should not.
- **Standalone entries stay flat.** "Start" and "Kontakte" are single rooms, not groups, so they
  are never inside a disclosure and `activeSectionKey` returns `null` for them.

## Consequences

- The sidebar is nine rows instead of nineteen when the user is in "Post", and the rooms a user
  visits rarely cost one row each.
- Two links may point at the same route (the "Finanzen" label and its "Konten" entry). That is
  deliberate: the label is the door, the entry is the room, and only the entry gets
  `aria-current="page"`.
- `aria-expanded`/`aria-controls` sit on the chevron button, which is the control that actually
  expands anything. It carries a screen-reader-only name
  (`DashboardShell.nav.toggleSection`) naming its section, so two controls in the same row are
  never announced identically.

## Alternatives considered

- **Hover-opened flyouts.** Rejected: unusable on touch, and the mobile nav renders the same
  component.
- **Remember the open section in `localStorage`.** Rejected: the current page already says which
  section matters, and stored UI state that disagrees with the page is a bug waiting to happen.
- **Let several sections be open at once.** Rejected: that is the current problem with extra
  steps.
