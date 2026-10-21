# src/modules/billing

Document type: reference
Lifecycle: active
Owner: src/modules/billing
Scope: The `/dashboard/billing` ("Tarif & Nutzung") page's non-seam code: tier/package data,
the pure quota-evaluation and warning-crossing functions, the `PaymentProvider` port and its
test-mode adapter, the admin-only tier-change/package-purchase Server Actions, and the 80%
warning e-mail; usage tracking (writes) and the persistence use cases live in
`src/persistence/use-cases/billing-use-cases.ts` (this module owns the schema, per
`src/persistence/README.md`'s ownership table)
Canonical responsibility: `TIERS`/`TIER_LIMITS`/`PACKAGES`/`evaluateQuota`/
`evaluateWarningCrossing` (architecture brief's product decisions 1, 3, 5, 6 made code) plus
everything `/dashboard/billing` delegates to except its own page shell
Maintenance triggers:
- A tier's price or limits change, or a tier is added/removed
- A package's price or `extraDocuments` changes
- Stripe (or another real payment provider) is actually integrated - see
  decisions/0017-billing-tiers-and-packages.md's "What a future Stripe adapter needs to
  implement"
- The 80% warning threshold, its wording, or its "at most once per period" rule changes
Last verified: 2026-09-19, P3 (billing, quota packages, and warnings,
decisions/0017-billing-tiers-and-packages.md)

## Purpose

Tiers: `free` (0 EUR, 20 total docs, no monthly limit), `starter` (29 EUR, 750 total,
100/month), `pro` (79 EUR, 5000 total, 500/month), `unlimited` (249 EUR, 200000 total,
5000/month). Packages (one-off, current calendar month only): `s` (+250 docs, 19 EUR), `m`
(+1000, 59 EUR), `l` (+5000, 249 EUR) - raise the monthly limit, never past the tier's total
limit; Free cannot purchase one (no monthly limit to raise).

`/dashboard/billing` ("Tarif & Nutzung"): every workspace member sees the current tier,
price, both limits as accessible progress bars with exact numbers (Free's monthly limit is
shown as "kein monatliches Limit", never a `0`-valued bar), and this period's package
purchases; only `billing.manage` (admin-only, `src/platform/access`) sees the tier-change
and package-purchase controls, and only when `BILLING_TEST_MODE=true` (no Stripe keys
exist - architecture brief's product decision 3). A workspace crossing 80% of either limit
gets a warning e-mail, at most once per limit per calendar month, sent by an outbox job this
module's persistence use case enqueues.

See decisions/0015-documents-and-quotas.md for the original quota-evaluation design (P2a)
and decisions/0017-billing-tiers-and-packages.md for everything this phase (P3) added: the
UI, the `PaymentProvider` port, tier changes, package purchases, and the warning e-mail.

## Public interfaces

- `index.ts` (neutral, no `server-only`, no `"use client"`, no I/O): `TIERS`, `TIER_LIMITS`,
  `Tier`, `TierLimits`, `PACKAGE_KEYS`, `PACKAGES`, `PackageKey`, `PackageDefinition`,
  `canPurchasePackages`, `QUOTA_ERROR`, `QuotaErrorCode`, `evaluateQuota`,
  `EvaluateQuotaInput`, `QuotaEvaluation`, `periodKeyFor`, `WARNING_THRESHOLD_RATIO`,
  `evaluateWarningCrossing`, `WarningCrossing`, `PaymentProvider`, `PaymentResult`,
  `PaymentProviderError`, `createTestPaymentProvider`, `createNotConfiguredPaymentProvider`.
  Safe to import from persistence schema/use-cases, from client-reachable code (P4's
  marketing pages read `TIERS`/`TIER_LIMITS`/`PACKAGES` for the pricing section), and from
  this module's own `ui/*.tsx`.
- `server.ts` (`import "server-only"`): `getPaymentProvider`, `isBillingTestModeActive`,
  `resetPaymentProviderForTests` (env-based `PaymentProvider` selection), `getUsageViewModel`
  (the `/dashboard/billing` read model), `quotaWarningEmailSubject`/`renderQuotaWarningEmail`
  (the warning e-mail - called only from `src/persistence/composition/job-handlers.ts`, a
  composition-rank file, never from a use case).
- `actions.ts` (`"use server"`): `changeTierAction`, `purchasePackageAction`, both admin-only
  (`billing.manage`) and returning `ActionResult<TData, BillingActionErrorCode>`
  (`@/shared/action-result`).
- `client.ts` (`"use client"`): `BillingPageClient`.

## Structure

- `core/plans.ts` - `TIERS`/`TIER_LIMITS`/`PACKAGES`/`canPurchasePackages`/`evaluateQuota`
  (checks the total limit first, then the monthly limit if the tier has one) and
  `periodKeyFor` (first day of a date's UTC month, the `period` key every billing table
  uses) - all P2a. P3 added `WARNING_THRESHOLD_RATIO`/`evaluateWarningCrossing`: given the
  post-add ratios and the current period's `warnedTotalAt`/`warnedMonthlyAt` markers,
  returns which limit(s), if any, just crossed 80% for the first time this period - a
  non-`null` marker suppresses a further crossing unconditionally, which is the entire "at
  most once per limit per calendar month" guarantee (proved under real concurrency in
  `src/persistence/tests/documents-use-cases-concurrency.db.test.ts`).
- `core/payment-provider.ts` - the `PaymentProvider` port (`changeTier`/`purchasePackage`,
  each returning `{ provider, providerReference }`), `PaymentProviderError` (thrown by the
  not-configured adapter, stable code `billing_not_configured`), `createTestPaymentProvider`
  (completes instantly, `provider: "test"`, no I/O), `createNotConfiguredPaymentProvider`
  (every call throws - bound whenever `BILLING_TEST_MODE` is not `true`). Pure: no env
  access here, only in `server/get-payment-provider.ts`.
- `core/usage-view-model.ts` - `buildUsageViewModel`: pure formatting from raw usage numbers
  into the `/dashboard/billing` page's `UsageViewModel` (both ratios pre-clamped to `[0, 1]`,
  `hasMonthlyLimit`/`monthlyLimit`/`effectiveMonthlyLimit`/`monthlyRatio` all `false`/`null`
  for Free - "show that correctly, not as 0"). Unit-tested directly, so the free-tier
  formatting rule is proven without rendering anything.
- `core/error-codes.ts` - `BILLING_ACTION_ERROR_CODES`/`BillingActionErrorCode` (mirrors
  `src/persistence/use-cases/billing-use-cases.ts`'s `BILLING_ERROR` plus `invalid_input`
  and `src/platform/access`'s `WorkspaceAccessErrorCode`) - an `as const` set the UI
  translates via `Billing.errors`.
- `core/schemas.ts` - Zod input schemas for both actions (`{ tier }`/`{ packageKey }`,
  reusing `TIERS`/`PACKAGE_KEYS`).
- `server/get-payment-provider.ts` - `getPaymentProvider`/`isBillingTestModeActive`: reads
  `BILLING_TEST_MODE` (`src/platform/env`) exactly once per selection, the same
  lazy-singleton-by-env shape `src/platform/mistral/server/get-ai-adapters.ts` uses for
  `AI_PROVIDER`.
- `server/read-models.ts` (published through `server.ts`) - `getUsageViewModel`: combines
  `billing.getUsage`, `documents.countStored`, and `billing.listPurchasesForCurrentPeriod`
  (all via `getRequestServices()`) through the pure `buildUsageViewModel`, `cache()`d per
  request.
- `server/emails/quota-warning-email.tsx` - the 80% warning e-mail (React Email, German,
  names the workspace, the limit, the current numbers, links to `/dashboard/billing`),
  `STRUCTURE.md`'s `vendor-sdk` rule extended to allow `@react-email/` in this directory.
- `actions.ts` - the two Server Actions. `mapUseCaseError` translates a thrown
  `UseCaseError` (`BILLING_ERROR` codes) into this module's own codes;
  `requirePermission(PERMISSIONS.billingManage)` gates both - the actual, unconditional
  refusal when `BILLING_TEST_MODE` is off happens one layer deeper, inside
  `billing-use-cases.ts` itself (see decisions/0017's "Two independent refusal layers"), so
  calling either action directly still refuses correctly.
- `ui/usage-progress-bar.tsx` - `UsageProgressBar`: a labelled native `<progress>` element
  plus exact numbers; renders a "kein Limit"-style label instead of a bar when `max` is
  `null`.
- `ui/tier-change-form.tsx` - `TierChangeForm`: a tier `<select>` plus submit, the
  "Testmodus" badge, and the client-rendered `downgrade_below_stored_count` message (the
  page's own `storedDocuments` plus `TIER_LIMITS[selectedTier].totalDocuments` - the stable
  error code carries no numbers itself).
- `ui/purchase-package-form.tsx` - `PurchasePackageForm`: one card per package (S/M/L) with
  its own buy button, the "Testmodus" badge, and copy stating capacity is for the current
  month only and never raises the total limit. Never rendered on Free.
- `ui/billing-page-client.tsx` - `BillingPageClient`: the usage section (everyone), the
  purchase list (everyone), and `AdminControls` (only for `canManage`, itself splitting on
  `testModeActive` - the tier-change/package-purchase forms when true, a "payment not
  connected yet" notice plus a contact hint when false) or, for a plain member, a hint to
  contact their admin.

## Dependencies on other owners

`@/platform/access` (`PERMISSIONS`), `@/platform/access/server` (`requirePermission`),
`@/platform/env/server` (`serverEnv`, `server/get-payment-provider.ts` only),
`@/platform/mailer/server` (`renderEmail`, via `server/emails/quota-warning-email.tsx`),
`@/persistence/composition/request-services` (`getRequestServices`),
`@/persistence/use-cases/billing-use-cases` (`BILLING_ERROR`),
`@/persistence/use-cases/errors` (`UseCaseError`), `@/shared/action-result`
(`ActionResult`), `@/shared/ui-primitives` (`Button`). `@react-email/components` (confined
to `server/emails/` by `STRUCTURE.md`'s `vendor-sdk` rule).

## Consumers

`src/app/(app)/dashboard/billing/page.tsx` (seam): `getUsageViewModel`,
`isBillingTestModeActive`, `BillingPageClient`. `src/modules/dashboard-shell/core/nav-items.ts`:
the "Tarif & Nutzung" nav entry (no `permission` filter - every member sees the page, only
its own controls are permission-gated). `src/modules/documents/ui/upload-form.tsx`: the
quota-error message links to `/dashboard/billing` and (for a member without
`billing.manage`) tells them to contact their admin. `src/persistence/schema/workspaces.ts`
(`TIERS`, for the `workspaces.tier` column enum). `src/persistence/schema/billing.ts`
(`PACKAGE_KEYS`/`TIERS`, for `quota_package_purchases`/`workspace_tier_changes`'s enum
columns). `src/persistence/use-cases/billing-use-cases.ts` (`periodKeyFor`,
`evaluateWarningCrossing`, `canPurchasePackages`, `TIER_LIMITS`, `PACKAGES`,
`PaymentProviderError`). `src/persistence/use-cases/documents-use-cases.ts`
(`evaluateQuota`, `Tier`) - the quota pre-check and the authoritative in-transaction
re-check on every document upload. `src/persistence/composition/create-request-services.ts`
(`getPaymentProvider`). `src/persistence/composition/job-handlers.ts`
(`quotaWarningEmailSubject`/`renderQuotaWarningEmail`, `TIER_LIMITS`, `Tier`).

## Tests

`tests/plans.test.ts` (unit, `pnpm test`): table-driven `evaluateQuota` coverage over every
tier and its total/monthly boundaries (P2a), plus `evaluateWarningCrossing` (P3: crosses at
exactly 80%, not just under it, never twice while a marker is set, independent total/monthly
crossings, both at once, a reset marker allows crossing again) and `periodKeyFor`.
`tests/usage-view-model.test.ts` (P3): `buildUsageViewModel`'s free-tier formatting (no
monthly limit at all, not a zero-valued one), a package raising the effective monthly limit
capped by the total limit, purchase-to-ISO-date mapping, and ratio clamping.
`tests/payment-provider.test.ts` (P3): the test adapter completes instantly with
`provider: "test"`; the not-configured adapter always throws `PaymentProviderError`
(`billing_not_configured`). `tests/billing-page-client.test.tsx` (P3, Testing Library +
jsdom): a member sees usage with no controls; an admin sees the tier-change/package-purchase
controls only when `testModeActive`, otherwise the not-configured notice; Free never shows
the package section; Free renders "kein monatliches Limit".

Usage upsert/increment, per-period scoping, purchase/tier-change inserts, and the warning
markers are `src/persistence/tests/billing-repository.db.test.ts`;
`changeTier`/`purchasePackage`/`recordDocumentsCreated`'s warning-crossing/reset behavior
(against typed fakes) is `src/persistence/tests/billing-use-cases.test.ts`; the full
quota-enforcement flow (pre-check, in-transaction re-check, concurrency, and - P3 - the
warning-threshold concurrency race) is `src/persistence/tests/documents-use-cases*.test.ts`
(`src/persistence/README.md`). The full billing flow (upload to the limit -> 402, upgrade in
test mode -> upload works, buy a package -> capacity rises, a warning e-mail actually
reaching Mailpit) against real Postgres and MinIO is
`tests/integration/workflows/billing.integration.test.ts`. End-to-end: an admin sees correct
usage after an upload, changes tier, and buys a package
(`tests/e2e/billing.spec.ts`, tagged `@smoke`); a member sees the read-only view with no
controls (same file, untagged).
