# Billing: tiers, one-off packages, the hard stop, 80% warnings, and test-mode payments

Document type: decision
Lifecycle: active
Owner: src/modules/billing
Scope: The `/dashboard/billing` ("Tarif & Nutzung") UI, admin-only tier changes and
digitization-package purchases, the `PaymentProvider` port and its test-mode adapter, the
80% quota-warning e-mail (outbox pattern), and what a future Stripe adapter needs to
implement
Canonical responsibility: Active source for why payments are built behind a port with no
real provider yet, how "at most once per limit per calendar month" holds even under
concurrency, why a package only ever raises the effective monthly limit and never the total
limit, and the exact rule for rejecting a tier downgrade
Maintenance triggers:
- A tier's price/limits or a package's price/capacity changes
- Stripe (or another real payment provider) is actually integrated
- The warning threshold, its wording, or its "at most once per period" rule changes
- The `BILLING_TEST_MODE` gating or its UI treatment changes
Last verified: 2026-09-19, P3 (billing, quota packages, and warnings)

## Status
Accepted

## Context

decisions/0015-documents-and-quotas.md's "Consequences" named exactly what this phase adds:
the `/dashboard/billing` UI, the test-mode plan-change and package-purchase actions (the
first writer of `quota_package_purchases`), and the 80% warning e-mail job that reads
`QuotaEvaluation.totalRatio`/`monthlyRatio` (already computed by every `evaluateQuota` call
since P2a, just not consumed by anything until now). The architecture brief's product
decision 3 is explicit that no Stripe keys exist yet: billing has to be built behind a port
with a "test mode" adapter, never a real payment integration, and never active in
production.

This phase does not add Stripe, a webhook endpoint, or any real payment processing - see
"What a future Stripe adapter needs to implement" below for exactly what is deliberately
deferred and why.

## Decision

### 1. Tiers and packages: unchanged data, first real consumers

`src/modules/billing/core/plans.ts` (P2a) already held `TIERS`/`TIER_LIMITS`/`PACKAGES` and
the pure `evaluateQuota`; this phase adds no new tier or package, only their first UI and
mutation consumers. For reference, the architecture brief's table:

| tier | price EUR/month | total docs | new docs/month |
|---|---|---|---|
| free | 0 | 20 | none (no monthly limit) |
| starter | 29 | 750 | 100 |
| pro | 79 | 5000 | 500 |
| unlimited | 249 | 200000 | 5000 |

Packages (one-off, current calendar month only, raise the monthly limit, still capped by
the total limit): S (+250 docs, 19 EUR), M (+1000, 59 EUR), L (+5000, 249 EUR). Free cannot
purchase a package (`canPurchasePackages`, product decision 6: no monthly limit to raise).

**Counting semantics** (product decisions 1 and 5, unchanged, now visible in the UI): the
total limit counts documents currently stored (deleting one frees capacity); the monthly
limit counts documents created in the current calendar month, UTC (deleting does not refund
it); a package's capacity expires at the end of the calendar month it was bought in - a
later month needs its own purchase. `/dashboard/billing` states the "never raises the total
limit" rule explicitly in copy (`Billing.packages.description`), not only implicitly via the
numbers, since it is easy for an admin to misread "buy more capacity" as "raise my storage
limit".

### 2. `/dashboard/billing`: everyone sees it, only `billing.manage` changes anything

Gated the same way every other page in `(app)` is (`requireWorkspaceMember`, no `permission`
filter on the nav entry, `src/modules/dashboard-shell/core/nav-items.ts`): any workspace
member reaches the page. `BillingPageClient` (`src/modules/billing/ui/billing-page-client.tsx`)
renders the usage section (current tier, price, both limits as accessible progress bars with
exact numbers - a native `<progress>` element, which browsers and screen readers already
announce correctly, `ui/usage-progress-bar.tsx`) and the purchase list for everyone, and only
renders the tier-change/package-purchase controls when the caller's own `billing.manage`
permission (`src/platform/access`, admin-only, unchanged since decisions/0014) is present -
resolved server-side (`requireWorkspaceMember().permissions`), never a client-side role
check.

**Free has no monthly limit - shown correctly, not as `0`.** `buildUsageViewModel`
(`src/modules/billing/core/usage-view-model.ts`, pure, unit-tested) sets `hasMonthlyLimit:
false`/`monthlyLimit: null`/`effectiveMonthlyLimit: null`/`monthlyRatio: null` for Free;
`UsageProgressBar` renders a "kein monatliches Limit" label instead of a bar whenever `max`
is `null`, never a bar stuck at `0`.

### 3. Tier change: admin-only, rejects a downgrade below the stored count

