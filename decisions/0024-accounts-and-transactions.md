# Accounts and transactions: bank accounts, idempotent import, and admin-only finance access

Document type: decision
Lifecycle: active
Owner: src/modules/accounts
Scope: The `accounts`/`transactions`/`import_batches` data model, the import service that
turns a confirmed intake document into imported transactions, the pipeline hook that triggers
it, the "pending account" flow for a source with no own-account IBAN, and the admin-only
`finance.read`/`finance.manage` permission bundle
Canonical responsibility: Active source for why the finance area deviates from the PRD's "kein
Rechte-Management" and is admin-only end to end, why one document produces exactly one import
batch (not one per statement), how idempotent re-import is guaranteed at the database level,
and what F4 (platform settlement payouts) will add on top of this phase's schema
Maintenance triggers:
- The one-document-one-batch simplification is revisited (a multi-account camt.053 file needs
  its statements split across several accounts)
- F4 (platform settlements) lands and starts using `accounts.platform`/`transactions.transferGroupId`
- The pending-account flow gains an auto-suggest step, or the admin-only finance scope changes
Last verified: 2026-09-20, F2 (accounts and transactions)

## Status
Accepted

## Context

decisions/0020-universal-intake.md and decisions/0022-intake-wiring.md built the universal
intake recognizer and wired it into an upload/confirmation flow that produces a normalized,
validated set of bank transactions for a confirmed `bank_statement` document - either
deterministically (camt.053) or via a human-confirmed column mapping (a bank's CSV/TSV
export). Neither phase persisted those transactions anywhere durable beyond
`documents.intake_result` (a capped, JSON summary of the document's own processing outcome,
not a queryable ledger). This phase (F2) is that persistence: real `accounts`/`transactions`
tables, an import service that turns a confirmed document into rows in them, and the first UI
surface (`/dashboard/finance`, "Finanzen") a small business's own bookkeeping data becomes
visible through.

A bank statement is qualitatively different from every other document type this product
handles so far: it exposes exact salaries, private debits, and the complete cash position of
the business. The architecture brief's PRD explicitly says "kein Rechte-Management" beyond a
single admin per workspace (decisions/0014-workspaces-and-access.md), and every existing
document capability (`documents.read`/`documents.write`) is shared by every workspace member.
This phase makes its first deliberate exception to that rule.

## Decision

### 1. The finance area is admin-only, end to end

Two new permissions, `finance.read` and `finance.manage` (`src/platform/access/core/permissions.ts`),
both granted ONLY to `admin` - unlike every other bundle in that file, `member`'s own array
gets neither. `/dashboard/finance` and `/dashboard/finance/[accountId]` both call
`requireWorkspaceMember()` then `notFound()` for a caller without `finance.read` (the same
`404`, not a redirect, pattern `/dashboard/routing` and `/dashboard/settings/intake` already
use); every mutation (`createAccountAction`/`updateAccountAction`/`importFromDocumentAction`)
is gated behind `finance.manage`. The nav entry ("Finanzen", `src/modules/dashboard-shell/core/nav-items.ts`)
is filtered by `finance.read`, so a member never even sees it exists. This is the first bundle
in this codebase with no member-level capability at all - a deliberate, reasoned deviation
from the PRD, recorded here per this ADR's own canonical responsibility.

### 2. Schema: `accounts`, `transactions`, `import_batches`

`src/persistence/schema/accounts.ts` (owner `src/modules/accounts`):

- `accounts`: `workspace_id`, `type` (`bank`/`clearing`), `name`, `iban` (always normalized -
  uppercase, no spaces, `@/modules/contacts`'s `normalizeIban` reused rather than duplicated -
  and unique per workspace when not null via a plain, default-NULLS-DISTINCT unique index, so
  any number of `iban: null` clearing accounts may coexist), `bic`, `currency`, `holder`,
  `platform` (only meaningful for a `clearing` account - F4's future settlement accounts:
  "stripe", "apple", ...), `created_at`/`updated_at`.
- `transactions`: every field the brief's schema list names, `idempotency_key` taken verbatim
  from `@/modules/intake` (never recomputed) and unique per `account_id` (the idempotent-reimport
  guarantee, §4 below), `source_document_id` (`on delete set null`), `import_batch_id`
  (`on delete set null`), a `transfer_group_id` reserved, unused column for F4's future
  payout-to-bank-deposit pairing, and `raw` jsonb (the intake module's own normalized object,
  verbatim - an audit trail independent of the typed columns). Indexes on `(workspace_id,
  booking_date desc)`, `(account_id, booking_date desc)`, `(workspace_id, counterparty_iban)`,
  `(workspace_id, amount_cents)`.
