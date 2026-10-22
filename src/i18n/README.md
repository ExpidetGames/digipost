# i18n

Document type: reference
Lifecycle: active
Owner: i18n
Scope: next-intl configuration and message catalogs
Canonical responsibility: The one place UI strings are externalized and the request-time
locale/messages config lives
Maintenance triggers:
- A second locale is added (this owner then also adds locale routing, per
  WEBAPP_TEMPLATE_SPEC.md §2.5)
- A new top-level message namespace is introduced
Last verified: 2026-10-22, decisions/0075-email-intake.md added the `MailIntake` namespace and
`DocumentDetail.receivedByEmailFrom`. Previously 2026-09-20, F1b added the `DocumentKinds`, `SettlementPlatforms`,
`SemanticFields`, and `IntakeSettings` namespaces (decisions/0022-intake-wiring.md), plus
intake-related keys under the existing `DocumentDetail`, `Inbox`, `Scan`, and
`DashboardShell.nav` namespaces. P3 added the `Billing` namespace
(decisions/0017-billing-tiers-and-packages.md); P2a added the `Scan`, `DocumentDetail`, and
`Categories` namespaces (decisions/0015-documents-and-quotas.md)

## Purpose

Every UI string is externalized into `messages/<locale>.json` instead of hardcoded in
components, per WEBAPP_TEMPLATE_SPEC.md §8. The template starts with a single locale and
no locale routing (§2.5): `request.ts` always resolves to `de`. Digipost launches
German-only for the DACH market (`decisions/0013-german-ui-language.md`); English comes
later, once there is validated demand, and adding it means adding routing (a `[locale]`
segment, a middleware/proxy matcher, a locale switcher), not rewriting components that
already call `useTranslations`/`getTranslations`. All UI copy is written in the formal
"Sie" register, matching German B2B/SMB convention.

## Public interfaces

- `request.ts`: the `next-intl/server` `getRequestConfig` implementation wired into
  `next.config.ts` via `createNextIntlPlugin`. Exports `defaultLocale` for anything that
  needs it outside the request-config flow (currently nothing; kept for the routing step).
- `messages/de.json`: the message catalog. Namespaced by area (`Metadata`, `Marketing`,
  `Legal`, `Login`, `DashboardShell`, `Onboarding`, `Invite`, `Inbox`, `Team`, ... more as
  pages and modules land); a
  namespace matches how the consuming code calls
  `useTranslations("Namespace")`/`getTranslations("Namespace")`.

## Structure

- `request.ts`: request-time locale/messages resolution.
- `messages/de.json`: the (currently only) message catalog.

## Invariants

- No UI copy is hardcoded in a component when a translation exists for it; new copy goes
  into `messages/de.json` under the namespace matching its owner (page, module, or
  shared component), written in German, "Sie"-form.
- Code, identifiers, comments, and documentation stay English (AGENTS.md's "Code"
  section); only user-facing UI copy is German.
- `src/app/layout.tsx` wraps the app in `NextIntlClientProvider` once, at the root; no page or
  component re-wraps it, and its `<html lang="de">` matches the single locale.
- The magic-link email (`src/platform/auth/server/emails/magic-link-email.tsx`) is German
  too, but hardcoded rather than routed through next-intl: it renders outside a
  request-scoped next-intl context (Better Auth's `sendMagicLink` callback runs without an
  active Next.js request).

## Tests

None yet: `request.ts` is a thin, side-effect-free config function. A future second
locale gets a test asserting both catalogs have the same key set.