`billing.changeTier` (`src/persistence/use-cases/billing-use-cases.ts`) is the sole writer
of `workspaces.tier`'s *change* path (the column itself is still owned by
`src/modules/workspaces`, per "Cross-owner transaction sharing" below): it looks up the
workspace, compares the target tier's `totalDocuments` against
`documents.countStored` (the same count `createFromUpload`'s quota check uses), and rejects
with the stable code `downgrade_below_stored_count` whenever the new limit is below the
current count - direction-agnostic on purpose (an upgrade's limit is never lower in
practice, so the same single comparison covers "reject a downgrade" without a separate
branch). The stable code carries no numbers; `TierChangeForm`
(`src/modules/billing/ui/tier-change-form.tsx`) already has both (`storedDocuments` from the
page's own usage view model, `TIER_LIMITS[selectedTier].totalDocuments` from the neutral
`core/plans.ts`) and renders the German message naming them itself
(`Billing.errors.downgrade_below_stored_count`, interpolated) - `ActionResult`'s error
branch stays the stable `{ status: "error", errorCode }` shape every other module's action
uses, never a special "error with a payload" case.

A successful change writes `workspace_tier_changes` (a pure audit ledger, never read by any
quota check - `workspaces.tier` alone is the source of truth for the current tier) and
resets both warning markers for the current period (see "Warnings" below) in the same
transaction as the `workspaces.tier` update.

### 4. Package purchase: admin-only, rejected on Free, capped by the total limit

`billing.purchasePackage` rejects Free with `packages_not_available_on_free` (product
decision 6) before ever touching the payment provider. A successful purchase writes
`quota_package_purchases` (P2a's schema, this phase's first writer) and resets only the
*monthly* warning marker (a package never raises the total limit, so only the monthly ratio
could have meaningfully changed). `PurchasePackageForm`
(`src/modules/billing/ui/purchase-package-form.tsx`) is not rendered at all on Free (the
parent checks `canPurchasePackages(tier)`), and states in copy that capacity is for the
current month only and never raises the total limit.

### 5. The `PaymentProvider` port and its test-mode adapter (product decision 3)

`src/modules/billing/core/payment-provider.ts` (pure, no I/O): the `PaymentProvider`
interface (`changeTier`, `purchasePackage`, each returning `{ provider, providerReference }`),
`createTestPaymentProvider()` (completes instantly, `provider: "test"`,
`providerReference: null` - no state, no network, every call succeeds), and
`createNotConfiguredPaymentProvider()` (every call throws `PaymentProviderError`, a stable
`billing_not_configured` code). `src/modules/billing/server/get-payment-provider.ts`
(`getPaymentProvider()`) is the env-based selector, the same lazy-singleton-by-env shape
`src/platform/mistral/server/get-ai-adapters.ts` already uses for `AI_PROVIDER`: bound once
by the composition root (`create-request-services.ts`), never selected by the use case
itself.

**`BILLING_TEST_MODE`** (`src/platform/env`, optional boolean, default `false`, `.env.example`
sets it `true` for local dev, `docker/compose.test.yml` sets it `true` for every test): when
`true`, `getPaymentProvider()` binds the test adapter and `isBillingTestModeActive()` (also
`server/get-payment-provider.ts`) returns `true`; when not `true` (including every
production deploy, since no real adapter exists), it binds the not-configured adapter and
`isBillingTestModeActive()` returns `false`.

**Two independent refusal layers when test mode is off**, satisfying "even if called
directly": `BillingPageClient` never renders the tier-change/package-purchase controls at
all when `!testModeActive` (a clear German notice plus a contact hint instead,
`Billing.notConfigured.*`) - this is the UI-level guard. But the actual, unconditional
guarantee is one layer deeper: `changeTierAction`/`purchasePackageAction`
(`src/modules/billing/actions.ts`) call the same use cases regardless of what the UI
decided to render, and `billing-use-cases.ts`'s `changeTier`/`purchasePackage` call
`deps.paymentProvider.changeTier`/`.purchasePackage` unconditionally - when the bound
provider is the not-configured one, this throws `PaymentProviderError`, translated into
`UseCaseError("billing_not_configured")` (`withPaymentProvider`, a small helper wrapping
both calls). Calling either Server Action directly (bypassing the UI entirely, e.g. from a
script or a modified client) reaches the identical refusal - there is no code path that
skips the provider call.

**"Testmodus" badge.** Whenever `testModeActive` is `true`, `TierChangeForm` and
`PurchasePackageForm` both render a small, unmissable "Testmodus" badge next to their own
label/heading (`Billing.testModeBadge`) - every payment-ish control carries it, not just a
single page-level banner, so a screenshot of any one control alone still makes it obvious
this is not a real charge.

### 6. Warnings: 80% threshold, at most once per limit per calendar month, resettable

`evaluateWarningCrossing` (`src/modules/billing/core/plans.ts`, pure): given the post-add
`totalRatio`/`monthlyRatio` (the same ones `evaluateQuota` already returns) and the current
period's `warnedTotalAt`/`warnedMonthlyAt` markers (`null` until a warning has actually been
sent this period), returns which limit(s), if any, just crossed 80% for the first time this
period. A non-`null` marker suppresses a further crossing unconditionally, however high the
ratio climbs afterward - this is the entire "at most once per limit per calendar month"
guarantee, and it is a pure function, unit-tested directly (including "never twice" and
"both at once").