- `import_batches`: `workspace_id`, `account_id`, `source_document_id` (`on delete set null`),
  `statement_from`/`statement_to`, `opening_balance_cents`/`closing_balance_cents`,
  `rows_total`/`rows_imported`/`rows_duplicate`, `balance_mismatch` (boolean, `true` when
  opening + the sum of the batch's transactions does not equal closing - a data-quality
  signal, never a reason to reject the import, mirroring `@/modules/intake`'s
  `camt053StatementReconciles`/decisions/0022's identical precedent for the per-statement
  version of this same check).

### 3. One document, one import batch

`import_batches` has a plain unique index on `source_document_id` (when not null): a document
produces at most one batch row, upserted (not re-inserted) on every re-run
(`ImportBatchRepository.upsertForDocument`, `ON CONFLICT (source_document_id) DO UPDATE`). This
is a deliberate simplification over "one batch per camt.053 statement": a camt.053 EXPORT can
in principle contain multiple `<Stmt>` elements for different accounts (a bank's combined
multi-account export), but every real-world source this product currently recognizes
(Sparkasse, Musterbank, Deutsche Bank) exports one statement per file. `importFromDocument`
therefore resolves (or is given) exactly ONE target account for the whole document; when a
document happens to contain several statements, every one of their transactions is imported
into that single account, and the batch's own `statement_from`/`statement_to`/
`opening_balance_cents`/`closing_balance_cents` are summarized across all of them (earliest
booking date, latest booking date, the first statement's opening balance, the last statement's
closing balance - `@/modules/accounts`'s `summarizeStatementsForBatch`). A genuinely
multi-account file would import every statement's transactions into the one resolved account
rather than splitting them - an accepted, documented limitation, not silently wrong data (the
transactions themselves are still correct amounts/dates/counterparties, only their statement
attribution collapses to one account).

### 4. Idempotent import at the database level

Two independent guarantees, both enforced by real constraints, not only application logic:

- **Transaction level**: `transactions_account_idempotency_key` (`account_id`,
  `idempotency_key`) - `TransactionRepository.insertManyIdempotent` inserts with `ON CONFLICT
  ... DO NOTHING`, so re-importing an overlapping statement period (the same file twice, or two
  files whose date ranges overlap) inserts nothing for a transaction already known. The
  returned row count is exactly how many rows this call actually inserted, so `rows_imported`/
  `rows_duplicate` on the batch are reported directly from it, never a separate count query.
- **Batch level**: `import_batches_source_document_key` (§3 above) - re-running the import for
  the same document updates the same batch row's stats instead of accumulating a second one.

Both are proved against real Postgres (`src/persistence/tests/accounts-repository.db.test.ts`),
not only asserted against a fake, following this codebase's usual "prove it under the real
constraint" discipline (decisions/0019-contacts.md's own concurrency test is the precedent).

### 5. The import service: `AccountsUseCases.importFromDocument`

`src/persistence/use-cases/accounts-use-cases.ts`. Always re-reads and re-parses the
document's ORIGINAL stored bytes via `@/platform/object-storage` - never trusts
`documents.intake_result` for the transaction data itself, which is capped at
`MAX_EMBEDDED_ROWS` (500, decisions/0022) and, for a camt.053 statement, never carried
balance/date-range data at all. For a confirmed tabular (CSV/TSV) mapping, it prefers
re-deriving from the workspace's own confirmed fingerprint (always present for a confirmed
tabular document - `confirmIntake` always writes one) over the possibly-truncated
`intake_result.rows`, falling through to the latter only when no matching fingerprint exists
(e.g. after "Zuordnung zurücksetzen") and the stored result is not itself truncated - a
`not_importable` error otherwise, rather than silently under-importing.

**Account resolution** (`@/modules/accounts`'s pure `resolveAccountByIban`, unit-tested without
a database):

