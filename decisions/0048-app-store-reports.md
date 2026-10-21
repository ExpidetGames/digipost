# App-store reports: two deterministic readers, and pairing their payout with the bank credit

Document type: decision
Lifecycle: active
Owner: src/modules/intake, src/modules/documents, src/modules/accounts, src/modules/payments
Scope: `sniffFileKind`'s quote-aware, quorum-based delimiter detection; the two new
self-identifying, deterministic readers for Apple's iTunes Connect payment summary and
Google Play's earnings report; how each report's kind/platform is chosen and how its lines
enter the platform's clearing account through the existing F4 settlement import; and the new,
bespoke Apple/Google payout-to-bank-credit pairing this phase adds because the existing F4
payout mechanism (a per-report `payoutId` column, a fixed 3-day pairing window) does not fit
either report's own shape or payment timing
Canonical responsibility: Active source for the real Apple/Google report formats this
application recognizes, why they are read deterministically instead of through the generic
AI-mapped tabular path, the exact field-mapping and payout/net-total rules each reader applies,
and the pairing rules that link a bank credit to the report(s) that explain it
Maintenance triggers:
- Apple's or Google's real export format changes (a column renamed, reordered, or added)
- A real English-locale Apple export is found (this phase's English header names are an
  unverified guess, see "Known limits")
- The Apple pairing window or the Google consecutive-run search bound needs revisiting
- A third app-store/marketplace report needs the same deterministic treatment
Last verified: 2026-09-22, initial version

## Status

Accepted

## Context

The owner uploaded two real monthly reports - Apple's "iTunes Connect - Zahlungen und
Finanzberichte" payment summary and a Google Play earnings CSV - and both were rejected at
upload. Root-cause analysis found two independent bugs in `sniffFileKind`
(`src/modules/intake/core/file-kind.ts`), the same "detect by content, never by name or
declared type" sniffer decisions/0020/0028 already build on:

1. **Apple's report has a ragged shape.** Its title row is one quoted cell embedding a literal
   tab before the reporting period (`"iTunes Connect - Zahlungen und
   Finanzberichte<TAB>(Januar, 2025)"`, comma count 12 including the trailing empty cells),
   followed by an empty row, the real header (comma count 11), four region rows (comma count
   11), an empty row, and a two-line footer (comma count 12) stating the payout total
   (`"58.20 EUR"`) and the payout account. `findConsistentDelimiter`'s old rule - literally
   every sampled line must share the FIRST line's own delimiter count - rejected the whole file
   outright the moment the first line (the title) disagreed with the rest.
2. **Google's report has a quoted comma.** Its dates are `"Jan 5, 2025"` - a comma INSIDE a
   quoted cell. The old delimiter count was a naive `line.split(delimiter).length - 1`, blind to
   quoting, so every data row's comma count came out one higher than the header's own count -
   again never "every line agrees."