**Wired into the same transaction as the usage increment, for correctness under
concurrency.** `billing-use-cases.ts`'s `recordDocumentsCreated` (called by
`documents-use-cases.ts`'s `createFromUpload`, inside the SAME transaction that holds the
workspace row lock - decisions/0015's "Cross-owner transaction sharing") increments
`workspace_monthly_usage.documentsCreated`, evaluates the crossing against the row it just
got back (which already reflects this exact increment), and - if crossed - sets the marker
(`BillingRepository.markWarned`) and enqueues a `send-quota-warning` job
(`repos.jobs.enqueue`, the outbox pattern - a slow or failing SMTP send must never block the
upload response) all before the transaction commits. Two concurrent uploads racing past the
threshold are serialized by the SAME row lock `createFromUpload`'s quota re-check already
holds (decisions/0015): whichever commits first sets the marker; the second reads it already
set and never enqueues a second warning -
`src/persistence/tests/documents-use-cases-concurrency.db.test.ts` proves this against real
Postgres, not only asserted against a fake.

**Reset on upgrade or purchase.** `changeTier` clears both markers for the current period
(an upgrade can move either ratio back under 80%); `purchasePackage` clears only the monthly
marker (a package cannot affect the total ratio). Both go through
`BillingRepository.clearWarnings`, a plain `UPDATE` that is a safe no-op when the period has
no usage row yet (nothing to clear).

**The e-mail.** `send-quota-warning`'s handler (`src/persistence/composition/job-handlers.ts`,
composition rank, mirroring `send-assignment-email`'s "handlers registered where they
belong" shape) re-reads everything at send time rather than trusting the job's payload
numbers - the workspace's tier, stored count, and usage may have moved on since enqueueing
(another document created or deleted, a package bought, a tier change) before this job
actually runs. It addresses the workspace's current admin
(`workspaces.getWorkspaceWithAdminContact`, a new read-only method: `workspace.findById`
plus `workspaceMember.listByWorkspace` filtered to the one admin row - the partial unique
index guarantees exactly one), and no-ops if a tier change since enqueueing removed the
monthly limit entirely (Free has none to warn about). The template
(`src/modules/billing/server/emails/quota-warning-email.tsx`, React Email, German) names the
workspace, the limit that was approached, the current numbers, and links to
`/dashboard/billing`.

### 7. Cross-owner transaction sharing: `workspace.updateTier`, `billing.insertTierChange`

