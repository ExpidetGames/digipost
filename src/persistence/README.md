# persistence

Document type: reference
Lifecycle: active
Owner: persistence (shared layer, one owner area per schema file)
Scope: Schema, migrations, the DB client, repositories, the Unit of Work, and the
composition root
Canonical responsibility: Active source for this layer's structure, its layering
rules, the role/grant model, and the migration workflow
Maintenance triggers:
- A new owner area's schema/repository/use-case lands (add its row to the schema
  ownership table below, its slot to `Repositories`)
- `src/persistence/schema/**` changes (the migration baseline note may need updating)
- The role/grant model changes (`src/persistence/sql/grants/grants.sql`)
Last verified: 2026-10-22, decisions/0075-email-intake.md: new owner area `mail-intake`
(`schema/mail-intake.ts`, `repositories/{contracts,drizzle}/mail-intake-repository.ts` as
`Repositories.mailIntake`, `use-cases/mail-intake-use-cases.ts`, wired in
`composition/create-request-services.ts` with `getInboundMailProvider()`/`getInboundEmailDomain()`
and the already-built `documents`, plus two handlers in `composition/job-handlers.ts`),
migration `0023_round_junta.sql`. No grants change: `grants.sql`'s default privileges already
cover new tables for `app_runtime`; the webhook uses the runtime connection like the cron
routes, not `app_public`. `findSettingsByToken` is the one deliberately unscoped read (the
token is the routing key). Previously 2026-10-03, decisions/0070-several-workspaces-per-user.md:
`workspace_members.user_id` lost its unique constraint (a user may belong to several
workspaces); a composite unique on `(workspace_id, user_id)` and a plain index on `user_id`
replaced it, migration `0021_glamorous_epoch.sql`. `WorkspaceMemberRepository.findByUserId`
became `listByUserIdWithWorkspace`/`findByWorkspaceAndUser`, and
`workspaces-use-cases.ts` gained `listMembershipsForUser`/`getMembershipInWorkspace`.
Previously, 2026-10-02, decisions/0066-abschluss-check-and-export.md: new owner area
`closing` (`src/modules/closing`) with `use-cases/closing-use-cases.ts` and NO table, no
`Repositories` slot and no `UnitOfWork` - it only reads, through period-scoped methods added
to the repositories that already own those tables (`DocumentRepository.countsForPeriod`/
`listForPeriod`, `TransactionRepository.countsForPeriod`/`listForPeriod`,
`DocumentTransactionRepository.countSuggestedForPeriod`).
`repositories/drizzle/documents-repository.ts` now exports `documentEffectiveDate`, the one
shared `coalesce` that decides which day a document belongs to, used by both the inbox's
ordering and the Abschluss's period scoping, plus `documentTotalAmountCents`/`documentCurrency`
(a platform report's amount is the sum of its own settlement lines). All three are written as
explicit `documents.<column>` SQL text, so `accounts-repository.ts`'s `listForPeriod` can read
a LINKED document's date and amount with the very same expressions from inside its joined
query - both `listForPeriod`s return the confirmed counterparts themselves, which is what lets
the export cross-reference its sheets.
Previously last verified 2026-09-23, decisions/0063-no-category-no-assignment-no-routing.md: document
category, document assignment, and routing are all removed from this layer. `schema/documents.ts`
no longer has a `categories` table or `documents.category_id`/`documents.category_source`
columns; `documents.assignee_user_id` is gone too. `schema/category-routes.ts` and its
`category_routes` table are deleted. `repositories/contracts/documents-repository.ts` /
`repositories/drizzle/documents-repository.ts` lost `CategoryRepository` and
`DocumentRepository`'s `updateCategory`/`updateAssignee`/`clearAssigneeForUser`.
`repositories/contracts/category-routes-repository.ts` /
`repositories/drizzle/category-routes-repository.ts` (owner `src/modules/workspaces`) are
deleted outright, along with `Repositories.category`/`.categoryRoute` and
`tests/support/fake-category-routes-repositories.ts`. Previously, 2026-09-20, F5 (hardening,
decisions/0027-hardening-and-deletion.md):
`WorkspaceRepository` gained `delete(id)` - a single `DELETE FROM workspaces` that cascades
across every workspace-owned table (verified against the full schema, see that ADR's
"Cascade verification" section - every table here already had `onDelete: "cascade"` on its
`workspace_id` foreign key, so this needed no schema change of its own).
`DocumentRepository` gained `listIntakeRejectedBefore(cutoff)`, the retention cron's
deliberately cross-workspace read. `accounts.ts` gained the partial unique index noted in
its own table row below (migration `0016_uneven_bulldozer.sql`, the first schema change
this phase needed). Previously, F3b (decisions/0025-payment-matching-wiring.md): added
`schema/payments.ts` (`document_transactions`/`payment_aliases`/`payment_rejections`/
`payment_no_document_rules`, owner `src/modules/payments`, exported last of all from
`schema/index.ts` since it references `accounts.ts`/`contacts.ts`/`documents.ts`),
`documents.payment_status`/`paid_at`, `transactions.no_document_needed`,
`repositories/{contracts,drizzle}/payments-repository.ts`
(`DocumentTransactionRepository`/`PaymentAliasRepository`/`PaymentRejectionRepository`/
`PaymentNoDocumentRuleRepository`), `Repositories.documentTransaction`/`.paymentAlias`/
`.paymentRejection`/`.paymentNoDocumentRule`, and `use-cases/payments-use-cases.ts`
(`PaymentsUseCases.runMatching` and every decision action). `TransactionRepository` gained
`findById`/`listForMatching`/`listUnmatched`/`markNoDocumentNeeded`; `DocumentRepository`
gained `updatePaymentStatus`/`listInvoiceCandidates`/`findPaymentStatusByInvoiceNumber`.
`use-cases/documents-use-cases.ts`/`accounts-use-cases.ts` each gained one new
`@/platform/jobs` enqueue point (`JOB_KINDS.matchPayments`) - after `markDone` for an
invoice-shaped document, and after a bank import inserts at least one new transaction.
`composition/job-handlers.ts`/`create-request-services.ts` wire `payments` in alongside
`documents`/`billing`/`workspaces`/`accounts`.
Previously, F2 (decisions/0024-accounts-and-transactions.md): added
`schema/accounts.ts` (`accounts`/`transactions`/`import_batches`),
`repositories/{contracts,drizzle}/accounts-repository.ts`
(`AccountRepository`/`TransactionRepository`/`ImportBatchRepository`), `Repositories.account`/
`.transaction`/`.importBatch`, and `use-cases/accounts-use-cases.ts`
(`AccountsUseCases.importFromDocument` and friends). `use-cases/documents-use-cases.ts` gained
three `@/platform/jobs` enqueue points (the new `import-account-transactions` job kind) at the
camt.053 branch, the tabular-known-fingerprint branch, and `confirmIntake`, all conditioned on
the confirmed `documentKind` being `bank_statement`. `composition/job-handlers.ts`/
`create-request-services.ts` wire `accounts` in alongside `documents`/`billing`/`workspaces`.
Previously, F1b (decisions/0022-intake-wiring.md): added `schema/intake-fingerprints.ts`
(`intake_source_fingerprints`), `documents`'s `file_hash`/`kind`/`intake_status`/
`intake_result` columns, `repositories/{contracts,drizzle}/intake-fingerprints-repository.ts`,
and `Repositories.intakeFingerprint`. `use-cases/documents-use-cases.ts` gained
`confirmIntake`/`rejectIntake`/`listIntakeFingerprints`/`resetIntakeFingerprint`/
`getPossibleDuplicateInvoice`, `createFromUpload`'s signature changed from `pdfBytes` to
`bytes`/`mimeType`/`extension`/`fileHash` (structured files, not just PDFs, and the
exact-duplicate check), and `processDocument` now branches into three non-OCR paths before
this note's prior verification, C1 (contacts data model and domain, decisions/0019-contacts.md):
added `schema/contacts.ts` (`contacts`/`document_contacts`/`contact_change_proposals`), the
`workspaces.company_*` columns, `repositories/{contracts,drizzle}/contacts-repository.ts`,
`use-cases/contacts-use-cases.ts`, and `workspaces-use-cases.ts`'s `getCompanyProfile`/
`updateCompanyProfile`. P7 (real-API defect fixes): added structured failure logging and
Sentry reporting to `use-cases/jobs-use-cases.ts` (D2/D3) plus its first dedicated unit test
(`tests/jobs-use-cases.test.ts`); added a full-text-search-over-an-invoice-table DB test to
`tests/documents-repository.db.test.ts` (D1). P6 review: corrected this section's stale `Repositories` field
list (C3 doc-drift fix - it now has nine fields, not three); `DocumentRepository.countByWorkspace`
is now a real SQL `count(*)` instead of counting rows in JS (A7);
`quota_package_purchases.purchasedByUserId`/`workspace_tier_changes.changedByUserId`/
`workspace_invitations.invitedByUserId` are now nullable with `onDelete: "set null"`,
matching `documents.uploadedByUserId` (A9). P3 (billing, quota packages, and warnings): added
`billing.ts`'s `workspace_tier_changes` table, `WorkspaceRepository.updateTier`, and
`BillingRepository`'s purchase/tier-change/warning-marker methods
(decisions/0017-billing-tiers-and-packages.md)

## Purpose

This is WEBAPP_TEMPLATE_SPEC.md §5's persistence layer, built directly against the
**target** role model (decisions/0004-three-database-roles.md): no RLS, no
`asUser`/`asPublic` role switching, no `withUser`. Two request-time roles
(`app_runtime`, `app_public`) and one owner role (`app_owner`, DDL only) cover every
environment in WEBAPP_TEMPLATE_SPEC.md §5.9's provider matrix.

## 1. Layers

```
schema/          one file per owner area, barrel-merged in schema/index.ts
migrations/       drizzle-kit generated migrations (never hand-written - §4)
sql/              custom SQL sources for what Drizzle cannot express (grants, ...)
foundation/       the DB client (getDb/getPublicDb), DbExecutor/DbTx, neutral error mapping
repositories/
  contracts/      Repositories type + UnitOfWork interface - the only import
                  surface use cases may use from this layer
  drizzle/        the Drizzle implementation of both (repositories + Unit of Work)
use-cases/        errors.ts (UseCaseError), workspaces-use-cases.ts (P1: the tenancy
                  owner area's use case, onboarding/membership/invitations),
                  documents-use-cases.ts / billing-use-cases.ts
                  (P2a: upload, quota enforcement, search/filter/detail/delete;
                  P2b added processDocument/retryProcessing),
                  jobs-use-cases.ts (P2b: the domain-free job runner, owner
                  src/platform/jobs)
composition/      create-request-services.ts (the composition root) +
                  request-services.ts (the one `cache(createRequestServices)`) +
                  public-services.ts (the narrow seam for app_public) +
                  auth-database.ts (the narrow entry for Better Auth's adapter, T3)
tests/            unit tests for this layer itself (db-errors.test.ts),
                  *.db.test.ts against real Postgres (workspaces-repository, roles),
                  and support/ fakes for owner-area unit tests
```

A file imports its own rank or a lower one, never a higher one:
`foundation` < `repositories` < `use-cases` < `composition`. Everything except
`composition/request-services.ts`, `composition/create-request-services.ts`,
`composition/public-services.ts`, `composition/auth-database.ts` (a narrow entry,
importable only by `src/platform/auth/server/auth.ts`, see below) and
`repositories/contracts/**` is internal to this layer.

## 2. Entry seams

Application code has exactly one door in for authenticated/app paths:

```ts
import { getRequestServices } from "@/persistence/composition/request-services";
```

and one narrow door for unauthenticated public paths:

```ts
import { getPublicServices } from "@/persistence/composition/public-services";
```

Both are memoized per request (`react`'s `cache()`); the whole persistence graph
for that seam is built at most once per request. Nothing else under `src/persistence/`
should be imported from `src/app/**`, `src/modules/**`, `src/platform/**` or `src/shared/**` - the
one documented exception (a **narrow entry**, WEBAPP_TEMPLATE_SPEC.md §5.1) is
`composition/auth-database.ts` (T3): Better Auth's Drizzle adapter needs the
Drizzle instance and the raw `auth` schema object directly for its own adapter,
not a use case or repository.

```structure narrow-entry
target   src/persistence/composition/auth-database.ts
owner    persistence
importer src/platform/auth/server/auth.ts
reason   Better Auth's Drizzle adapter needs the Drizzle instance and the auth
         schema directly for its own adapter; the rest of the persistence graph
         (use cases, the Unit of Work) does not belong in auth initialization.
```

## 3. Roles and grants (decisions/0004-three-database-roles.md, the target model)

| Role | Env var | Rights | Reached from this layer via |
|---|---|---|---|
| `app_owner` | `DATABASE_URL_MIGRATE` | DDL, owns all objects | `scripts/db/*`, `drizzle.config.ts` only - never through this layer's TypeScript code |
| `app_runtime` | `DATABASE_URL` | `usage` on `public`/`auth`, DML on every table, `usage` on sequences, no DDL | `getDb()`, the whole application |
| `app_public` | `DATABASE_URL_PUBLIC` | exactly what an unauthenticated public path needs (nothing yet) | `getPublicDb()`, only from `src/persistence/foundation/**` and `src/persistence/composition/public-services.ts` |

Grants live in `src/persistence/sql/grants/grants.sql` (turned into
`src/persistence/migrations/0001_grants.sql` by `pnpm db:generate:custom grants`,
WEBAPP_TEMPLATE_SPEC.md §5.7): existing-table grants plus `alter default
privileges` (scoped to whichever role runs the migration - see that file's own
header comment for why no environment needs a different grants file) so a future
table an owner area adds does not need its own grants migration for the common
case. The grants migration's first statement fails loudly (`raise exception`) if
`app_runtime`/`app_public` do not exist yet - run `pnpm db:bootstrap`
(`scripts/db/bootstrap-roles.mjs`) first in any new environment.
`src/persistence/tests/roles.db.test.ts` proves the boundary: `app_runtime` has DML but
no DDL, `app_public` can read nothing yet.

`src/persistence/foundation/client.ts` is the only module that knows the driver:
`getDb()` (the runtime connection) and `getPublicDb()` (the public connection,
throws if `DATABASE_URL_PUBLIC` is unset - no project needs it until it has an
unauthenticated public path). Both memoize their pool on `globalThis` so Next's
dev-server HMR does not leak sockets.

## 4. Schema, migrations, and the workflow

**Ownership.** One schema file per owner area under `src/persistence/schema/`,
barrel-merged in `schema/index.ts` (which `drizzle.config.ts` points at). Each file
names its owner and the "only the owner writes" rule in its header comment
(WEBAPP_TEMPLATE_SPEC.md §5.7) - a review rule, not something the type system
enforces.

| Schema file | Postgres schema | Tables | Owner |
|---|---|---|---|
| `auth.ts` | `auth` | `user`, `session`, `account`, `verification`, `rateLimit` | `src/platform/auth` (Better Auth's Drizzle adapter, decisions/0005, is the only writer, via `composition/auth-database.ts`, T3) |
| `workspaces.ts` | `public` | `workspaces`, `workspace_members`, `workspace_invitations` | `src/modules/workspaces` (decisions/0014-workspaces-and-access.md) - the tenancy vertical slice: workspace creation, membership, and invitations. `workspaces` also carries the `company_*` columns (decisions/0019-contacts.md's own-company exclusion), added by `src/modules/contacts`'s phase but still owned/written by `src/modules/workspaces` |
| `documents.ts` | `public` | `documents` | `src/modules/documents` (decisions/0015-documents-and-quotas.md) - upload, storage, search. No category or assignee columns (decisions/0063-no-category-no-assignment-no-routing.md removed both). `documents` also carries `file_hash`/`kind`/`intake_status`/`intake_result` (decisions/0022-intake-wiring.md, F1b: the universal intake recognizer's own taxonomy and confirmation state) |
| `intake-fingerprints.ts` | `public` | `intake_source_fingerprints` | `src/modules/documents` (decisions/0022-intake-wiring.md, F1b) - a workspace's confirmed tabular source layouts (column mapping, amount-sign decision), keyed by `TabularSample.fingerprint` (`@/modules/intake`); kept in its own schema file to avoid a schema-file import cycle |
| `billing.ts` | `public` | `workspace_monthly_usage`, `quota_package_purchases`, `workspace_tier_changes` | `src/modules/billing` (decisions/0015-documents-and-quotas.md, decisions/0017-billing-tiers-and-packages.md) - quota usage tracking, one-off package purchases, and the tier-change audit ledger |
| `jobs.ts` | `public` | `jobs` | `src/platform/jobs` (decisions/0016-processing-pipeline-and-ai.md) - the async job queue: claim/lease/backoff, domain-free |
| `contacts.ts` | `public` | `contacts`, `document_contacts`, `contact_change_proposals` | `src/modules/contacts` (decisions/0019-contacts.md) - "Firmenkontakte" extracted from documents: matching, verification/fill-or-propose semantics, and the document-to-contact link with its `role` column |
| `accounts.ts` | `public` | `accounts`, `transactions`, `import_batches`, `settlement_lines` | `src/modules/accounts` (decisions/0024-accounts-and-transactions.md, F2; decisions/0026-platform-settlements.md, F4) - bank/clearing accounts, the transactions imported from a confirmed intake document, one import batch per document, and (F4) a confirmed settlement report's own revenue/fee/refund/payout lines; references both `workspaces.ts` and `documents.ts`. F5 (decisions/0027-hardening-and-deletion.md) added a partial unique index, `accounts_workspace_platform_clearing_key` (`workspace_id, platform) where type = 'clearing'` |
| `mail-intake.ts` | `public` | `mail_intake_settings`, `mail_intake_allowed_senders`, `inbound_emails` | `src/modules/mail-intake` (decisions/0075-email-intake.md) - the per-workspace inbound address (lazily created, token unique across workspaces), the sender allowlist, and the received-mail log with per-attachment results (unique on `(provider_email_id, workspace_id)`); all cascade from `workspaces.id`, migration `0023_round_junta.sql` |
| `payments.ts` | `public` | `document_transactions`, `payment_aliases`, `payment_rejections`, `payment_no_document_rules` | `src/modules/payments` (decisions/0025-payment-matching-wiring.md, F3b) - every matching decision (suggested/confirmed/rejected) between one document and one transaction, learned counterparty-name aliases, permanent rejection records, and "kein Beleg nötig, für diese Gegenpartei immer" standing rules; references `accounts.ts`/`contacts.ts`/`documents.ts`/`workspaces.ts`, exported last of all from `schema/index.ts` |

**Workflow:**

- **Schema first, then generate.** Edit `src/persistence/schema/<owner>.ts`, then
  `pnpm db:generate` (`drizzle-kit generate`). Migrations are never hand-written
  or AI-authored.
- **Custom SQL** (grants, functions, triggers Drizzle cannot express): source at
  `src/persistence/sql/<name>/<name>.sql`, then `pnpm db:generate:custom <name>`
  (`scripts/db/generate-custom.mjs`: runs `drizzle-kit generate --custom`, copies
  the source into the generated file).
- **Apply:** `pnpm db:migrate` (`scripts/db/migrate.mjs`, `drizzle-orm/node-postgres`'s
  own migrator): connects as `DATABASE_URL_MIGRATE`, holds `pg_advisory_lock` for
  the run, refuses a non-local host unless `--remote` (plus `--expect-host=<host>`
  in CI, or an interactive confirmation locally). `--status` lists
  applied/pending without changing anything.
- **Bootstrap roles:** `pnpm db:bootstrap` (`scripts/db/bootstrap-roles.mjs`)
  creates `app_runtime`/`app_public` idempotently, with the password already
  embedded in `DATABASE_URL`/`DATABASE_URL_PUBLIC` - never generated or printed.
  Required once per new environment before the first `pnpm db:migrate` (the grants
  migration checks the roles exist and aborts otherwise).
- **Seed:** `pnpm db:seed` (`scripts/db/seed.mjs`), local/test-stack only (no
  override flag). Applies `src/persistence/seed.sql` if it exists; this template ships
  with no reference data yet, so it is currently a documented no-op.
- **Reset:** `pnpm db:reset` (`scripts/db/reset.mjs`), local only: drops
  `public`/`auth`/`drizzle` (the migration-tracking schema), then runs
  `db:migrate` and `db:seed`.
- **Baseline (`src/persistence/migrations/0000_faithful_maggott.sql`).** Generated
  directly from `src/persistence/schema/index.ts` against an empty migration history -
  this template's very first migration, not a recorded/introspected baseline over
  pre-existing hand-written SQL (unlike a project migrating an existing schema onto
  this layer, WEBAPP_TEMPLATE_SPEC.md §5.7's "future schema changes" note).

## 5. Repositories and the Unit of Work

`repositories/contracts/index.ts` - `Repositories` (one field per owner area with a
repository, eighteen today: `system` - the one field with no owner and no table,
`repositories/contracts/system-repository.ts`'s header comment explains why -
`workspace`/`workspaceMember`/`workspaceInvitation` (`src/modules/workspaces`),
`document` (`src/modules/documents` - no `category`/`categoryRoute` field any more,
decisions/0063-no-category-no-assignment-no-routing.md removed both), `billing`
(`src/modules/billing`), `jobs` (`src/platform/jobs`),
`contact`/`documentContact`/`contactProposal` (`src/modules/contacts`,
decisions/0019-contacts.md), `intakeFingerprint` (`src/modules/documents`,
decisions/0022-intake-wiring.md, F1b), `account`/`transaction`/`importBatch`
(`src/modules/accounts`, decisions/0024-accounts-and-transactions.md, F2), and
`documentTransaction`/`paymentAlias`/`paymentRejection`/`paymentNoDocumentRule`
(`src/modules/payments`, decisions/0025-payment-matching-wiring.md, F3b)) and the
`UnitOfWork` interface: one method,
`transaction(work)`, since this template runs the target role model directly (no
role-switch machinery to hide behind extra methods, contrast with a project still
migrating off an RLS-based transition model). `repositories/drizzle/create-repositories.ts`
bundles every Drizzle repository; `repositories/drizzle/unit-of-work.ts` implements
`UnitOfWork` as a thin wrapper around `db.transaction`.

`repositories/contracts/workspaces-repository.ts` /
`repositories/drizzle/workspaces-repository.ts` - three repositories, one owner
(`src/modules/workspaces`, WEBAPP_TEMPLATE_SPEC.md §14 "Mandanten"): `WorkspaceRepository`
(`create`, `findById`, `updateTier` - P3, decisions/0017-billing-tiers-and-packages.md,
called only from `billing-use-cases.ts`'s `changeTier`, a legitimate cross-owner call since
it is a single-owner write orchestrated by another owner area's use case), `WorkspaceMemberRepository`
(`listByUserIdWithWorkspace` joined with each membership's own workspace row, oldest first -
decisions/0070-several-workspaces-per-user.md; `findByWorkspaceAndUser`, `findById`, `create`,
`listByWorkspace` joined with the member's email/name, `deleteById`), and
`WorkspaceInvitationRepository` (`countPending`, `deletePendingByEmail`, `create`,
`findByTokenHash`, `findByTokenHashWithDetails` joined with the workspace name and
inviter email, `listPendingByWorkspace`, `deleteById`, `markAccepted`). Every
workspace-scoped method takes and filters on `workspaceId` explicitly, even though the use
case will already have resolved it from the caller's own session membership -
authorization is then not only convention.
`src/persistence/tests/workspaces-repository.db.test.ts` proves the scoping on every method,
the one-admin-per-workspace unique constraint, the
one-pending-invitation-per-email constraint, invitation lookup by token hash, and that
`uow.transaction` rolls back every write when its callback throws;
`src/persistence/tests/workspaces-multi-membership.db.test.ts` proves
decisions/0070-several-workspaces-per-user.md's own pair (several memberships per user now
insert, the same user in the same workspace twice still does not) and the oldest-first
ordering `resolveAccess`'s fallback depends on. `WorkspaceRepository`
also has `lockForUpdate` (P2a, decisions/0015-documents-and-quotas.md): a `select ... for
update` read-only lock `documents-use-cases.ts`'s `createFromUpload` uses to serialize
concurrent uploads against the same workspace's quota - a legitimate cross-owner call since
it is a read, not a write (the "only the owner writes" rule concerns writes).

`repositories/contracts/system-repository.ts` / `repositories/drizzle/system-repository.ts`
(T5) - `ping()`, a bare `select 1` against the runtime connection. No schema, no
owner, no `ownerId`: its only purpose is letting `GET /api/health` reach
`app_runtime` through this same composition root instead of calling
`src/persistence/foundation/client.ts` directly.

`repositories/contracts/documents-repository.ts` / `repositories/drizzle/documents-repository.ts`
(P2a) - one repository, one owner (`src/modules/documents`): `DocumentRepository`
(`create` with a pre-generated id - the storage key must be known before the row exists,
`countByWorkspace`, `findById`/`list` joined with the uploader's display fields,
`deleteById` returning the row for storage-object
compensation). No category or assignee any more
(decisions/0063-no-category-no-assignment-no-routing.md removed both, along with
`CategoryRepository`). `list`'s search
condition and ranking use raw `sql` fragments for `websearch_to_tsquery`/`ts_rank` (drizzle's
query builder has no native tsquery/rank helpers).
`src/persistence/tests/documents-repository.db.test.ts` proves workspace scoping on every
method and German-stemming full-text search.

`repositories/contracts/billing-repository.ts` / `repositories/drizzle/billing-repository.ts`
(P2a; P3, decisions/0017-billing-tiers-and-packages.md, extended it) - one repository, one
owner (`src/modules/billing`), covering all three of its tables: `findMonthlyUsage`,
`incrementDocumentsCreated` (an upsert), `sumExtraDocumentsForPeriod`,
`listPurchasesForPeriod`, `insertPurchase`, `insertTierChange`, `markWarned`/`clearWarnings`
(the 80% warning markers, "at most once per limit per calendar month").
`src/persistence/tests/billing-repository.db.test.ts` proves the upsert/increment,
per-period scoping, purchase/tier-change inserts, and the warning markers.

`repositories/contracts/jobs-repository.ts` / `repositories/drizzle/jobs-repository.ts` (P2b,
owner `src/platform/jobs`) - `enqueue`, `claimDue` (`select ... for update skip locked` inside
the caller's own transaction), `markSucceeded`, `markFailed`, `reschedule`, `findById`.
`src/persistence/tests/jobs-repository.db.test.ts` proves two concurrent claimers never
receive the same job, an expired lease is reclaimable, and `enqueue` rolls back with its
caller's transaction.

`repositories/contracts/contacts-repository.ts` / `repositories/drizzle/contacts-repository.ts`
(C1, owner `src/modules/contacts`, decisions/0019-contacts.md) - three repositories:
`ContactRepository` (`create`, `findById`, `list` (paginated, filterable), `listAllForWorkspace`
(unpaginated, the matching candidate pool), `updateFields`, `deleteById`),
`DocumentContactRepository` (`link` (idempotent via `onConflictDoNothing`), `unlink`,
`listForDocument`, `listForContact`, `moveContactLinks` for `mergeContacts`), and
`ContactProposalRepository` (`create`, `findById`, `listForWorkspace`, `listForContact`,
`decide` (scoped to a currently-`pending` proposal), `moveContactProposals` for
`mergeContacts`). `document_contacts` has no `workspace_id` column of its own - both
`document_id` and `contact_id` already resolve to a workspace via their own FKs, and the use
case verifies both belong to the caller's workspace before ever linking.
`src/persistence/tests/contacts-repository.db.test.ts` proves workspace scoping, the partial
unique index on `(workspace_id, vat_id_normalized)`, that two contacts CAN share an
`iban_normalized` (no unique index there, decisions/0019), link cascade on document/contact
deletion, and `moveContactLinks`/`moveContactProposals`'s repoint-and-dedupe behavior.

## 6. Composition root

`composition/create-request-services.ts` - the ONLY file under `src/persistence/`
allowed to bind concrete adapters from `src/platform/*/server` to use cases. Builds the
runtime `AppDb`, its `Repositories`, and its `UnitOfWork`, and hands each owner
area's use-case factory its `{ repos, uow }`. `system: createSystemUseCases({ repos })`
(T5) is the health check reached by `GET /api/health`, wired even though it owns no
schema; `workspaces: createWorkspaceUseCases({ repos, uow })` (P1) is the tenancy owner
area. `billing: createBillingUseCases({ repos, uow, paymentProvider })` (P2a; P3,
decisions/0017-billing-tiers-and-packages.md, added `uow`/`paymentProvider` -
`getPaymentProvider()` from `@/modules/billing/server`, the same env-picked
lazy-singleton shape `getObjectStorage()`/`getOcrEngine()` use) and
`documents: createDocumentUseCases({ repos, uow, objectStorage, billing, ocrEngine, analyzer })`
(P2a, decisions/0015-documents-and-quotas.md; P2b added `ocrEngine`/`analyzer`,
decisions/0016-processing-pipeline-and-ai.md) are wired the same way, with additions:
`documents` receives `getObjectStorage()` (`src/platform/object-storage/server`) and
`getOcrEngine()`/`getDocumentAnalyzer()` (`src/platform/mistral/server`, both picked by env
the same lazy-singleton way `getObjectStorage()` is) plus the already-built `billing`
use-case object, so `documents.createFromUpload` can call `billing.recordDocumentsCreated`
inside its own transaction without either owner writing the other's table (see
decisions/0015's "Cross-owner transaction sharing"). `contacts: createContactUseCases({ repos, uow })`
(C1, decisions/0019-contacts.md) is wired the plain way, like `workspaces` - it needs no
platform port, since matching/normalization are pure functions from `@/modules/contacts`
called directly by the use case. `jobs: createJobsUseCases({ repos, uow,
handlers })` (P2b) is wired last: `handlers` comes from `composition/job-handlers.ts`, built
from the already-constructed `documents`/`billing`/`workspaces` use cases and a `Mailer` -
"handlers registered where they belong" (decisions/0016), so
`src/platform/jobs`/`jobs-use-cases.ts` stay domain-free; P3 added the `send-quota-warning`
handler the same way, reading `workspaces.getWorkspaceWithAdminContact` and
`billing.getUsage`/`documents.countStored` to render and send the 80% warning e-mail. P7
(D2/D3, real-API defect fixes): `jobs-use-cases.ts`'s own `runOne` now logs every job
failure (`console.warn` for a retryable attempt, `console.error` for the terminal one -
permanent or attempts exhausted) with the job's stable error code, and calls
`@/platform/observability/server`'s `captureError` on the terminal outcome so a background
job failure - which never crosses a Next.js request boundary, unlike
`instrumentation.ts`'s `onRequestError` - still reaches Sentry when a DSN is configured.
This also closes D2: the job's `last_error_code` (and, via
`documents-use-cases.ts`'s own already-correct `classifyProcessingError`, the document's
`errorCode`) now provably keeps the specific code through a whole
transient-then-exhausted retry cycle, `processing_failed`/`unknown` reserved for a
genuinely unclassified error - `jobs-use-cases.test.ts` (new, §7 below) is the proof; there
was previously no dedicated unit test for this file at all.
`composition/request-services.ts` is the one allowed `cache(createRequestServices)`;
`composition/public-services.ts` is the equivalent narrow seam for `app_public` (empty
today, no unauthenticated public path exists in this template).

## 7. Tests

- `src/persistence/tests/db-errors.test.ts` (unit, `pnpm test`): SQLSTATE -> `DbErrorKind`
  mapping, `DrizzleQueryError` unwrapping, no DB.
- `src/persistence/tests/workspaces-use-cases.test.ts` (unit, `pnpm test`): the
  `workspaces` use case's own rules (name trimming/length, one-workspace-per-user,
  invitation replace-on-re-invite, the pending-invitation cap, invitation
  preview/accept validation - not-found/expired/already-used/email-mismatch/
  already-in-workspace) against the typed fake repositories - no DB. `removeMember`/
  `leaveWorkspace` no longer clear any document assignment or routing rule
  (decisions/0063-no-category-no-assignment-no-routing.md removed both), only the
  membership row itself.
- `src/persistence/tests/documents-use-cases.test.ts` (unit, `pnpm test`, P2a; P2b extended
  it): quota pre-check and rejection, storage compensation when the transaction throws,
  workspace scoping,
  delete, `createFromUpload` enqueuing `process-document` in the same transaction,
  `processDocument` (happy path with the fake OCR/analyzer, no-op on a deleted document,
  transient/permanent Mistral error classification and the document's own `errorCode`), and
  `retryProcessing` - all against typed fakes (`tests/support/fake-documents-repositories.ts`,
  `tests/support/fake-billing-repositories.ts`, `tests/support/fake-jobs-repository.ts`, and
  `src/platform/object-storage/tests/support/fake-object-storage.ts`), no DB, no network.
- `src/persistence/tests/jobs-use-cases.test.ts` (unit, `pnpm test`, P7/D2/D3): the generic
  job runner's own failure handling, against a typed fake `JobsRepository`
  (`tests/support/fake-jobs-repository.ts`) and `@/platform/observability/server`'s
  `captureError` mocked (never a real `serverEnv()`/Sentry call). Proves a job's
  `last_error_code` preserves the specific, stable error code end to end: a single
  transient failure, a permanent failure, and (D2) a whole transient-then-exhausted retry
  cycle - the same specific code on every attempt, never collapsing to `processing_failed`/
  `unknown` except for a genuinely unclassified thrown error. Also proves (D3) every failure
  is logged (`console.warn` for a retryable attempt, `console.error` for the terminal
  outcome - permanent or exhausted) with job id/kind/document id (best-effort, only when the
  payload carries one)/attempt/max attempts/error code/transient flag/retry time, and that
  only the terminal outcome calls `captureError` (Sentry).
- `src/persistence/tests/billing-use-cases.test.ts` (unit, `pnpm test`, P3,
  decisions/0017-billing-tiers-and-packages.md): `changeTier` (unknown tier, downgrade below
  the stored count, `billing_not_configured` when test mode is off, resets both warning
  markers), `purchasePackage` (rejected on Free, resets only the monthly marker,
  `billing_not_configured`), and `recordDocumentsCreated`'s warning-crossing/enqueue
  behavior (first crossing enqueues and marks, an already-set marker suppresses a further
  one, both limits can cross at once, nothing below 80%) - against typed fakes
  (`tests/support/fake-billing-repositories.ts`, `tests/support/fake-workspaces-repositories.ts`,
  `tests/support/fake-documents-repositories.ts`, `tests/support/fake-jobs-repository.ts`),
  no DB.
- `src/persistence/tests/system-use-cases.test.ts` (unit, `pnpm test`, T5): `health()`
  never throws, even when the fake repository's `ping()` rejects.
- `src/persistence/tests/contacts-use-cases.test.ts` (unit, `pnpm test`, C1,
  decisions/0019-contacts.md): `upsertFromExtraction`'s every verification-semantics branch
  (new contact, fill an empty field on both an unverified and an already-verified matched
  contact, `verified_at` resetting to `null` after any pipeline fill, a contradicting
  non-empty field producing a proposal instead of an overwrite, no proposal when the value is
  equal after normalization, rejecting a missing name), `createManual`/`updateManual`
  counting as verification (`updateManual`'s full-replace semantics: a cleared field becomes
  `null`), `linkDocument`/`unlinkDocument`'s cross-workspace validation, `mergeContacts`
  (fills the target's empty fields, never overwrites a non-empty one, moves links/proposals,
  deletes the source, rejects merging a contact into itself), `acceptProposal` (applies the
  value, re-verifies)/`rejectProposal` (leaves the contact untouched)/re-deciding an
  already-decided proposal, and `getById` - all against typed fakes
  (`tests/support/fake-contacts-repositories.ts`, `tests/support/fake-documents-repositories.ts`),
  no DB. `workspaces-use-cases.test.ts`'s own "company profile" describe block covers
  `getCompanyProfile`/`updateCompanyProfile` (blank-country-defaults-to-DE, trimming,
  `not_found`).
- `src/persistence/tests/workspaces-repository.db.test.ts` (P3 added `updateTier` coverage),
  `src/persistence/tests/documents-repository.db.test.ts`,
  `src/persistence/tests/billing-repository.db.test.ts` (P2a; P3 added `insertPurchase`/
  `listPurchasesForPeriod`/`insertTierChange`/`markWarned`/`clearWarnings` coverage),
  `src/persistence/tests/system-repository.db.test.ts` (T5), `src/persistence/tests/roles.db.test.ts`
  (real Postgres, `pnpm test:db` / part of `pnpm test:docker`): repository scoping by
  `workspaceId`, the one-workspace-per-user and one-admin-per-workspace unique
  constraints, invitation lookup by token hash, and the Unit of Work's rollback
  behavior; `system`'s `ping()` reaching a real connection; the role-privilege
  boundary (§3 above).
- `src/persistence/tests/jobs-repository.db.test.ts` (P2b, real Postgres): two concurrent
  `claimDue` callers never receive the same job, an expired lease is reclaimable, a job
  scheduled in the future or already claimed (unexpired lease) is not claimed, workspace
  scoping, and `enqueue` rolling back with its own transaction.
  `src/persistence/tests/contacts-repository.db.test.ts` (C1, real Postgres): workspace
  scoping on every method, the partial unique index on `(workspace_id, vat_id_normalized)`,
  that two contacts CAN share an `iban_normalized`, `document_contacts`' cascading delete on
  either side, `link`'s idempotency, and `moveContactLinks`/`moveContactProposals`'s
  repoint-and-dedupe behavior for `mergeContacts`.
- `src/persistence/tests/documents-use-cases-concurrency.db.test.ts` (real Postgres, P2a; P3
  added a second scenario): fires two concurrent `createFromUpload` calls when exactly one
  slot remains under the workspace's total limit and proves the row lock
  (`workspace.lockForUpdate`) serializes them so exactly one succeeds, and (P3,
  decisions/0017-billing-tiers-and-packages.md) fires two concurrent creates right at the
  80% warning threshold and proves exactly one `send-quota-warning` job is enqueued - the
  "at most once per limit per calendar month" guarantee holding under real concurrency, not
  only against a fake.
  `src/persistence/tests/contacts-use-cases-concurrency.db.test.ts` (real Postgres, C1,
  decisions/0019-contacts.md): fires two concurrent `upsertFromExtraction` calls for the same
  never-seen-before VAT id and proves the unique-violation retry resolves the race to exactly
  one contact (both calls' results point at the same `contactId`, both documents end up
  linked to it); a second scenario fires two concurrent calls with no shared strong
  identifier and documents the accepted limitation that weak matches can race into two
  separate contacts.
- `tests/integration/workflows/persistence-wiring.integration.test.ts` (real
  Postgres, `pnpm test:int` / part of `pnpm test:docker`): the composition root
  itself, end to end - `getRequestServices()` builds and its `workspaces` use case
  (built on the real `Repositories`/`UnitOfWork`) commits a real write;
  `getPublicDb()` connects as a genuinely different, less-privileged role. The full
  onboard -> invite -> accept flow through the real actions/use cases is
  `tests/integration/workflows/workspaces-onboarding.integration.test.ts`
  (`src/modules/workspaces/README.md`). `tests/integration/http/health-route.integration.test.ts`
  exercises `GET /api/health` the same way, through the real route handler.
  `tests/integration/http/documents-upload.integration.test.ts` and
  `documents-file.integration.test.ts` (P2a) exercise `POST /api/documents` and
  `GET /api/documents/[id]/file` against real Postgres and real MinIO
  (`src/modules/documents/README.md`). `tests/integration/workflows/processing-pipeline.integration.test.ts`
  (P2b) uploads through the real route handler, then calls `runDueJobs` directly (fake AI
  provider, no `MISTRAL_API_KEY` set anywhere in this environment): the document reaches
  `done`, the searchable PDF object exists in MinIO, and full-text search finds a word from the
  fake OCR text. `tests/integration/http/cron-process-jobs.integration.test.ts`
  (P2b) exercises `GET /api/cron/process-jobs` against real Postgres: 401 without/with the
  wrong bearer secret, 200 with the right one.
  `tests/integration/workflows/billing.integration.test.ts` (P3,
  decisions/0017-billing-tiers-and-packages.md) calls the real `POST /api/documents` route
  and `src/modules/billing/actions.ts`'s Server Actions against real Postgres: a free
  workspace at its total limit gets 402, `changeTierAction` (test mode) then lets the same
  upload through; `purchasePackageAction` raises the effective monthly capacity for the
  current period; and crossing the 80% warning threshold enqueues a job whose e-mail
  reaches the test stack's real Mailpit container over SMTP (the mailer is NOT mocked in
  this one file, unlike `workspaces-onboarding.integration.test.ts`'s mocked mailer - proving
  the outbox actually delivers, not only that `Mailer.send` was called correctly).
  `tests/integration/workflows/contacts-extraction.integration.test.ts` (C1,
  decisions/0019-contacts.md) calls the real `getRequestServices().contacts` against real
  Postgres: a fresh extraction creates a contact and links its document; a second document
  from the same sender (matched by VAT id, differently formatted) links to the SAME contact.
- `src/persistence/tests/support/unused-repositories.ts`,
  `fake-workspaces-repositories.ts`: typed fakes, consumed by
  `src/persistence/tests/workspaces-use-cases.test.ts`. `fake-documents-repositories.ts`,
  `fake-billing-repositories.ts` (P2a; P3 extended the latter with purchase/tier-change
  fakes): typed fakes, consumed by `documents-use-cases.test.ts`,
  `billing-use-cases.test.ts` (P3), and `workspaces-use-cases.test.ts`'s `removeMember`
  tests.
  `fake-jobs-repository.ts` (P2b): typed fakes,
  consumed by `documents-use-cases.test.ts` (job enqueueing, `processDocument`,
  `retryProcessing`) and `workspaces-use-cases.test.ts`'s `removeMember` tests.
  `fake-contacts-repositories.ts` (C1): typed fakes for `ContactRepository`/
  `DocumentContactRepository`/`ContactProposalRepository`, consumed by
  `contacts-use-cases.test.ts`.
  `fake-accounts-repositories.ts` (F2, decisions/0024-accounts-and-transactions.md): typed
  fakes for `AccountRepository`/`TransactionRepository`/`ImportBatchRepository`, consumed by
  `accounts-use-cases.test.ts`.
- `src/persistence/tests/accounts-use-cases.test.ts` (unit, `pnpm test`, F2): the import
  service's account resolution (auto-create by IBAN, reuse an existing account, resolve an
  explicit `accountId`), idempotent re-import (zero new rows and the same batch row the
  second time), the `pending_account` outcome for a source with no own-account IBAN, the
  `not_importable` guard for a document that is not a confirmed `bank_statement`, and
  workspace scoping - against typed fakes, no DB.
  `src/persistence/tests/accounts-repository.db.test.ts` (F2, real Postgres): the per-account
  idempotency-key unique constraint (including that the SAME key is allowed again under a
  DIFFERENT account), the `accounts` partial unique index on `(workspace_id, iban)` (rejecting
  a true duplicate, allowing multiple `iban: null` rows), the per-source-document batch
  upsert, that deleting the source document sets `source_document_id` to `null` on both the
  transaction and the batch rather than deleting either, and `listPendingAccountDocuments`'s
  workspace scoping.
  `tests/integration/workflows/accounts-import.integration.test.ts` (F2, real Postgres +
  MinIO, `pnpm test:int` / part of `pnpm test:docker`): uploads a camt.053 statement through
  the real `POST /api/documents` route and runs the real job runner - the account is
  auto-created and its transaction imported; a confirmed Musterbank-style CSV (no own-account
  IBAN) reports `pending_account` until an explicit account is given; workspace scoping end
  to end.
