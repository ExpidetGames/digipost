# Platform settlements: clearing accounts, settlement lines, and revenue/fee matching

Document type: decision
Lifecycle: active
Owner: src/modules/accounts, src/modules/payments
Scope: How a confirmed `payout_report`/`platform_settlement` document (Stripe, Apple, Google,
PayPal, Amazon) becomes a platform's own clearing account, its settlement lines and ledger
transactions, how a revenue line is matched to the outgoing invoice it paid for, how a
platform fee invoice settles once its period's fee lines are known, and how a platform's payout
pairs with the matching bank deposit
Canonical responsibility: Active source for the `settlement_lines` schema and
`documents.platform` column, `@/modules/accounts`'s `buildSettlementLineDrafts` (how one report
row becomes zero, one, or two ledger entries, and how a `payout` line is synthesized),
`AccountsUseCases.importFromDocument`'s settlement-report branch, the payout-to-bank pairing
rule and its "bank line arrives later" call-back, `PaymentsUseCases.matchSettlementReport`
(wiring F3a's `decomposeSettlement`/`matchSettlementLinesToDocuments`), the fee-invoice
detection heuristic, and the real `MatchableTransaction.isPlatformPayout` detection this phase
wires in place of F3b's hardcoded `false`
Maintenance triggers:
- The settlement-line type taxonomy, the payout-synthesis rule, or the payout-pairing window
  changes
- Fee-invoice detection moves from a name heuristic to a persisted platform-contact mapping
- A new settlement platform, or a report shape this phase's mapping-validator fix does not
  already handle, needs support
Last verified: 2026-09-20, F4 (platform settlements via clearing accounts)

## Status

Accepted

## Context

decisions/0020/0022 (F1a/F1b) already recognize a payout/settlement report as its own
`documentKind` (`payout_report`, `platform_settlement`) and normalize its rows into
`NormalizedSettlementLine`s once a human confirms the column mapping. decisions/0024 (F2)
already gives `accounts`/`transactions` a `type: "clearing"` shape and a reserved
`transfer_group_id` column specifically for this phase to build on. decisions/0023/0025
(F3a/F3b) already ship `core/settlement.ts`'s `decomposeSettlement`/
`matchSettlementLinesToDocuments` as pure, unwired arithmetic, and `MatchableTransaction.isPlatformPayout`
as a hardcoded `false` with an explicit "Hooks for you" note asking a later phase to wire real
detection. This phase (F4) is that wiring: everything from "a confirmed report exists" to "the
right invoices show as paid, the fee invoice shows as settled, and the payout appears as a plain
transfer, never a missing receipt."

## Product model (fixed by the product owner, restated here as the schema/logic's own contract)

Everything arrives through the one intake. A payout report (Stripe) or platform settlement
report (Apple, Google, PayPal, Amazon) is a document of kind `payout_report`/
`platform_settlement` with confirmed settlement lines in `intake_result`. Each platform gets
ONE clearing account per workspace (`accounts.type = clearing`, `platform` set): revenue lines
are credits, fees are debits, refunds are debits, the payout is a debit on the clearing account
paired (same `transfer_group_id`) with the credit on the bank account. Outgoing invoices match
revenue lines 1:1 (invoice number in metadata/description first, then customer + amount + date);
the monthly platform fee invoice is matched against the SUM of fee lines of that month and gets
payment status `settled` (never `open`); the bank payout line is a transfer, never "a document is
missing." If a period has no report yet, the bank payout stays informational ("Umbuchung von
&lt;Plattform&gt;" instead of a missing-document state), never a confirmed match.

## Decision

### 1. Schema: `settlement_lines` and `documents.platform`

`src/persistence/schema/accounts.ts` gains `settlement_lines` (owner `src/modules/accounts`,
alongside `accounts`/`transactions`/`import_batches`): `workspace_id`, `clearing_account_id`,
`source_document_id`, `transaction_id` (the ledger row this line produced, `on delete set
null`), `type` (`revenue|fee|refund|payout|adjustment`), `external_line_id`, `gross_cents`/
`fee_cents`/`net_cents`, `currency`, `booking_date`, `payout_id`/`charge_id`/`invoice_id`/
`customer_name`/`customer_email`/`product_name`/`country_of_sale`. `unique
(source_document_id, external_line_id)` is the idempotent-reimport guarantee, mirroring
`transactions`' own `(account_id, idempotency_key)`.

`documents` gains a nullable `platform` column (`@/modules/intake`'s `SettlementPlatform`),
set only for `kind` `payout_report`/`platform_settlement` - a top-level duplicate of
`intakeResult.platform` (already stored there since F1a/F1b) purely for querying/indexing
without a jsonb scan, the same "duplicate onto a column for query convenience" precedent
`documents.kind` itself already set for `intakeResult.documentKind`.

`SETTLEMENT_LINE_TYPES`/`SettlementLineType` are defined directly in this schema file (like
`ACCOUNT_TYPES`/`CREDIT_DEBIT_INDICATORS` already are), NOT imported from `@/modules/accounts`
the way `documents.ts` imports `DOCUMENT_KINDS` from `@/modules/intake` - a judgment call:
`@/modules/accounts/core/schemas.ts` already imports back from
`@/persistence/repositories/contracts` (for `ACCOUNT_TYPES`/`CREDIT_DEBIT_INDICATORS`'s own
re-export), so a schema-to-module import here would complete a real circular import specific
to this module. `@/modules/accounts/core/settlement-lines.ts` keeps its own equal literal
type instead, the same "a pure core file uses its own literal union" precedent
`ImportableTransaction.creditDebit: "credit" | "debit"` already sets for
`CREDIT_DEBIT_INDICATORS`.

### 2. `buildSettlementLineDrafts`: one row can become up to three ledger entries

`@/modules/accounts/core/settlement-lines.ts`'s pure `buildSettlementLineDrafts` (no I/O)
reduces a report's `NormalizedSettlementLine[]` into `SettlementLineDraft[]`: a row with
`grossCents >= 0` yields a `revenue` draft (a credit), `grossCents < 0` yields a `refund`
draft (a debit, already negative); a non-zero `feeCents` yields its own `fee` draft (a debit,
`-abs(feeCents)`) regardless of the gross sign. A `payout` draft is synthesized ONCE PER
DISTINCT `payoutId` across the whole report (never read off a single row - neither the Stripe
nor the Apple fixture has a dedicated "payout" row), its amount the negative sum of every
`netCents` sharing that id, its `bookingDate` the latest booking date in that group (a
documented approximation - `SEMANTIC_FIELDS` has no distinct "payout effective date" field,
decisions/0020's closed vocabulary). `externalLineId` is `"<type>:row<rowNumber>"` for a
row-derived draft and `"payout:<payoutId>"` for a synthesized one - deterministic, so a
reimport of the identical document produces the identical ids.

### 3. Two `mapping-validator.ts` fixes this phase needed for correct settlement-line data

Both are corrective, backward-compatible fixes to F1a/F1b's own `validateMapping` (not new
behavior this ADR invents), discovered while building this phase's own unit test against the
REAL fake-classifier mapping (not a hand-trimmed one, unlike F1a's own existing test):

- **Shape discrimination**: `isBankTransactionMapping` used to treat any mapping with
  `bookingDate` as bank-shape - wrong the moment a settlement-report mapping ALSO maps
  `bookingDate` (Stripe's own real classifier rule does, via `created_utc`). Now: `amount`/
  `creditDebit` alone are still sufficient (every bank rule maps at least one); `bookingDate`
  alone is only bank-shape when no settlement-specific field (`gross`/`fee`/`net`/`payoutId`/
  `chargeId`) is present alongside it.
- **Indicator-column sign for `gross`/`net`**: a settlement-line row never ran through
  `resolveSignedAmount` at all, so an indicator-column source (Apple's "Sales or Return" S/R)
  had every row's `gross`/`net` parsed as positive text, silently importing a return as a
  sale. `rowSign()` now reads that indicator once per row and applies it to both `gross` and
  `net` (an indicator-column source describes the ROW's own direction, not one specific named
  column the way `signed_column`/`separate_credit_debit_columns` do - those two are left
  untouched, their sign is already literal in the text).
- **`NormalizedSettlementLine.description`**: `SEMANTIC_FIELDS` already had `description`
  (F1a), but the settlement-line branch never read it - added so a report with no dedicated
  invoice-number column can still be matched via free text, per this phase's own "invoice
  number in metadata/description first" rule (`matchSettlementLinesToDocuments`'s existing
  fallback, F3a).

### 4. Import: `AccountsUseCases.importFromDocument` branches on `documentKind`

Extended, not replaced: `documentKind === "payout_report" | "platform_settlement"` routes to a
separate private path (`importSettlementReportDocument`) that never touches
`ImportableStatement`/the bank-account resolution logic at all. It resolves (or creates) the
workspace's ONE clearing account for `doc.platform` (`AccountRepository.findByPlatform`, new -
**judgment call/known limitation**: no schema-level unique constraint on `(workspace_id,
platform)` for a clearing account, unlike `findByIban`'s real unique index; this phase relies
on always resolving through this method before creating one, an accepted trade-off mirroring
decisions/0024's own documented account-resolution races), builds every draft, inserts the
ledger transactions idempotently, re-resolves EVERY draft's transaction id (new or
already-known) via `TransactionRepository.findByIdempotencyKeys` (a plain "gross-and-net"
insert only returns what it actually inserted, `insertManyIdempotent`'s own established
contract), then inserts the settlement lines idempotently pointing at those transactions.
`documents-use-cases.ts`'s three existing `import-account-transactions` enqueue points
(camt.053, a known-fingerprint tabular confirm, and `confirmIntake` itself) now also cover
`payout_report`/`platform_settlement` (`isAccountsImportableKind`) - kept as the SAME job kind
(never a new one) specifically so that file never needs to know F4 exists at all.

Kicking this job promptly after a human confirms a proposal was a real, if latent, gap this
phase also fixed for every tabular kind, not only settlement reports:
`IntakeConfirmationPanel`'s "Bestätigen und importieren" now calls the same workspace-scoped
`kickAction` (`ProcessingPoller`'s own "kick", `after(() => runDueJobs(...))`)
`DocumentDetailClient` already threads down - previously, confirming relied entirely on the
cron sweep's own cadence to ever actually run the import job, which nobody had noticed for a
bank-statement CSV (its own "Importierte Daten" summary is written synchronously by
`confirmIntake` itself, independent of the import job) but would have made a settlement
report's clearing account/decomposition appear only after an unpredictable delay.

### 5. Payout-to-bank pairing, and the "bank line arrives later" call-back

`TransactionRepository.findUnpairedBankMatch` (new): payout id in the bank line's own
remittance text first, else amount-and-date proximity (a fixed 3-day window, `bank`-type
accounts only, `transferGroupId is null`) - the product owner's own fixed matching rule.
`tryPairPayout` sets the SAME new `transferGroupId` on both sides
(`TransactionRepository.setTransferGroup`) when found. Pairing is attempted at TWO points:
right after a settlement report's own import (for a payout whose bank deposit already
exists), and - the explicit brief requirement - at the END of every bank-statement import
(`importFromDocument`'s existing transaction block), via
`SettlementLineRepository.listUnpairedPayoutLines` re-trying EVERY still-unpaired payout in
the workspace, not only ones from the document just imported. This is a workspace-wide rescan
on every bank import (bounded by how many unpaired payouts realistically exist at once, a
small business's own scale) rather than a scoped "only new transactions" search, a
simplification accepted for this phase.

### 6. Matching: `PaymentsUseCases.matchSettlementReport`, a new job, not folded into `runMatching`

A settlement report's revenue-line transactions live on a `clearing` account -
`TransactionRepository.listForMatching`/`listUnmatched` now both exclude any `clearing`-account
transaction entirely (`accounts-repository.ts`'s own `notExists` join), so the ordinary
three-stage engine (`matchByRules`/`findSubsetSums`/the AI arbiter) never sees one at all. A
NEW job kind, `match-settlement-lines` (payload `{ workspaceId, documentId }`), enqueued by
`importSettlementReportDocument` whenever it inserts at least one new settlement line, calls
`PaymentsUseCases.matchSettlementReport`: loads the document's own `revenue` lines (skipping
one whose transaction already has a non-`rejected` `document_transactions` row - idempotent
across a retried job), maps them to F3a's own `SettlementLine` shape, and calls
`matchSettlementLinesToDocuments` against the workspace's open OUTGOING invoices. An
`invoice_number` match writes `document_transactions` straight to `confirmed`
(`matchedBy: "auto"`, `kind: "exact"`) - deterministic enough per the product model's own "match
1:1" wording; a `customer_amount_date` match is left `suggested` for a human to confirm
(weaker evidence, never auto-confirmed, the same "never an amount-only coincidence
auto-confirms" standard decisions/0023/0025 already established for the ordinary engine's own
stage 2).

### 7. Fee-invoice detection: a name heuristic, not (yet) a persisted alias

`attemptFeeInvoiceSettlement` (`payments-use-cases.ts`) runs at the START of both `runMatching`
(so an ordinary matching pass eventually catches a fee invoice that arrived before its report
did) and `matchSettlementReport` (so importing the report settles an already-confirmed fee
invoice immediately, not on the next cron pass): every open `incoming_invoice` document whose
resolved primary contact's name mentions a known platform
(`@/modules/payments`'s `isPlatformContactName`/`detectPlatformFromText`, a plain
case-insensitive substring match against each platform's canonical keyword, e.g. "stripe" for
Stripe) is a candidate; if that platform's clearing account has fee lines in the invoice's own
`documentDate` month (`SettlementLineRepository.sumFeeCentsForAccountAndPeriod`) that sum
within 3% of the invoice's total (`reconcileFeeInvoice`, the same default tolerance this
module already uses for a Skonto discount), the document is set `payment_status: "settled"`
directly (`derivePaymentStatus` never produces this value on its own, decisions/0023's
decision 8 - this is one of the two explicit direct-set cases, `core/settlement.ts`'s own
header comment already named this exact case).

**Scope cut, explicitly flagged by the brief's own wording ("alias-learned")**: this phase
does NOT persist a platform-contact mapping the way `payment_aliases` persists a learned
counterparty alias - there is no natural "confirm a suggestion" moment for a fee invoice to
learn from (it is never itself a bank transaction). The name heuristic is simple, testable, and
sufficient for the platforms this application already has a closed list of
(`SETTLEMENT_PLATFORMS`); a future phase could add a persisted, explicitly-confirmed mapping
once real vendor names show the heuristic needs it.

### 8. `MatchableTransaction.isPlatformPayout`: wired from real detection

`looksLikePlatformPayout` (`@/modules/payments/core/platform-detection.ts`): a BANK
transaction (never a clearing-account one, already excluded from the pool entirely, decision 6
above) whose counterparty name or remittance text names a known platform. Wired directly into
`payments-use-cases.ts`'s `toMatchableTransaction`, replacing F3b's hardcoded `false` -
`matchByRules`/`selectCandidateTransactions` already exclude `isPlatformPayout: true`
transactions per decisions/0023's own product decision, so this alone is what stops the
engine from ever proposing "this Stripe payout pays invoice X" against a lump-sum deposit.
`UnmatchedTransactionView.platformPayoutHint` (same detection, computed in the read model)
drives "Zuordnung"'s own "Umbuchung von &lt;Plattform&gt;: Auszahlungsbericht fehlt" hint in
place of the generic "keine Vorschläge" state whenever a detected payout has no report
imported yet, per the brief's own "period has no report yet" scope note - this is purely
informational (a link/text, never a suggestion a human confirms), so no estimate/subset-sum
computation was added on top of it for this phase (a documented simplification, not the
"clearly marked estimate" the brief mentions as a possible enhancement - left for a future
phase if real usage shows it is worth the added complexity).

### 9. UI

Clearing accounts need no bespoke list view - `/dashboard/finance`'s existing accounts list
already renders any `type`, and now shows a "Verrechnungskonto" badge plus a
"Guthaben bei der Plattform" caption in place of a formatted IBAN (which a clearing account
never has). A report document's own detail page shows a new `SettlementReportSection`
(revenue/fee/refund/payout decomposition via `decomposeSettlement`, computed at read time -
never persisted, the same "derive, don't duplicate" convention this codebase already applies
to `documents.paymentStatus`'s own display upgrade) and every settlement line with its match
status - "Rechnung fehlt" for an unmatched revenue line, a link to the matched/suggested
document otherwise. The document's own kind/platform badges (`SettlementPlatforms` i18n
namespace, already present before this phase for the confirmation panel's own platform
`<select>`) now also render on the confirmed detail view.

## Consequences

- Positive: the entire settlement-line derivation (`buildSettlementLineDrafts`) and every new
  pure detection/reconciliation helper (`looksLikePlatformPayout`, `isPlatformContactName`,
  `reconcileFeeInvoice`) are unit-tested against F1a's real Stripe/Apple fixtures routed
  through the real fake-classifier mapping end to end, not hand-trimmed test-only mappings -
  which is exactly what surfaced decision 3's two mapping-validator bugs before they reached
  a real import.
- Positive: excluding `clearing`-account transactions from `listForMatching`/`listUnmatched`
  at the repository level (decision 6) means the ordinary three-stage engine's own code never
  needed to learn about settlement lines at all - the boundary is enforced once, in SQL.
- Negative: decision 7's name-heuristic fee-invoice detection and decision 8's UI-only
  "Umbuchung von..." hint (no estimate) are both documented scope cuts, not full
  implementations of everything the brief's product model describes as possible - flagged
  above as named follow-ups.
- Negative: `findByPlatform`'s lack of a schema-level uniqueness guarantee (decision 4) means
  a race between two concurrent settlement-report imports for the same NEW platform could, in
  principle, create two clearing accounts - accepted for this phase's scale (one report import
  at a time is the realistic case for a small business), the same class of trade-off
  decisions/0024 already accepted for its own account-resolution races.
- Negative: `importSettlementReportDocument`'s payout `bookingDate` (the latest booking date
  among a payout group's own rows) is an approximation, not `automatic_payout_effective_at_utc`
  itself - `SEMANTIC_FIELDS` has no field for it (decisions/0020's closed vocabulary);
  accepted, since it only affects the payout-pairing date window, not any amount.
- Implementation status: **implemented**. Schema (`settlement_lines`, `documents.platform`),
  `@/modules/accounts`'s `buildSettlementLineDrafts`, `AccountsUseCases`'s settlement-report
  import and payout-pairing, `@/modules/payments`'s `platform-detection.ts` and
  `matchSettlementReport`/`attemptFeeInvoiceSettlement`, the `match-settlement-lines` job, the
  `SettlementReportSection`/finance-list/Zuordnung UI, and the `IntakeConfirmationPanel` kick
  fix all land in this phase, covered by unit tests (settlement-line derivation against real
  fixtures, platform detection, fee-invoice reconciliation), one real-Postgres+MinIO
  integration test (idempotent import, invoice-number revenue matching, fee-invoice
  settlement, payout-to-bank pairing including "bank line arrives later"), and one
  `@smoke`-tagged e2e spec.

## Supersedes / Superseded By

- None
