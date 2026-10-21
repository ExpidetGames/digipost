# German is the single UI language at launch

Document type: decision
Lifecycle: active
Owner: src/i18n
Scope: What language Digipost's user-facing UI copy ships in, the register used, and how
that interacts with the existing single-locale next-intl setup
Canonical responsibility: Active source for why `src/i18n`'s only locale is `de`, why
copy uses the formal "Sie" register, and how adding English later is expected to work
Maintenance triggers:
- A second locale (English or otherwise) is added
- The register (Sie vs. du) changes
- AGENTS.md's "Code" section language rule is revisited
Last verified: 2026-09-19, P0b phase, against `src/i18n/request.ts`,
`src/i18n/messages/de.json`, and AGENTS.md's "Code" section

## Status
Accepted

## Context

Digipost's PRD targets the German/DACH small-business market exclusively at launch: the
product scans, OCRs, and routes paper mail for German SMBs, and every early customer
interaction (the marketing site, onboarding, the inbox, email notifications) happens in
German. English support is deferred until there is validated demand outside the DACH
market; building bilingual UI copy now would be speculative work with no current user.

The repository template this project is built from (`AGENTS.md`'s "Code" section, as it
read before this ADR) stated a blanket rule: "English identifiers, comments, and
documentation everywhere in code and docs. No UI copy, code, or documentation in any
language other than English." That rule predates Digipost's product decision and does
not fit a German-only launch: literally applied, it would require English UI copy for a
product whose entire user base is German-speaking businesses, which the PRD rules out.

`src/i18n` already ships next-intl with a single locale and no locale routing
(`src/i18n/README.md`, WEBAPP_TEMPLATE_SPEC.md §2.5): `request.ts` resolves one hardcoded
locale, and every UI string already goes through `useTranslations`/`getTranslations`
rather than being hardcoded in components. Switching that one locale from `en` to `de` is
therefore a translation and configuration change, not a rewrite of any component.

## Decision

1. **UI copy is German, "Sie"-form.** Every user-facing string, the marketing landing
   page, the authenticated app, form labels and errors, and outbound email (the
   magic-link sign-in mail) is written in German, using the formal "Sie" register (German
   B2B/SMB convention), not "du". `src/i18n/request.ts`'s `defaultLocale` is `de`;
   `src/i18n/messages/de.json` is the only message catalog; `en.json` is deleted, not kept
   alongside it. `src/app/layout.tsx`'s `<html lang="de">` matches.
2. **Code, identifiers, comments, docs, commit messages, and error codes stay English.**
   This ADR narrows, rather than reverses, AGENTS.md's "Code" section rule: "no UI copy in
   any language other than English" is replaced by "UI copy is German (served through
   next-intl, single locale `de`); code, identifiers, comments, docs, commit messages,
   error codes stay English." Stable error codes (already required to be `as const` sets,
   never raw text) are unaffected: they are still English identifiers that the UI
   translates to German copy, never the other way around.
3. **No em dash, no en dash, in any copy or docs.** Existing repository-wide style
   (DOC_RULES.md §7, AGENTS.md) already forbids the em dash character ("—") in
   documentation and product copy. This decision extends the same rule to UI copy and
   restates it precisely for German text: an en dash ("–") is also avoided, since German
   typography uses it in places (number ranges, some compound constructions) an
   English-trained reviewer might not flag; use a plain hyphen, comma, colon, or
   parentheses instead in both docs and UI copy.
4. **The one-string-catalog-per-locale infrastructure does not change.** This is a
   content and default-value change, not an architecture change:
   `src/i18n/request.ts` still resolves a single hardcoded locale with no routing;
   only the identifier moves from `en` to `de`.
5. **English comes later, as a routing change.** When validated demand outside the DACH
   market justifies it, English is added the way `src/i18n/README.md` already describes
   for "a second locale": a `[locale]` segment, a middleware/proxy matcher, a locale
   switcher, and a new `messages/en.json` catalog with the same key set as `de.json`.
   Components that already call `useTranslations`/`getTranslations` do not need to
   change; only the routing and config layer does. This decision does not schedule that
   work, only records the plan so it is not confused with a rewrite.
6. **The magic-link email is German too, but not routed through next-intl.**
   `src/platform/auth/server/emails/magic-link-email.tsx` hardcodes its German subject and
   body rather than calling `useTranslations`: it renders inside Better Auth's
   `sendMagicLink` callback, which runs without an active Next.js request and therefore
   without a request-scoped next-intl context. This is a placement detail, not an
   exception to the "UI copy is German" rule.

## Consequences

- Positive: the product's only real audience (German SMBs) gets correct, professional
  copy from day one, instead of a placeholder English UI that would need translation
  before any real user could use the product.
- Positive: no architectural cost. Single-locale next-intl with no routing was already
  the state before this decision; only the locale identifier and the catalog content
  changed, so every consumer that calls `useTranslations`/`getTranslations` needed no
  code change, only its call sites' expected message content changed.
- Negative: every test that asserts on UI copy (`tests/e2e/**/*.spec.ts`, the
  `create-project-form` component test) had to be updated in the same phase this decision
  landed in, since Playwright's `getByRole`/`getByText`/`getByLabel` match visible text.
  A future English rollout repeats this cost in reverse (or duplicates assertions per
  locale) unless tests are refactored to resolve expected copy from the message catalog
  by key instead of hardcoding strings.
- Negative: AGENTS.md's blanket "no UI copy in any language other than English" rule
  needed amending; a reader of an old AGENTS.md revision (or cached context) would
  incorrectly flag German UI copy as a violation. AGENTS.md's "Code" section and "Last
  verified" line are updated in the same change as this ADR to close that gap.
- Neutral: `Intl.DateTimeFormat`/number formatting call sites that previously hardcoded
  `"en"` (for example `src/modules/projects/ui/project-item.tsx`) now hardcode `"de"`
  instead of reading `src/i18n/request.ts`'s `defaultLocale`; a future second locale needs
  to revisit these call sites the same way it revisits routing, so they resolve the
  active locale rather than a hardcoded one.
- Implementation status: **implemented**. `src/i18n/request.ts`, `src/i18n/messages/de.json`
  (replacing `en.json`), `src/app/layout.tsx`, `src/app/opengraph-image.tsx`,
  `src/platform/auth/server/emails/magic-link-email.tsx`, every UI component that read from
  the message catalogs, and every test asserting on UI copy were updated in the same
  phase (P0b) this ADR was written in.

## Supersedes / Superseded By
- None