Beyond the sniffing bug, once a file does sniff as CSV it lands on the generic
AI-mapped tabular path (decisions/0020's `IntakeClassifier`), which asks a model to propose a
column mapping and then validates it with `validateMapping`. That path's own `parseDateToIso`
(`core/mapping-validator.ts`) has no case for `"Jan 5, 2025"` either - a second, independent
reason Google's report would still fail even after the sniff is fixed. Rather than extend the
generic path for two formats that identify themselves exactly (an Apple export's own title
cell and header are as self-declaring as camt.053's XML namespace), this phase gives both
formats the same deterministic treatment decisions/0020 already established for camt.053 and
decisions/0028 for MT940: recognized by an exact structural signal, parsed with no model call
and no confirmation gate.

The owner's actual goal is not merely "accept the upload" - it is reconciliation: every
Apple/Google credit that has ever landed on the bank account should end up explained by the
report that produced it. `bank-platform-credits.txt` (every Apple/Google credit in the owner's
real, already-imported bank statements) shows Apple pays roughly two months after the period in
the EXACT amount its own report states, and Google pays around the middle of a later month, in
an amount that can cover more than one not-yet-paid month at once (the first real Google credit,
152.50 EUR on 2025-03-14, is not January's 30.10 EUR alone). decisions/0026's own payout
mechanism (`buildSettlementLineDrafts` synthesizing one `payout` draft per distinct `payoutId`,
`tryPairPayout`'s fixed 3-day amount-and-date window) was built against Stripe's own payout
report, which states its own `payoutId` per row; neither Apple's nor Google's report has any
such column, and even if one were invented, a 3-day window cannot express "roughly two months"
or "possibly several months." This phase therefore does not reuse `payoutId`/`tryPairPayout` at
all for these two platforms - it adds the minimum new mechanism their own shape and timing
actually need.

## Decision

### 1. `sniffFileKind`: quote-aware counting, a quorum instead of unanimity

`countPerLine` (`core/file-kind.ts`) now counts a delimiter only when it is OUTSIDE a
double-quoted span (a `"` toggles an "inside a quoted field" flag; two consecutive quotes,
RFC 4180's own escaped-quote convention, toggle it twice and correctly net to no change) -
Google's `"Jan 5, 2025"` no longer inflates its row's own count.

`findConsistentDelimiter` no longer requires every sampled line to agree: a delimiter "fits"
when at least `DELIMITER_QUORUM` (3) of the sampled lines - or every line, when there are fewer
than 3 - share the same POSITIVE count. Apple's own data rows (4 of them, all comma count 11)
and the blank separator rows (comma count 11 too, an all-empty row of the same width) reach
this quorum on their own; the title and footer rows, whose own counts differ, no longer
disqualify the file. Both real reports now sniff as `"csv"`. A pre-existing unit test that
exploited the OLD naive counter's blindness to quoting (a single quoted value spanning two
physical lines, whose two mismatched-but-individually-consistent naive counts happened to
agree) no longer applies under quote-aware counting - replaced with an equivalent construction
(a value spanning five physical lines, whose three fully-interior lines - the ones carrying no
quote character of their own - independently reach the quorum on their own) and its own new
test documenting why the OLD behavior was an accident, not a contract
(`src/modules/documents/tests/intake-upload-processing.test.ts`).

### 2. Two new deterministic readers, `src/modules/intake/core/`

**`apple-payment-summary.ts`** (`detectApplePaymentSummary`/`parseApplePaymentSummary`):
recognized by the title cell's own text (split on its literal tab into a title and a period)
matching one of two known strings, German `"iTunes Connect - Zahlungen und Finanzberichte"` or
an ENGLISH GUESS `"iTunes Connect - Payments and Financial Reports"` (see "Known limits" - the
owner's own report is German-only, so the English column names below are this reader's
best-effort guess, not a verified real export), AND one of the next few rows matching that
language's own exact 11-column header. The period comes from the title's own `"(Januar,
2025)"`/`"(January, 2025)"` (German and English month names). One `NormalizedSettlementLine`
per region row: `grossCents`/`netCents` from the "Gewinn"/"Proceeds" column (already converted
to the bank's own account currency by Apple's own stated exchange rate - this reader never
re-derives a conversion), `quantity` from "Verkaufte Einheiten"/"Units Sold", `countryOfSale`/
`description` from the region cell; `feeCents`/`payoutId` always `null` (see decision 4 below
for why no `payoutId` is invented). `bookingDate` is the period's own last calendar day for
every line - the report states no per-row date at all (the same "an approximation, not a real
per-row date" trade-off decisions/0026 already accepted for its own synthesized payout
`bookingDate`). The payout total/currency come from the footer cell (`"58.20 EUR"`, at the same
column index as "Gewinn"/"Proceeds"), falling back to the sum of every region's own proceeds
when the footer is missing or unparseable.

**`google-play-earnings.ts`** (`detectGooglePlayEarnings`/`parseGooglePlayEarnings`):
recognized by an exact 26-column header match (`Description`, `Transaction Date`, ...,
`Promotion ID`). `Transaction Type` decides each row's shape: `Charge`/`Refund` populate
`grossCents`; `Google fee`/`Google fee refund` populate `feeCents`; anything else (`Tax`, ...)
populates neither, an "adjustment" in decisions/0026's own sense - it still contributes to
`netCents` (always the row's own `Amount (Merchant Currency)`, whatever sign the source
states - this reader never flips a sign itself, including for `Google fee refund`, which the
source already states positive) but produces no ledger draft of its own
(`buildSettlementLineDrafts`'s own documented behavior for a row with neither field set).
`chargeId` is the order id (`Description`), `productName` from `Product Title`, `countryOfSale`
from `Buyer Country`. Dates are `"Jan 5, 2025"`, parsed by this reader's own
`parseGoogleDate` - never `mapping-validator.ts`'s `parseDateToIso`, which this format never
routes through at all. The report's own period is the month of its rows (the earliest month
present, for the pathological case of a file spanning more than one - not expected of a real
monthly export); its net total is the sum of every row's own signed amount.

Both readers are strict, the same "code verifies" standard decisions/0020 sets for the generic
path's own `validateMapping`: a row this application cannot fully parse throws a stable error
code rather than silently skipping or zeroing it (`APPLE_PAYMENT_SUMMARY_ERROR`/
`GOOGLE_PLAY_EARNINGS_ERROR`), surfaced as a `PermanentJobError` if it is ever reached at
processing time (`documents-use-cases.ts`) - which should only happen if the stored bytes no
longer match what detection already recognized, the same data-integrity reasoning
decisions/0028 already documents for its own MT940 re-parse checks.

### 3. Wiring: two new intake branches, before the generic tabular path

`decideIntakeBranch` (`src/modules/documents/core/intake-branch.ts`) gains
`"apple_payment_summary"`/`"google_play_earnings"`, checked right after `"mt940"` and before
the fingerprint-based `"tabular_known_source"`/`"tabular_unknown_source"` branches -
`processTabularDocument` (`documents-use-cases.ts`) computes both booleans from the decoded
text and dispatches to `processApplePaymentSummaryDocument`/`processGooglePlayEarningsDocument`
before ever touching the intake-fingerprint table. Both branches call
`deps.repos.document.markIntakeResult` with `intakeStatus: "confirmed"` immediately, no
model call and no human confirmation gate - the same rationale decisions/0020's decision 1 and
decisions/0028's decision 2 already give for camt.053/MT940: asking a model "what report is
this" when the file's own header already says so exactly would only add latency, cost, and
error for zero informational gain.

**Kind and platform.** Apple's summary states its own payout amount directly (the footer),
the same shape decisions/0026 already models as `payout_report` for Stripe; `platform: "apple"`.
Google's report is the platform's own earnings statement (charges, fees, refunds) with no
stated payout of its own at all - `platform_settlement`; `platform: "google"`. This is a
judgment call, not dictated by decisions/0020's kind list alone (that ADR's own context
sentence loosely groups "Apple, Google, PayPal, Amazon" together under `platform_settlement`)
but by what each report ACTUALLY states: a report is a `payout_report` when its own numbers
state a payout, `platform_settlement` when they only state activity.

**`TabularConfirmedIntakeResult.appStorePayout`** (`src/modules/documents/core/intake-result.ts`):
a new optional field - `{ platform, period, payoutAmountCents, payoutCurrency }` - set only by
these two readers, carrying the report's own authoritative payout/net total forward for the
pairing step (decision 5) without needing to re-derive it from settlement-line rows later (a
re-derivation that would risk silently diverging from Apple's own stated footer amount if a
future report's rows and footer ever disagree by a rounding adjustment no single row states).
Every other confirmed tabular source (the generic AI-mapped path) simply omits this field.

### 4. Import: through the existing F4 settlement path, with no `payoutId`

`AccountsUseCases.importFromDocument`'s existing `payout_report`/`platform_settlement` branch
(decisions/0026) already does exactly the job needed once a `NormalizedSettlementLine[]`
exists: resolve/create the platform's ONE clearing account, `buildSettlementLineDrafts`, insert
ledger transactions and settlement lines idempotently. No changes were needed there. `loadSettlementRows`
(`accounts-use-cases.ts`) gained one addition: it re-detects Apple/Google from the re-read
original bytes (mirroring camt.053/MT940's own re-detection-by-mimeType, adapted to content
detection since both formats share `text/csv` with every other tabular source) and calls the
matching reader directly, rather than falling through to the generic
fingerprint/`intake_result` fallback - both real fixtures are small enough that the fallback
would also have worked, but re-parsing from the original keeps this path correct even for a
report large enough to exceed `MAX_EMBEDDED_ROWS` in the future.

Deliberately, NEITHER reader ever sets `payoutId` on its lines. `buildSettlementLineDrafts`
synthesizes a `payout` draft by grouping rows by `payoutId` and summing their `netCents` -
exactly the wrong mechanism here: Apple's payout must be its own STATED total (the footer),
never a re-derived sum that could silently diverge from it, and neither report's per-row dates
have anything to do with the actual payout date (Apple's rows all carry the same
period-end approximation; Google's rows are dated across the whole month, weeks before the
actual payout). Both reports therefore import as plain revenue/fee/refund lines only - no
synthesized `payout` draft, no debit transaction on the clearing account for it - and
`tryPairPayout`'s existing per-draft pairing attempt (harmless, since there is no `payout`
draft to attempt it on) never even runs for these two platforms.

### 5. A new payout-to-bank-credit pairing, deliberately not `tryPairPayout`

`src/modules/payments/core/app-store-payout-matching.ts` (pure, no I/O):

- `planApplePayoutPairing(report, candidates)`: the one bank credit that is EXACT to the cent,
  named "Apple" (`textNamesPlatform`, the same keyword check `looksLikePlatformPayout` already
  uses), and booked strictly after the period's own last day, within
  `APPLE_PAYOUT_WINDOW_DAYS` (120) after it - the owner's own real data shows a 34-day gap for
  one payout, 120 days leaves ample room without ever reaching into the following month's own,
  differently-amounted payout. Zero or more than one candidate: no pairing (never guessed at).
- `planGooglePayoutPairing(reports, candidates)`: for each Google-named candidate credit, in
  booking-date order, tries increasing runs of CONSECUTIVE not-yet-paid reports starting from
  the oldest unclaimed one (1, then 2, then 3, ... up to 12) and stops at the first exact sum,
  requiring the candidate be booked after that run's own last period ends. A report a matched
  run claims is removed from consideration for every later candidate. "Consecutive" is
  structural (each period must be exactly the previous one's next calendar month) - a gap (an
  un-uploaded month) stops a run right there, the same way a real payout could never
  legitimately skip a month with no report.

`PaymentsUseCases.attemptAppStorePayoutPairing` (`payments-use-cases.ts`) wires this: every
confirmed Apple/Google report with no EXISTING `document_transactions` row at all (any status -
a human decision, or an already-open suggestion, is never silently second-guessed) against the
workspace's currently unmatched, positive bank credits (`TransactionRepository.listUnmatched`,
the same "Zuordnung" pool). Called from both `matchSettlementReport` (a report's own import
might already have its bank credit waiting) and `runMatching` (a bank statement import might be
exactly the event a still-unpaired report was waiting for) - the same "both trigger points"
shape decisions/0026's `attemptFeeInvoiceSettlement` already established, reused verbatim for
this new pass.

**Auto-confirm.** These matches are deterministic ("vom System erkannt"), so they follow the
workspace's `payment_auto_confirm` mode exactly like every other deterministic match
(decisions/0044): `system`/`all` write straight to a `confirmed` `document_transactions` row,
`none` leaves it `suggested`. Writing a `confirmed` row DIRECTLY IS what makes the bank credit
stop showing up in "Zuordnung"'s unmatched list - `listUnmatched`'s own existing `notExists`
check already excludes any transaction with a confirmed `document_transactions` row, for ANY
document kind, not only an invoice; no `transferGroupId`/`no_document_needed` write is needed
on top of it, unlike the older Stripe-shaped `tryPairPayout`/`findUnpairedBankMatch` mechanism
(which sets `transferGroupId` alone and, by itself, does NOT remove a paired payout from that
list today - a pre-existing gap this phase does not attempt to fix for Stripe, since it is out
of this phase's own scope, but is worth noting as the reason this phase chose a different
mechanism).

`kind: "collective"` is used uniformly, for BOTH Apple's always-single-document case and
Google's possibly-multi-document one: it is the one `MatchKind` `keepClosestSuggestions`'
date/amount-closest pruning already skips outright (a report carries no `totalAmountCents`/
`documentDate` of its own for that heuristic to reason about anyway, and a Google multi-report
pairing genuinely does need several `document_transactions` rows to survive together) and the
one `applyAutoConfirmPolicy`'s own per-row scan already never touches - this function decides
confirm-vs-suggest itself, directly, the same bypass `matchSettlementReport`'s own
invoice-number branch already uses for its own, equally deterministic case. This also happens
to satisfy decisions/0045's own "a collective suggestion needs every document to share the
transaction's counterparty" rule by construction: every linked report and the transaction it
pairs with all name the same platform.

## Consequences

- Positive: both real reports upload, process, and reconcile against the bank end to end, with
  no schema change and no new database table - `appStorePayout` is a plain optional field on
  the existing `intake_result` jsonb shape, and the pairing itself reuses the existing
  `document_transactions` table exactly as it already models "this document explains this
  transaction" for an invoice.
- Positive: `sniffFileKind`'s quote-aware, quorum-based delimiter detection is a general
  robustness fix, not app-store-specific - any future report with a differently-shaped preamble
  or footer row, or a quoted delimiter character, benefits the same way.
- Negative (known limit): Apple's ENGLISH header names (`HEADER_EN` in
  `apple-payment-summary.ts`) are an unverified guess - the owner's own real report is German
  only. If a real English export surfaces with different column names, detection for it will
  fail (falling through to the generic AI-mapped path, which still has its own, separate
  `parseDateToIso` gap for nothing this reader's own period format needs, so an English report
  would simply be rejected as unrecognized until a real fixture updates this table).
- Negative (known limit): Google's period resolution (`the earliest month present`) and the
  consecutive-run bound (12 months) are simplifications - a report genuinely spanning more than
  one calendar month, or a payout covering more than 12 months of backlog, are not expected of
  a real monthly export/regular payout cadence but are not specifically handled beyond these
  bounds.
- Negative (known limit): `planGooglePayoutPairing` takes the FIRST (smallest) covering run it
  finds per candidate credit; it does not search for a second, longer run that might also sum
  exactly and flag that as ambiguous. Considered acceptable: a coincidental second exact sum
  across a different-length consecutive run is a very narrow edge case for a small business's
  own scale.
- Negative (accepted, out of scope): the OLDER Stripe-shaped `tryPairPayout` mechanism still
  does not remove a paired payout from "Zuordnung"'s unmatched list (see decision 5) - noted
  here because implementing THIS phase's own pairing surfaced it, not fixed, since Stripe's own
  behavior is unrelated to this phase's scope.
- Implementation status: **implemented**. `sniffFileKind`'s fix, both new readers
  (`apple-payment-summary.ts`, `google-play-earnings.ts`), `intake-branch.ts`'s two new
  branches, `documents-use-cases.ts`'s two new processing functions,
  `intake-result.ts`'s `appStorePayout` field, `accounts-use-cases.ts`'s re-detection in
  `loadSettlementRows`, `src/modules/payments/core/app-store-payout-matching.ts`, and
  `payments-use-cases.ts`'s `attemptAppStorePayoutPairing` (wired into both `runMatching` and
  `matchSettlementReport`) all land in this phase, covered by unit tests (sniffing against both
  real fixtures, both readers against their own real fixtures with the owner's customer postal
  codes anonymized, the pairing arithmetic including the "needs February too" honest-non-match
  case, `buildSettlementLineDrafts` against both real fixtures, and one `payments-use-cases`
  test proving an Apple report and its bank credit end up linked in mode `system`) and a
  read-only proof script run against the owner's real reports and real imported bank
  statements in the local dev database (see the H6 agent's own final report for its output -
  not committed, a throwaway script per that task's own instructions).

## Supersedes / Superseded By

- None