`changeTier` writes two different owners' tables in one transaction, the identical shape
decisions/0015 already established for `documents` calling `billing.recordDocumentsCreated`
and decisions/0016 for `workspaces-use-cases.ts`'s `removeMember` calling
`repos.document.clearAssigneeForUser`: `billing-use-cases.ts`'s `changeTier` orchestrates
*when* `repos.workspace.updateTier` (a new method on `src/modules/workspaces`'s own
`WorkspaceRepository`, implemented only in that owner's Drizzle repository file) and
`repos.billing.insertTierChange` (this owner's own repository) both run, inside its own
`uow.transaction`, without `src/modules/billing` ever writing the `workspaces` table
directly - the write still only ever happens inside `WorkspaceRepository`'s own
implementation. The same narrow pattern, once more, in yet another direction.

### 8. The hard-stop UX (P2a's upload-error message, checked and completed here)

`ui/upload-form.tsx`'s quota-error message (P2a) already named which limit was hit and
linked to `/dashboard/billing`; this phase completes it for a member who cannot act on that
link. `UploadForm` now takes a `canManageBilling` prop (`ScanPage` passes
`access.permissions.includes(PERMISSIONS.billingManage)`): a member without that permission
sees an additional sentence telling them to contact their admin
(`Scan.errors.quotaMemberHint`) alongside the same "Zum Tarif" link (still shown - a member
CAN see the read-only billing page, just not act on it).

### 9. What a future Stripe adapter needs to implement (why not now)

No Stripe (or any other payment provider) account or API key exists for this product yet
(architecture brief's product decision 3) - building a real integration now would mean
inventing test fixtures for a provider nobody has configured, and shipping code that cannot
be exercised end to end until a real account exists. The `PaymentProvider` port is deliberately
narrow so a future adapter is a contained, well-understood piece of work:

- **Checkout.** `changeTier`/`purchasePackage` currently return synchronously; a real
  provider is asynchronous (the admin is redirected to a hosted checkout page and comes
  back later) - the port's two methods would need to become "start a checkout, return a
  redirect URL" instead of "complete and return a result", and the actual tier
  change/purchase-row insert would move from this use case into the webhook handler below
  (money changing hands is the trustworthy signal, not the admin clicking a button).
- **Webhook signature verification.** Stripe signs every webhook payload; a future
  `src/platform/stripe` (or similar) owner would hold the webhook secret (via
  `src/platform/env`, following the same `env-access`-confined pattern every other
  credential in this repository already uses) and verify the signature before trusting any
  event body at all - never process an unverified payload.
- **Idempotent event handling, keyed by event id.** Stripe redelivers webhooks; the handler
  must record which event ids it has already processed (a new table, or a unique constraint
  on an `stripe_event_id` column somewhere in the billing schema) and no-op a duplicate
  delivery, not double-apply a tier change or double-insert a purchase.
- **Subscription state as the source of truth for the tier.** Once Stripe exists, a
  workspace's tier should be derived from its Stripe subscription's current state (plan,
  status: active/past_due/canceled), not decided client-side by an admin clicking a button -
  `changeTier`'s current shape (an admin-initiated, immediately-applied change) is
  specifically the test-mode simplification a real integration replaces, not a design this
  phase intends to keep once Stripe exists.
- **`provider: "stripe"`** is already a valid value in both `quota_package_purchases` and
  `workspace_tier_changes` (this phase's own schema addition) - a real adapter needs no
  migration to start writing it, only the adapter itself and the webhook plumbing above.

## Consequences

- Positive: the "at most once per limit per calendar month" warning guarantee is correct
  under concurrency because it is proved against real Postgres
  (`documents-use-cases-concurrency.db.test.ts`), not only asserted against a fake - the
  marker check and the marker write happen inside the identical row-locked transaction the
  quota check itself already depends on.
- Positive: the `PaymentProvider` port's two-refusal-layer design (UI hides the controls,
  the use case refuses unconditionally regardless) means a bug in the UI's own test-mode
  check can never accidentally let a tier change or purchase through outside test mode - the
  use case is the actual guarantee, the UI is only ever a convenience.
- Positive: `evaluateWarningCrossing`'s reset-on-upgrade/purchase behavior means an admin who
  fixes their capacity problem stops receiving stale warnings immediately, and a later
  crossing (e.g. growth after an upgrade) still warns again - the marker is not a permanent
  "already told them once" flag, only a per-period one.
- Negative: `changeTier`'s "an admin clicks a button and the tier changes instantly" shape is
  explicitly a test-mode simplification that a real Stripe integration would restructure
  significantly (see "What a future Stripe adapter needs to implement" above) - this is
  accepted scope for the MVP, not a design intended to survive unchanged once Stripe lands.
- Negative: the warning e-mail's numbers can be stale by the time an admin reads it (the
  handler re-reads at send time, but "send time" can still be seconds to minutes after the
  crossing, per the job queue's own triggers/backoff) - acceptable, since the e-mail's job is
  "notice you are close", not "report an exact snapshot".
- Implementation status: **implemented**. `src/modules/billing`'s
  `core/payment-provider.ts`/`core/usage-view-model.ts`, `server/get-payment-provider.ts`,
  `server/read-models.ts`, `server/emails/quota-warning-email.tsx`, `actions.ts`, `client.ts`,
  and every `ui/*.tsx` file; the `workspace_tier_changes` schema addition and
  `BillingRepository`'s five new methods; `WorkspaceRepository.updateTier`;
  `billing-use-cases.ts`'s `changeTier`/`purchasePackage`/the extended
  `recordDocumentsCreated`; `workspaces-use-cases.ts`'s `getWorkspaceWithAdminContact`;
  `JOB_KINDS.sendQuotaWarning` and its composition-root handler; `/dashboard/billing`; the
  nav entry; the completed hard-stop copy in `src/modules/documents`; and unit/`.db.test.ts`/
  integration/e2e coverage all land in this phase. A real Stripe adapter is explicitly out of
  scope (see "What a future Stripe adapter needs to implement").

## Supersedes / Superseded By
- None
