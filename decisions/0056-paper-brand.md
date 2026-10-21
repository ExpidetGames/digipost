# The paper brand: one palette, a serif for headings, light only

Document type: decision
Lifecycle: active
Owner: src/shared/ui-primitives
Scope: The design tokens in `src/app/globals.css`, the fonts loaded in `src/app/layout.tsx`,
and the visual language every surface follows
Canonical responsibility: Active source for what Digipost looks like and which token carries
which job
Maintenance triggers:
- A token's value changes (re-check the contrast ratios noted next to it)
- A new token is needed (add it to `@theme inline` with a comment saying what it is for)
- Dark mode is reconsidered (see "Light only" below: it has to be designed, not derived)
Last verified: 2026-09-23, against the owner's own landing-page reference

## Status

Accepted. Replaces the template's placeholder palette (`WEBAPP_TEMPLATE_SPEC.md`'s neutral blue)
and supersedes the "swap `--accent*` when you brand this" note in
`src/shared/ui-primitives/README.md`.

## Context

Everything visual was still the starter template's: a blue-600 accent, a system sans on every
surface, 10px corner radii and shadowed cards. The owner supplied a finished landing-page
reference in a different visual language entirely: warm off-white paper, hairline rules instead
of shadows, a deep navy that carries both buttons and accent text, a serif for headings, and a
3px radius. The instruction was to rebuild the style completely onto it, not only the landing
page.

The reference's own mockup uses a different product name ("Klarpost", "Beispiel GmbH"). That is
placeholder naming inside the mockup, not a rename: the product stays Digipost.

## Decision

**One palette, expressed in the template's existing token names** so no component had to learn a
new vocabulary. `src/app/globals.css` now carries real values instead of placeholders:

| Token | Value | Job |
| --- | --- | --- |
| `--background` | `#FAFAF8` | the page, warm off-white |
| `--muted` / `--paper` | `#F3EFE5` | the warmer band that carries a whole section |
| `--foreground` | `#1C1E22` | ink, 15.9:1 on the page |
| `--muted-foreground` | `#5C5F66` | secondary text, 6.1:1 on the page, 5.6:1 on the band |
| `--border` / `--input` | `#DEDACD` | every hairline |
| `--primary` / `--accent-strong` / `--ring` | `#1F3A5F` | buttons (11.5:1 under white) and accent text (11.0:1 on the page) |
| `--accent` | `#E8EEF3` | the hover and active surface |
| `--brand-warm` | `#A8481E` | small decorative marks only, 6.3:1 on the page |
| `--brand-positive` | `#1E6A4F` | money in (a credit amount), 6.2:1 on the page |
| `--radius` | `3px` | paper and ruled lines, not rounded cards |

Three of these are new names. `--paper` is `--muted`'s value under a name that says what it does
on a page rather than which component state it belongs to. `--brand-warm` is the rust mark (the
dot on "Meist gewählt", a rule under a numeral) and is deliberately NOT `--destructive`: it
never signals an error. `--brand-positive` replaced the single hard-coded Tailwind palette class
left in the whole application (`text-emerald-600` on a credit amount in the account view), whose
cool green clashed with the warm page and sat at 4.2:1, below AA for small text.

The template's own contrast rule survives unchanged: `--primary`/`--accent` stay background
colours paired with a `-foreground` token, and `--accent-strong` is the only accent colour
allowed as small text. This palette makes that easy, because the navy is dark enough to serve
both jobs, which the placeholder blue was not.

**Headings are a serif, everywhere.** Newsreader carries `h1` and `h2` through a base-layer rule
in `globals.css`; IBM Plex Sans carries everything else. Both are loaded by `next/font` and
self-hosted, so there is no runtime request to Google and no flash of a late webfont. An element
that wants a sans heading opts out with `font-sans`; a `h3` that wants the serif opts in with
`font-heading`. The app's wordmark uses the serif too, so the dashboard and the landing page
read as one product.

**Cards are hairlines, not shadows.** `ui/card.tsx`'s `ring-1 ring-foreground/10` became
`ring-1 ring-border`. Still a ring rather than a border, so no box size changes.

**Light only.** The product has no theme toggle and never had one, so `next-themes` with
`defaultTheme="system"` only ever meant "this visitor's operating system is dark" rendered
against a palette nobody had designed for that. The `ThemeProvider` is gone from
`src/app/layout.tsx`, nothing sets `.dark`, and the dark token block is deleted. The
`@custom-variant dark` declaration stays so the shadcn primitives' own `dark:` utilities keep
compiling; none of them ever match.

## Consequences

- Rebranding again means editing `:root` in one file, exactly as the template intended.
- Every surface changed at once, including ones nobody looked at during this work (invite,
  onboarding, the legal pages). They inherit the palette correctly because they were already
  written against tokens, but they were not individually reviewed for the serif headings.
- `next-themes` stays installed but unused. Re-introducing dark mode means designing a second
  palette, not deriving one from these values: a warm paper brand has no automatic dark twin.
  `WEBAPP_TEMPLATE_SPEC.md` still lists `next-themes` and "Light/Dark" as part of the stack: it
  is the template's architecture reference, and for anything the product has actually built this
  ADR is the more current source (`AGENTS.md`'s own rule for when the two disagree).
- The reference's copy uses em dashes. Ours does not and must not
  (`AGENTS.md`'s "Code" section), so any phrase carried over from the mockup is repunctuated.

## Alternatives considered

- **Keep dark mode and derive a dark palette.** Rejected: inventing a second palette nobody
  asked for, for a mode nobody can select, is a brand decision made by accident.
- **Style only the marketing page.** Rejected: the instruction was the whole style, and a
  landing page that looks nothing like the product it sells is worse than either one alone.
- **Introduce a new set of brand-named tokens** (`--ink`, `--line`, `--paper-soft`) and migrate
  components onto them. Rejected for now: it would touch every component for no visual gain.
  Only `--paper` and `--brand-warm` earned new names, because no existing token meant that.