1. An explicit `accountId` (the "pending account" resolution, or "re-import against this
   account") always wins, after checking it actually exists in the workspace.
2. Otherwise, the first statement in the document that declares its own account IBAN
   (`Camt053Statement.accountIban`) resolves against the workspace's existing accounts by
   normalized IBAN; a match reuses that account, no match auto-creates one (`type: "bank"`,
   name `"Bankkonto <last 4 IBAN digits>"`, editable afterwards).
3. **No IBAN anywhere in the document and no explicit `accountId`**: nothing is imported.
   `importFromDocument` returns `{ status: "pending_account", reason: "missing_iban" }` -
   surfaced by `/dashboard/finance`'s "Konto zuordnen" section (a small list of these
   documents, each with a `<select>` of existing accounts and an "Importieren" button that
   calls `importFromDocumentAction` with the chosen `accountId`). **This is the common case for
   every tabular (CSV/TSV) bank-statement source**: `@/modules/intake`'s `SEMANTIC_FIELDS` has
   no own-account-IBAN field at all (decisions/0020's own closed vocabulary), so a confirmed
   Musterbank/Sparkasse-style CSV mapping NEVER carries one - only a camt.053 export can
   self-resolve. Creating a brand-new account for one of these documents is a deliberate
   two-step flow (create the account via the ordinary "Konto anlegen" form, then pick it from
   the pending list) rather than a combined create-and-import form, kept simple for this phase.

### 6. Pipeline hook: a job, not a direct cross-module call

`documents-use-cases.ts` enqueues the new `import-account-transactions` job
(`@/platform/jobs`'s `JOB_KINDS`) at exactly the moments decisions/0022's own "Hook point for
F2" note names: the camt.053 branch (always), the tabular-known-fingerprint branch (only when
`documentKind === "bank_statement"` - never for a settlement/payout report), and
`confirmIntake` (same `bank_statement`-only condition, covering the human-confirms-a-tabular-proposal
path, "re-runnable from the UI"). This is a job, not a direct call into `AccountsUseCases`,
specifically so `documents-use-cases.ts` never needs an `accounts` dependency of its own - the
same "handlers registered where they belong" owner-boundary discipline
decisions/0016-processing-pipeline-and-ai.md already established for `send-assignment-email`.
The composition root (`create-request-services.ts`) wires `accounts` into `createJobHandlers`
exactly like `documents`/`billing`/`workspaces` already are.

### 7. Manual accounts, filters, and the UI surface

`/dashboard/finance` (accounts overview: name, formatted IBAN, latest balance, a coverage-gap
badge computed by the pure `@/modules/accounts`'s `findCoverageGaps` from every account's own
import batches' `[statement_from, statement_to]` ranges) and `/dashboard/finance/[accountId]`
(transaction list with search over counterparty/remittance text, a date range, a whole-cents
amount range, and a credit/debit toggle - filter state lives in the URL, the same convention
`/dashboard/contacts` already uses; import history with duplicate counts and a
balance-mismatch warning per batch, each with a re-run button). An account with no import
batch carrying a closing balance (every tabular-only account, since a confirmed mapping never
carries balance data at all) falls back to the running sum of its own transactions as an
approximate "latest balance", visibly labelled as such (`balanceIsExact: false`) rather than
silently presented as exact.

Manual account creation/editing (`AccountForm`, `manualAccountCreateSchema`/
`manualAccountUpdateSchema`) validates a hand-typed IBAN with a hard mod-97 checksum check -
same "a human is present to fix it immediately" rationale decisions/0019-contacts.md's
`manualContactCreateSchema` already established for the identical tradeoff.

## Consequences

- Positive: the idempotent-reimport guarantee and the balance-mismatch/coverage-gap signals
  are all backed by pure, dependency-free functions (`@/modules/accounts/core/**`) or real
  database constraints, never only application-level bookkeeping that a future bug could
  silently break.
- Positive: F4 (platform settlements) has a ready `type: "clearing"` account shape and a
  reserved `transactions.transfer_group_id` column to build its payout-to-bank-deposit pairing
  on, without a schema change.
- Negative: the "one document, one account" simplification (§3) means a genuinely
  multi-account camt.053 export imports every statement into a single resolved account rather
  than splitting them correctly - documented, not silently wrong, and correctable by a future
  phase if a real multi-account export is ever encountered in practice.
- Negative: correcting a document's assigned account after an import already ran (calling
  `importFromDocument` again with a DIFFERENT `accountId`) does not move or delete the
  previously-imported transactions under the old account - they remain, orphaned. Not expected
  to matter in practice (the pending-account flow only ever assigns an account ONCE, before any
  transaction exists for that document), called out here as an accepted, undocumented-in-UI
  limitation rather than a silently broken feature.
- Negative: this phase's finance UI shows only whole-cent amount filters (no euro-formatted,
  comma-decimal input) - a follow-up UX improvement, not a functional gap (the underlying
  filter is exact either way).
- Implementation status: **implemented** (F2). Schema
  (`src/persistence/schema/accounts.ts`), repositories (`repositories/{contracts,drizzle}/accounts-repository.ts`),
  the use case (`src/persistence/use-cases/accounts-use-cases.ts`), the pipeline hook
  (`documents-use-cases.ts`'s three enqueue points, `@/platform/jobs`'s `import-account-transactions`
  job kind), the composition root, `src/platform/access`'s `finance.read`/`finance.manage`
  bundle, and `src/modules/accounts`'s entire UI/actions/read-model layer all land in this
  phase, covered by unit tests (idempotency-key passthrough, account resolution, balance
  reconciliation, coverage gaps, filter/manual-account schemas, permission gating),
  `.db.test.ts` coverage against real Postgres, one `.integration.test.ts` (real Postgres +
  MinIO, the real upload route, the real job runner), and one e2e spec
  (`tests/e2e/finance.spec.ts`, tagged `@smoke`).

## Supersedes / Superseded By
- None
