# src/modules/accounts

Document type: reference
Lifecycle: active
Owner: src/modules/accounts
Scope: Bank/clearing accounts, imported transactions, import batches, the import service that
turns a confirmed intake document into rows in them, and the admin-only "Finanzen" UI
Canonical responsibility: Everything the `accounts`/`transactions`/`import_batches` tables and
`AccountsUseCases` do, and how `finance.read`/`finance.manage` gate this module end to end
Maintenance triggers:
- The `accounts`/`transactions`/`import_batches`/`settlement_lines` schema changes
- The supplier clearing account's sign convention, its booking triggers, or how a bank charge
  resolves to a contact changes (decisions/0068-supplier-clearing-accounts.md)
- The import service's account-resolution or idempotent-reimport logic changes
- A new pipeline branch needs to trigger (or stop triggering) the `import-account-transactions`
  job
- The settlement-line derivation (`buildSettlementLineDrafts`) or the payout-pairing rule
  changes
- `loadSettlementRows`'s Apple/Google re-detection, or either reader's own shape, changes
  (decisions/0048-app-store-reports.md)
Last verified: 2026-10-22, decisions/0076-match-after-every-trigger.md: `importFromDocument`
queues its `match-payments` run due now (`JobsRepository.scheduleNow`) instead of 90 seconds
later, and `importFromDocumentAction` starts the runner in `after()`. Previously 2026-10-03,
decisions/0068-supplier-clearing-accounts.md: a clearing account
may now be owned by a CONTACT instead of a platform (`accounts.contact_id`, migration
`0020_concerned_blue_shield.sql`, with its own partial unique index
`accounts_workspace_contact_clearing_key` and a check constraint that forbids a platform and
a contact owning the same account). `AccountRepository.findByContact`, and three new use-case
methods: `createContactClearingAccount` (creates it and books the history in the same call),
`getContactClearingAccount`, and `bookContactClearingEntries` (the recurring pass, called by
`PaymentsUseCases.runMatching` through the same narrow port `recordPlatformPayout` already
uses). An incoming invoice of that contact books a NEGATIVE amount and the document becomes
`settled`; a still-unexplained bank charge whose counterparty resolves to the contact
(`@/modules/payments`'s `resolveContactForCounterparty`) books the opposite sign and shares a
`transferGroupId` with the bank row - so `unmatchedTransactionConditions` gained a fourth
condition (`transfer_group_id is null`), and a booked charge stops counting as "eine Buchung
ohne Beleg". UI: "Verrechnungskonto" on `/dashboard/contacts/[id]` (`finance.read` to see,
`finance.manage` to create, with the optional payment name that makes the charges findable at
all), a contact-owned hint on `/dashboard/finance`, and the "im erfassten Zeitraum nicht
erklärt" note on the account's own page (`getAccountOverviewProjection` replaced
`getAccountDetailProjection`, which had no other caller). Verified against sample
data: 12 Meta invoices (51,00 EUR) and 6 FACEBK charges (50,40 EUR) book to a balance of
-0,60 EUR, every invoice leaves `open`, no Meta charge stays unexplained, and a second pass
books nothing.
Previously last verified: 2026-10-02, decisions/0066-abschluss-check-and-export.md: `listUnmatched`
and `countUnmatched` now build their three conditions (not confirmed, not "kein Beleg
nötig", not on a clearing account) from one shared `unmatchedTransactionConditions` builder
instead of two copies - they were deliberately duplicated before, but the Abschluss's
"Buchungen ohne Beleg" count is a third caller whose entire job is to count exactly what
"Zuordnung" lists. `TransactionRepository` gained `countsForPeriod` (that same condition set
plus a booking-date range, alongside the period's unfiltered total) and `listForPeriod` (the
export's "Buchungen" sheet, with the account name resolved in SQL and, since the export began
cross-referencing its two sheets, the confirmed documents THEMSELVES - `confirmedDocuments`,
each with the document's own effective date and amount, read with `src/modules/documents`'
own exported expressions rather than a second definition of them - instead of a bare count).
No behaviour change to "Zuordnung" or "Start".
Previously last verified 2026-09-22, decisions/0048-app-store-reports.md: `loadSettlementRows`
(`accounts-use-cases.ts`) now re-detects Apple's payment summary/Google Play's earnings report
directly from the re-read original bytes (`@/modules/intake`'s `detectApplePaymentSummary`/
`detectGooglePlayEarnings`) and calls the matching reader, ahead of the generic
fingerprint/`intake_result` fallback - both share `text/csv` with the generic AI-mapped
settlement path, so this module needed its own re-detection the same way it already
distinguishes camt.053/MT940 by `mimeType`. Neither reader ever sets a `payoutId` on its
lines (deliberately: this phase's own payout-to-bank-credit pairing lives entirely in
`src/modules/payments`, not this module's own `payoutId`-grouping/`tryPairPayout` mechanism -
see that ADR for why). No other change: `buildSettlementLineDrafts`/`importFromDocument`'s
settlement-report branch handle both reports' own revenue/fee/refund lines unmodified.
Previously last verified 2026-09-20, F5 (hardening, decisions/0027-hardening-and-deletion.md): four
adversarial-review fixes. (1) `updateAccount` now blocks an IBAN change once the account has
any import batch (`ACCOUNT_ERROR.iban_locked_by_imports`) - editing it after imports exist
desynced auto-resolution and silently misattributed already-imported transactions. (2)
`importFromDocument`'s explicit-`accountId` path now rejects a `type: "clearing"` account
(`ACCOUNT_ERROR.not_bank_account`) - a platform's own clearing ledger must never receive a
plain bank statement's transactions; `PendingAccountsSection`'s own account list is also
filtered to `type: "bank"`. (3) `TransactionRepository.sumAmountCents` (the fallback "latest
balance" for an account with no batch carrying one) no longer sums a differently-currencied
transaction into the total - it excludes it and reports `hasMixedCurrency`, surfaced as
`AccountOverview.hasMixedCurrencyTransactions` (a warning badge on `/dashboard/finance`). (4)
`accounts` gained a partial unique index, `accounts_workspace_platform_clearing_key`
(`workspace_id, platform) where type = 'clearing'`, migration `0016_uneven_bulldozer.sql` -
`importSettlementReportDocument` retries once on the resulting conflict instead of letting
two concurrent settlement-report imports for a never-seen platform both create a clearing
account. Previously, F4 (platform settlements, decisions/0026-platform-settlements.md):
added `settlement_lines` (`SettlementLineRepository`), `AccountRepository.findByPlatform`,
`TransactionRepository.findByIdempotencyKeys`/`setTransferGroup`/`findUnpairedBankMatch`,
`core/settlement-lines.ts`'s `buildSettlementLineDrafts`, `importFromDocument`'s
settlement-report branch (`importSettlementReportDocument`) and its payout-to-bank pairing
(including the "bank line arrives later" call-back from the bank-import path itself), and
excluded every `clearing`-account transaction from `listForMatching`/`listUnmatched`.

## Purpose

Persists the normalized bank transactions `@/modules/intake`/`src/modules/documents`'s
universal intake pipeline already recognizes and validates (decisions/0020-universal-intake.md,
decisions/0022-intake-wiring.md) once a `bank_statement` document reaches `intakeStatus:
"confirmed"`, and gives an admin a place to see them: account balances, statement coverage,
and a searchable transaction list. See decisions/0024-accounts-and-transactions.md for the
full design rationale, in particular why this module is admin-only end to end (a bank
statement exposes salaries and other private debits) and why one document produces exactly one
import batch.

## Public interfaces

- `index.ts` (neutral): pure mapping/reconciliation/resolution functions
  (`mapCamt053StatementsToImportable`, `mapTabularRowsToImportable`,
  `summarizeStatementsForBatch`, `computeBalanceMismatch`, `resolveAccountByIban`,
  `findCoverageGaps`), the manual-account/filter Zod schemas, and the Server Action error-code
  set.
- `actions.ts` (`"use server"`): `createAccountAction`, `updateAccountAction`,
  `importFromDocumentAction` - all gated behind `PERMISSIONS.financeManage` (admin-only).
  `importFromDocumentAction` starts the job runner in `after()`: an import that inserted new
  transactions queues `match-payments` due now, and it runs right away instead of at the next
  cron sweep (decisions/0076-match-after-every-trigger.md; the job-run import path gets the same
  from the runner that ran `import-account-transactions`).
- `server.ts` (`server-only`): read models for `/dashboard/finance`/`/dashboard/finance/[accountId]`
  (`listAccountsOverviewProjection`, `listPendingAccountDocumentsProjection`,
  `getAccountDetailProjection`, `listTransactionsProjection`, `listImportBatchesProjection`).
- `client.ts` (`"use client"`): `CreateAccountSection`, `EditAccountSection`,
  `PendingAccountsSection`, `ReimportButton`, plus `AccountFieldsView`/`EMPTY_ACCOUNT_FIELDS`.

## Structure

- `core/types.ts` - `ImportableTransaction`/`ImportableStatement`/`ImportOutcome`, the common
  shape both non-OCR bank-statement intake branches (camt.053, a confirmed tabular mapping)
  are reduced to before insertion.
- `core/mapping.ts` - `mapCamt053StatementsToImportable`/`mapTabularRowsToImportable` (pure
  reductions from `@/modules/intake`'s own shapes) and `summarizeStatementsForBatch` (the
  one-batch-per-document summary, decisions/0024's "one document, one import batch").
- `core/reconciliation.ts` - `computeBalanceMismatch`, mirroring `@/modules/intake`'s
  `camt053StatementReconciles` but operating on already-mapped data (so it also answers
  correctly - `false` - for a tabular source with no balance data at all).
- `core/account-resolution.ts` - `resolveAccountByIban`, reusing `@/modules/contacts`'s
  `normalizeIban` rather than duplicating IBAN normalization in this module.
- `core/coverage.ts` - `findCoverageGaps`, the accounts-overview "gap between batches"
  highlight.
- `core/settlement-lines.ts` - F4 (decisions/0026-platform-settlements.md): pure
  `buildSettlementLineDrafts`, reducing a confirmed `payout_report`/`platform_settlement`
  document's `NormalizedSettlementLine[]` into `revenue`/`fee`/`refund`/`payout` ledger
  drafts - see that file's own header comment for exactly how one raw row becomes up to three
  of these.
- `core/schemas.ts` - `transactionListQuerySchema` (the account detail page's URL filter
  state), `manualAccountCreateSchema`/`manualAccountUpdateSchema` (hard IBAN checksum
  validation, same "a human is present to fix it immediately" rationale
  `@/modules/contacts`'s manual schemas already established), `importFromDocumentInputSchema`.
- `core/error-codes.ts` - `ACCOUNT_ACTION_ERROR_CODES`, the Server Action layer's own set.
- `server/read-models.ts` - the projections listed above, each `cache()`d per request.
- `ui/account-form.tsx`, `ui/create-account-section.tsx`, `ui/edit-account-section.tsx`,
  `ui/pending-accounts-section.tsx`, `ui/reimport-button.tsx` - the manual create/edit form and
  its two toggle wrappers, the "Konto zuordnen" pending-account resolution list, and the
  "Erneut importieren" button on the import-history section.
- `tests/` - unit tests for every `core/` file plus `actions.test.ts` (permission gating via
  `vi.mock`, same pattern as `@/modules/documents/tests/actions.test.ts`) and
  `error-codes-i18n.test.ts` (guards `Finance.form.errors`/`Finance.detail.errors` against
  drift, same pattern as `@/modules/contacts/tests/error-codes-i18n.test.ts`).

## Persistence

`src/persistence/schema/accounts.ts` (`accounts`, `transactions`, `import_batches`,
`settlement_lines`), `repositories/{contracts,drizzle}/accounts-repository.ts`
(`AccountRepository`/`TransactionRepository`/`ImportBatchRepository`/`SettlementLineRepository`),
and `src/persistence/use-cases/accounts-use-cases.ts` (`AccountsUseCases`, in particular
`importFromDocument` - see decisions/0024's own "Import service" section for the bank-statement
account-resolution order and the "pending account" outcome, and decisions/0026's "Import"
section for the settlement-report branch). Only this owner's repositories write to these four
tables (`src/persistence/README.md`'s "only the owner writes").

## The pipeline hook

`src/persistence/use-cases/documents-use-cases.ts` enqueues the `import-account-transactions`
job (`@/platform/jobs`'s `JOB_KINDS`) - never a direct call into `AccountsUseCases` - at three
points: the camt.053 branch (`processCamt053Document`, always), the
tabular-known-fingerprint branch (`processTabularDocument`, only when the confirmed
`documentKind` is importable, `isAccountsImportableKind`: `bank_statement`, `payout_report`, or
`platform_settlement`), and `confirmIntake` (same condition, the human-confirms-a-proposal
path). `src/persistence/composition/job-handlers.ts` dispatches it to
`AccountsUseCases.importFromDocument`, which itself branches on the document's own `kind` -
a bank statement or a settlement report never share a code path beyond this one dispatch
point. `create-request-services.ts` wires `accounts` into that handler map alongside
`documents`/`billing`/`workspaces`/`payments`. A settlement report's own import additionally
enqueues `@/modules/payments`'s `match-settlement-lines` job whenever it inserts at least one
new settlement line (decisions/0026) - `AccountsUseCases` never calls into `PaymentsUseCases`
directly, the same job-queue discipline.

## Access

`src/platform/access/core/permissions.ts`'s `finance.read`/`finance.manage` - both admin-only,
the first bundle in this codebase granted to NO member-level capability at all
(decisions/0024's "Consequences"). `/dashboard/finance`/`/dashboard/finance/[accountId]` both
404 for a caller without `finance.read`; every Server Action here requires `finance.manage`.
The nav entry ("Finanzen", `src/modules/dashboard-shell/core/nav-items.ts`) is filtered by
`finance.read`, so a member never sees it in the sidebar.

## Known limitation: unindexed transaction search

`TransactionRepository.list`'s free-text filter (`counterpartyName`/`remittanceText`) uses a
leading-`%` `ilike`, which cannot use a plain B-tree index - no trigram/tsvector index exists
for it. Accepted as a documented limitation for this product's scale (a small business's own
transaction history, not a multi-tenant analytics workload) rather than adding a `pg_trgm`
Postgres extension for it (decisions/0027-hardening-and-deletion.md's "What was deliberately
not fixed"); the query site itself documents this as the revisit trigger.

## Dependencies on other owners

`@/modules/intake` (`parseCamt053`, `sampleTabular`/`parseTabularRows`/`validateMapping`,
every normalized-row/statement/settlement-line type), `@/modules/contacts` (`normalizeIban`),
`@/modules/documents` (`parseIntakeResult`, read-only), `@/platform/object-storage`
(re-reading a document's original stored bytes), `@/platform/access`, `@/platform/jobs`
(F4: also `JOB_KINDS.matchSettlementLines`, enqueued but never called directly - see "The
pipeline hook"), `@/shared/ui-primitives`.

## Tests

- Unit (no DB): every `core/` file (`mapping.test.ts` includes the idempotency-key-passthrough
  guarantee both mapping functions must uphold; `settlement-lines.test.ts` runs F1a's real
  Stripe/Apple fixtures through the real fake-classifier mapping end to end, not a hand-built
  `NormalizedSettlementLine[]`), `actions.test.ts` (permission gating), `error-codes-i18n.test.ts`,
  plus `src/persistence/tests/accounts-use-cases.test.ts` (the import service's account
  resolution/auto-creation, idempotent re-import, the pending-account outcome, and workspace
  scoping - typed fakes, no DB).
- DB (`src/persistence/tests/accounts-repository.db.test.ts`, real Postgres): the per-account
  idempotency-key unique constraint, the per-source-document batch upsert, the IBAN partial
  unique index (including that multiple `iban: null` accounts coexist), that deleting the
  source document sets `source_document_id` to `null` on both the transaction and the batch
  rather than deleting either, and (F5) the `accounts_workspace_platform_clearing_key`
  partial unique index (a second clearing account for the same platform is rejected; a
  `type: "bank"` row with the same `platform` value is unaffected) and `sumAmountCents`'s
  real SQL `CASE`/`bool_or` mixed-currency exclusion/flag.
- F5: `src/persistence/tests/accounts-use-cases.test.ts`'s "listAccounts" suite (exact vs.
  fallback balance, mixed-currency exclusion/flagging, no-batch-at-all) and "updateAccount"
  suite (the IBAN lock, a non-IBAN edit still allowed with import history, the pre-existing
  duplicate-IBAN check unaffected); the "importFromDocument - tabular" suite's
  `not_bank_account` rejection test.
- F5: `tests/integration/workflows/accounts-import.integration.test.ts`'s NOTPROVIDED test
  runs the real `camt053-notprovided.xml` fixture through the actual upload -> job ->
  `AccountsUseCases` path, proving two same-day/same-amount transactions with the
  ISO-20022 "no reference" placeholder both survive as distinct rows (the F2-review finding
  this closes the missing coverage for; the underlying idempotency-key fix landed earlier,
  in `@/modules/intake`).
- Integration (`tests/integration/workflows/accounts-import.integration.test.ts`, real Postgres
  + MinIO, the real upload route and job runner): a camt.053 upload auto-creates its account
  and imports its transactions; a confirmed Musterbank-style CSV (no own-account IBAN) reports
  `pending_account` until an explicit account is given; workspace scoping end to end.
  `tests/integration/workflows/settlement-import.integration.test.ts` (F4, decisions/0026):
  the Stripe payout report imports into its own clearing account idempotently, an outgoing
  invoice matches its revenue line by invoice number, a platform fee invoice settles once its
  period's fee lines are known, and a platform payout pairs with its bank deposit - including
  when the bank line is imported LATER.
- E2E (`tests/e2e/finance.spec.ts`, tagged `@smoke`): an admin uploads a camt.053 statement and
  sees the account/transaction under "Finanzen"; a plain member never sees the nav entry and is
  `404`d on the route directly. `tests/e2e/settlement.spec.ts` (F4, tagged `@smoke`): an admin
  uploads and confirms the Stripe payout report and sees the clearing account and its own
  decomposition; a member sees none of it.
