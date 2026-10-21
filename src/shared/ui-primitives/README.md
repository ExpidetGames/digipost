# src/shared/ui-primitives

Document type: reference
Lifecycle: active
Owner: src/shared/ui-primitives
Scope: shadcn/Base UI presentational primitives and the `cn()` class-merge helper
Canonical responsibility: The one place these presentational primitives live;
`components/ui/**` must not be created (see AGENTS.md's structure hard stops)
Maintenance triggers:
- A `shadcn` component is added or updated (`components.json`'s `ui`/`utils` aliases
  point here)
- A design token's value changes (re-check the contrast pairs below)
Last verified: 2026-09-23, decisions/0056-paper-brand.md: the placeholder palette became
Digipost's own (paper background, hairline borders, navy accent, 3px radius), Newsreader
and IBM Plex Sans arrived via `next/font`, `ui/card.tsx`'s shadow ring became a hairline in
`--border`, and dark mode was removed. Previously, 2026-09-14, initial scaffold (button,
input, label, card)

## Purpose

Neutral, zero-persistence presentational components: the `shadcn`/Base UI primitives
(`button`, `input`, `label`, `card` today; more are added the same way as they're
needed) and `cn()` (class merge: `clsx` + `tailwind-merge`, resolving conflicting
Tailwind utility classes in favor of the last one). This owner is exempt from the usual
"≥ 2 real consumers" rule for `src/shared/<purpose>/`: it is the designated, singular home
for the component library regardless of how many places use any one component yet.

## Public interfaces

`index.ts` (neutral, no `server-only`, no `"use client"` of its own; `label.tsx` carries
its own `"use client"` directive, which is fine to import from a neutral barrel, the
normal RSC pattern): re-exports every named export of every file under `ui/`, plus `cn`
from `core/cn.ts`.

## Structure

- `core/cn.ts`: `cn()`, built from `clsx` (conditional class names) and `tailwind-merge`
  (resolves conflicting Tailwind utility classes).
- `ui/*.tsx`: one file per component, generated via `pnpm exec shadcn add <name>`
  (`components.json`'s `style: "base-nova"` selects the Base UI variant) and then
  reviewed: the generator's own `cn` import (from the `cn` npm package) is replaced with
  this owner's `core/cn.ts`, and any token reference that assumes a `--primary`-as-text
  usage is corrected to `--accent-strong` per the contrast rule below.
- `index.ts`: public barrel (`export *` per file, no name collisions).

## Design tokens and the contrast rule

Every color lives in `src/app/globals.css` and is swappable without touching component code,
as long as the same rule below is kept:

- `--primary` / `--accent` are tuned as **background** colors, always paired with their
  own `-foreground` token for text placed on top of them (white on `--primary` is 11.5:1,
  `--accent-foreground` on `--accent` is 14.3:1). Never assume a hard-coded white or black
  reads correctly on either one; use the paired token.
- `--accent-strong` is the token for accent-colored **text on the page background** (links,
  small labels, anything smaller than large-text size). Never apply `--primary` or
  `--accent` directly as a `text-*` color; the button `link` variant
  (`ui/button.tsx`) is the reference example (`text-accent-strong`, not `text-primary`).
- `--muted-foreground` is tuned against both `--muted` and `--background` (see the
  comments in `src/app/globals.css` for the measured contrast ratios); do not swap it for a
  lighter gray without re-checking both.

Those placeholders are gone: decisions/0056-paper-brand.md put Digipost's real palette in
the same token names (warm off-white page, `#F3EFE5` band, `#DEDACD` hairlines, a deep navy
`#1F3A5F` that carries both button backgrounds and accent text, 3px radius). Two token names
are new and live in `@theme inline` next to the others: `--color-paper` (the band that
carries a whole section, the same value as `--muted` under a name describing its job on a
page), `--color-brand-warm` (the rust mark, small decorative use only, never an error
state, which is `--destructive`), and `--color-brand-positive` (a credit amount, the one
place a colour carries meaning on its own). Never reach for a Tailwind palette class such
as `text-emerald-600` instead: there is exactly one colour vocabulary, and it is these
tokens. Rebranding again still means editing `:root` in
`src/app/globals.css` and re-verifying the contrast pairs named above.

## Typography

Headings are a serif: `src/app/layout.tsx` loads Newsreader and IBM Plex Sans through
`next/font` (self-hosted, no runtime request to Google), `globals.css` maps them onto
`--font-heading`/`--font-sans`, and a base-layer rule gives every `h1`/`h2` the serif at
weight 500. An element that wants a sans heading opts out with `font-sans`; an `h3` that
wants the serif opts in with `font-heading`.

## Light only

There is no dark mode and no theme toggle (decisions/0056-paper-brand.md): nothing sets
`.dark`, and `src/app/layout.tsx` renders no `ThemeProvider`. The
`@custom-variant dark (&:is(.dark *))` declaration stays in `globals.css` so the `dark:`
utilities these shadcn primitives ship with keep compiling, but none of them ever match.
Re-introducing dark mode means designing a second palette, not deriving one.

## Consumers

`src/app/(marketing)/**` (landing page, legal placeholder pages, marketing layout),
`src/modules/sign-in` (login form), `src/modules/workspaces` (onboarding, team, and
invitation UI), `src/modules/dashboard-shell` (sidebar/header chrome). List new consumers
here so the "≥ 2
consumers" bar other `src/shared/` owners must clear stays checkable by example.

## Tests

None yet: these are thin wrappers around Base UI primitives with no owned logic beyond
class composition. A future non-trivial addition (a compound component with real state)
gets a Testing Library test alongside it.
