# src/modules/payments

Document type: reference
Lifecycle: active
Owner: src/modules/payments
Scope: The payment-matching domain layer's pure `core/` only (no I/O, no persistence, no UI,
no route): the three fixed matching stages (deterministic rules, arithmetic, an AI arbiter),
direction discipline, candidate preselection, `PaymentStatus` derivation, deterministic
learning helpers, safety checks, and F4's settlement-decomposition arithmetic
(decisions/0023-payment-matching.md, phase F3a)
Canonical responsibility: The single source for `MatchableTransaction`/`MatchableDocument`
(this module's own shape, not a re-export of `@/modules/intake`'s or a persistence row type),
`MatchReasonCode`/`MatchKind`/`PaymentStatus`'s `as const` sets, the auto-confirm predicate,
the Skonto tolerance formula, the subset-sum search, candidate scoring, and the
`PaymentArbiter` port's validation contract
Maintenance triggers:
- The stage order, the auto-confirm condition, or the default Skonto tolerance changes
- `resolveContactForCounterparty`'s rules change, or a second mechanism starts excluding a
  contact from matching (decisions/0068-supplier-clearing-accounts.md)
- A new `MatchReasonCode`/`MatchKind`/`PaymentStatus`/`MatchTrigger` value is added
- The redaction rule (what a member vs. an admin sees) changes
- The platform-detection keyword list or the fee-invoice tolerance changes
- The app-store payout-pairing window/subset-sum bound changes, or a third platform needs the
  same deterministic pairing (decisions/0048-app-store-reports.md)
Last verified: 2026-10-21, decisions/0071-a-card-charge-names-its-receipt.md: stage 1 reads
the reference after the asterisk of a card charge's statement descriptor ("FACEBK
*K3M9P2QX7R", `extractStatementReferences`) and finds it as a whole token in the document's
OCR text (`documentNamesStatementReference`, `MatchableDocument.referenceText`). With an exact
amount it counts like an invoice number in the remittance text (auto-confirm, no 45-day
window), under its own reason code `statement_reference_in_document`. The alias boost uses the
same signal, stage 2's corroboration check accepts it as a signal. Same day,
decisions/0072-correcting-a-document-s-kind.md: `PaymentsUseCases` gained
`discardOpenSuggestionsForDocument`, which deletes only that document's `suggested` rows
(confirmed links and rejections stay) when a human changes the document's kind. Same day,
decisions/0025's "A transaction is never allocated past its amount": `confirmSuggestion` and
`linkManually` throw `amount_exceeds_transaction` (and `confirmSuggestion` now also
`amount_exceeds_open`) instead of over-allocating; the suggestion stays `suggested`. Previously, 2026-10-03,
decisions/0066-abschluss-check-and-export.md: "Zuordnung" and
"Offene Posten" each gained an optional `?from=`/`?to=` date range (`@/shared/date-range`),
threaded through `listUnmatchedTransactionsProjection`/`listOpenItemsProjection` and
`PaymentsUseCases.listUnmatchedTransactions`/`listOpenItems` - Zuordnung filters on the
transaction's own `booking_date` (the date `countsForPeriod` scopes "Buchungen ohne Beleg"
by), Offene Posten on the document's shared effective date. Both pages state the active
period in German and offer a way to clear it. Omitted, both behave exactly as before, which
is what the document detail page's own suggestion lookup relies on. Previously, 2026-10-03,
decisions/0068-supplier-clearing-accounts.md: new pure module
`core/contact-resolution.ts` - `resolveContactForCounterparty`, which answers "which contact
does this bank counterparty name mean" from what this module already has (decisions/0047's
learned payment names first, then decisions/0046's card-merchant name comparison at the
existing `NAME_MATCH_THRESHOLD`), resolving to nothing when two contacts tie. Deliberately
not a new fuzzy matcher. `payments-use-cases.ts` uses it to stop proposing pairings in BOTH
directions for a contact that has a clearing account of its own (its documents never enter
the candidate pool, its transactions are filtered out of the transaction pool), calls
`AccountsUseCases.bookContactClearingEntries` through its existing accounts port at the start
of every run, gained `addAliasForContact` (an admin stating a payment name, since a contact
settled through a clearing account never produces a confirmation to learn one from), and its
end-of-run suggestion cleanup now also covers `settled` documents, not only `paid` ones.
Previously last verified: 2026-10-02, decisions/0066-abschluss-check-and-export.md:
`DocumentTransactionRepository` gained `countSuggestedForPeriod` - the Abschluss's "Offene
Zuordnungsvorschläge" item, the same `suggested` rows `countSuggestedForWorkspace` counts but
narrowed to suggestions whose transaction was booked inside the period. A real `count(*)`
over a join, nothing in this module's `core/` changed.
Previously last verified 2026-09-22, decisions/0048-app-store-reports.md: new pure module
`core/app-store-payout-matching.ts` - `planApplePayoutPairing` (one bank credit exact to the
cent, named "Apple", booked 0-120 days after the report's own period ends) and
`planGooglePayoutPairing` (a small subset-sum search over consecutive, not-yet-paid monthly
reports for each Google-named candidate credit). `payments-use-cases.ts`'s new
`attemptAppStorePayoutPairing` wires this (called from both `runMatching` and
`matchSettlementReport`, the same "both trigger points" shape `attemptFeeInvoiceSettlement`
already uses), writing straight to a `confirmed` `document_transactions` row in
`payment_auto_confirm` mode `system`/`all` (which alone is what removes that credit from
"Zuordnung"'s unmatched list - `listUnmatched`'s own `notExists` check already excludes any
transaction with a confirmed row, for any document kind) or a `suggested` one in mode `none`.
`MATCH_REASON_CODES` gained `platformPayoutMatched`; `kind: "collective"` is reused for both
Apple's single-document and Google's possibly-multi-document case (see that ADR for why).
Previously last verified 2026-09-21, G4 (decisions/0033-contradicting-invoice-number-vetoes-a-match.md):
`core/text-signals.ts` gained `extractInvoiceReferences`/`hasContradictingInvoiceReference` - a
remittance text explicitly naming a DIFFERENT invoice number than a candidate document's own
now VETOES the pair, enforced in `core/rules.ts`'s `matchByRules`, `core/arbiter.ts`'s
`validateArbiterResult`, and `payments-use-cases.ts`'s `aliasBoostSuggestions`/stage-2 candidate
filtering - fixing an observed false positive where the AI arbiter suggested a document whose
invoice number (38) contradicted the transaction's own remittance text ("Re Nr. 40"), noting
the contradiction in its own explanation and suggesting the match anyway. Previously, G3
(decisions/0031-direction-from-kind-and-short-invoice-numbers.md):
`core/text-signals.ts`'s `findInvoiceNumbers` gained a narrow, keyword-gated exception to R1's
5-digit floor for a digit-only candidate - a real bank transaction's remittance text
("Re.Nr. 38 vom 02.07.25 IT und Hosti") had a genuinely short invoice number ("38") that the
floor made permanently unfindable, so `matchByRules`'s auto-confirm could never fire for it
even with a matching amount. A short digit-only candidate is now also accepted when it is
directly preceded (tolerant of spacing/dots/colons/hyphens/case) by one of a small, closed set
of invoice-number keywords (`Re.Nr.`, `Re-Nr`, `RechnungsNr`, `Rechnungsnummer`, `Rechnung`,
`RG`, `RN`, `Inv`, `Invoice`) - the bare-number floor itself is unchanged, this is an addition,
not a relaxation. Previously, F5 (hardening, decisions/0027-hardening-and-deletion.md): no
change to this module's own pure `core/`; noted here only because
`src/persistence/use-cases/payments-use-cases.ts`'s `resolvePrimaryContact` (outside this
README's scope, in `src/persistence/`) now calls `documentContact.listForDocument` with an
explicit `workspaceId` - see `src/modules/contacts/README.md` for that fix. Previously, F4 (platform settlements, decisions/0026-platform-settlements.md):
`core/platform-detection.ts` (`looksLikePlatformPayout`, `isPlatformContactName`,
`reconcileFeeInvoice`) wires `MatchableTransaction.isPlatformPayout` from real detection
(replacing F3b's hardcoded `false`) and drives fee-invoice settlement;
`PaymentsUseCases.matchSettlementReport` (a new job, `match-settlement-lines`) finally wires
`core/settlement.ts`'s `decomposeSettlement`/`matchSettlementLinesToDocuments` against a
confirmed settlement report's own revenue lines; `SettlementReportSection`/`SettlementLineView`/
`SettlementReportView` add the report-detail UI. Previously, F3b (payment matching wiring,
decisions/0025-payment-matching-wiring.md) added `server.ts`/`client.ts`/`actions.ts` and this
module's own persisted schema (`src/persistence/schema/payments.ts`) - see "What F3b Added"
below for that picture.

## Purpose

Digipost's payment-matching engine answers one narrow question: **"Ist diese Rechnung
bezahlt?"** - not a general ledger, not DATEV export. Given a bank transaction (from a parsed
CAMT.053 statement or a bank CSV export, decisions/0020-universal-intake.md) and the
workspace's own open documents (incoming invoices we must pay, outgoing invoices a customer
must pay us, decisions/0021-extraction-direction-and-invoice-fields.md), it decides whether,
and how confidently, that transaction settles one or more of those documents.

This module (`src/modules/payments`) is the **domain layer only** for phase F3a: pure,
framework-free functions with no I/O, no database, and no UI - the same shape
`src/modules/contacts`/`src/modules/intake` took for their own first phase. It answers:

1. **Does an invoice number, customer number, or counterparty name appear where expected?**
   (`core/text-signals.ts`)
2. **Does a single transaction exactly (or within a Skonto discount) settle a single
   document?** (`core/rules.ts`, stage 1)
3. **Does a transaction settle a document partially, or several documents collectively?**
   (`core/arithmetic.ts`, stage 2)
4. **Which documents are even worth considering for a given transaction (or vice versa), out
   of potentially hundreds?** (`core/candidates.ts`, bounded to 20)
5. **For what remains ambiguous after stages 1-2, which of the (already bounded) candidates
   does an AI model think is most likely - and is that answer safe to trust?**
   (`core/arbiter.ts`, `core/fake-payment-arbiter.ts`, stage 3)
6. **What has a human already taught this workspace** (a counterparty alias, a rejected pair,
   a contact's confirmed payment channel)? (`core/learning.ts`)
7. **Is something worth a human's attention even outside the normal flow** (two payments for
   one invoice, a reminder that arrived after its invoice was already paid)?
   (`core/safety.ts`)
8. **How does a platform payout (Stripe, Apple, ...) - a lump sum, never matched directly
   against one invoice - decompose into the individual sales it actually paid for?**
   (`core/settlement.ts`, F4's own arithmetic)

`src/platform/mistral` implements this module's `PaymentArbiter` port against the real Mistral
API (`server/mistral-payment-arbiter.ts`), the same "a platform owns the adapter, a module owns
the port" pattern `@/modules/documents`'s `DocumentAnalyzer`/`OcrEngine` and
`@/modules/intake`'s `IntakeClassifier` already establish. See
`decisions/0023-payment-matching.md` for the full rationale, every judgment call, and what
remains for F3b.

## Public interfaces

`index.ts` (neutral entrypoint - domain-only):

- Types: `MatchableTransaction`, `MatchableDocument`, `MatchableDocumentDirection`,
  `MatchSuggestion`, `PaymentStatus`, `MatchTrigger`, `DocumentTransactionStatus`, `MatchedBy`.
- Enums: `MATCH_REASON_CODES`/`MatchReasonCode`, `MATCH_KINDS`/`MatchKind` (F3b added `manual`,
  for a human-picked pairing), `PAYMENT_STATUSES`/`PaymentStatus` (F3b added `not_applicable`,
  `documents.payment_status`'s own default for a non-invoice document), `MATCH_TRIGGERS`
  (F3b: why a `runMatching` call happened - `document_done`/`import_batch`/`cron`),
  `DOCUMENT_TRANSACTION_STATUSES`, `MATCHED_BY_VALUES`.
- F3b's own Server Action layer: `core/schemas.ts` (`decisionInputSchema`,
  `linkManuallyInputSchema`, `markNoDocumentNeededInputSchema`,
  `markSettledWithoutPaymentInputSchema`), `core/error-codes.ts`
  (`PAYMENT_ACTION_ERROR_CODES`/`PaymentActionErrorCode`), `core/view-types.ts`
  (`DocumentPaymentSection`, `MatchedTransactionView`, `SuggestionView`,
  `UnmatchedTransactionView`, `OpenItemView`/`OpenItemsView` - the already-redacted shapes the
  UI actually receives).
- Direction: `directionMatches`.
- Status: `derivePaymentStatus`, `DerivePaymentStatusInput`, `resolveDisplayStatus` (F3b:
  upgrades a stored `open`/`partially_paid` status to `overdue` for DISPLAY only, purely from
  the due date - `documents.payment_status` is never kept live-updated by a clock, see
  decisions/0025's decision 3).
- Text signals: `findInvoiceNumbers`, `findCustomerNumbers`, `counterpartyNameSimilarity`,
  `extractInvoiceReferences`, `hasContradictingInvoiceReference` (decisions/0033/G4: the
  contradicting-invoice-number veto, applied at all three matching stages; decisions/0038: a
  number phrase like "Re Nr. 34/ 24" is read leniently for the veto, every run counts, and
  strictly for the positive signal, first run only).
- Rules (stage 1): `matchByRules`, `isAutoConfirmMatch`, `isWithinSkontoTolerance`,
  `DEFAULT_SKONTO_TOLERANCE_PERCENT`, `MatchRuleOptions`, `AutoConfirmInput`.
- Arithmetic (stage 2): `findSubsetSums`, `partialPaymentFor`, `remainingOpenAmount`,
  `SubsetSumOptions`, `SubsetSumResult`, `PartialPaymentResult`.
- Candidates: `selectCandidateDocuments`, `selectCandidateTransactions`, `MAX_CANDIDATES`,
  `CandidateOptions`.
- AI arbiter (stage 3): `PaymentArbiter`, `PaymentArbiterInput`, `PaymentArbiterRawResult`,
  `validateArbiterResult`, `arbiterCacheKey`, `MAX_ARBITER_CANDIDATES`,
  `createFakePaymentArbiter`.
- Learning: `applyAliases`, `learnAliasFromConfirmation`, `filterRejectedPairs`,
  `rejectedPairKey`, `matchesLearnedChannel`, `ContactAliasMap`, `RejectedPairSet`,
  `PaymentChannelMap`.
- Safety: `detectDuplicatePayment`, `reminderAlreadyPaid`, `DuplicatePaymentWarning`.
- Settlement (F4): `decomposeSettlement`, `matchSettlementLinesToDocuments`, `SettlementLine`,
  `SettlementDecomposition`, `SettlementLineMatch`.
- App-store payout pairing (decisions/0048-app-store-reports.md): `planApplePayoutPairing`,
  `planGooglePayoutPairing`, `AppStoreReportSummary`, `BankCreditCandidate`,
  `AppStorePayoutPairing`.

## Structure

- `core/types.ts` - `MatchableTransaction`, `MatchableDocument`, `MatchSuggestion`, the
  `as const` enum sets. See "Public contract for F3b" below for exactly how F3b's own
  rows/schema map into these two shapes.
- `core/direction.ts` - `directionMatches`: the single place "never cross" is checked (an
  outgoing/negative payment only matches an incoming document, an incoming/positive payment
  only matches an outgoing one). Every stage imports this one function rather than
  re-deriving the condition.
- `core/payment-status.ts` - `derivePaymentStatus`: pure derivation from open/total amount and
  due date, never a freely-settable stored field. `overdue` wins over `partially_paid` when
  both would apply (decisions/0023's decision 8 explains why); `settled`/`no_document_needed`
  are manual-only overrides, never derived automatically.
- `core/text-signals.ts` - `findInvoiceNumbers`/`findCustomerNumbers` (tolerant to spacing,
  case, separators, and prefix noise: normalize both sides to letters+digits, then substring
  search; a digit-only candidate additionally needs at least 5 digits and a non-digit-bordered
  match, R1 - see "Known Limits" - UNLESS it is directly preceded by a recognized
  invoice-number keyword, decisions/0031/G3), `counterpartyNameSimilarity` (reuses
  `@/modules/contacts`'s `normalizeName`/`nameSimilarity` rather than duplicating name
  comparison), `extractInvoiceReferences`/`hasContradictingInvoiceReference` (decisions/0033/G4:
  every invoice number a remittance text explicitly names via the same keyword list, and the
  veto predicate built on it - a candidate's own invoice number not among the named references,
  when at least one was named, is a contradiction, never merely "not confirmed"),
  `extractStatementReferences`/`documentNamesStatementReference` (decisions/0071: the reference
  after the asterisk of a card descriptor, "FACEBK *K3M9P2QX7R", found as a whole token in the
  receipt's own text).
- `core/rules.ts` - stage 1: `matchByRules` (a whole-amount exact/Skonto match against a
  single document, requiring at least one corroborating signal - invoice number, IBAN, or
  name, or decisions/0071's card statement reference with an exact amount - never an
  amount-only coincidence, and now vetoing a candidate `hasContradictingInvoiceReference`
  flags before any of that logic runs, decisions/0033/G4), `isAutoConfirmMatch` (its own
  standalone, directly-tested predicate), `isWithinSkontoTolerance`.
- `core/arithmetic.ts` - stage 2: `findSubsetSums` (bounded `2^n` enumeration, `maxItems`
  default 15, reports `ambiguous` whenever more than one solution fits),
  `partialPaymentFor`/`remainingOpenAmount` (applying one payment to one document).
- `core/candidates.ts` - `selectCandidateDocuments`/`selectCandidateTransactions` (the
  mirrored direction: transaction -> documents, or an unmatched document -> transactions),
  bounded to `MAX_CANDIDATES` (20), amount used only for scoring/sorting, never for hard
  exclusion (see decisions/0023's decision 6 for why).
- `core/arbiter.ts` - stage 3's port (`PaymentArbiter`) and `validateArbiterResult`: the "AI
  proposes, code verifies" contract - a hallucinated document id, a cross-direction pick, a
  pick whose invoice number contradicts a reference the remittance text explicitly names
  (decisions/0033/G4), or more than `MAX_ARBITER_CANDIDATES` candidates are all
  rejected/thrown, and `autoConfirm` is hardcoded `false` on every AI-stage suggestion.
  `arbiterCacheKey` for F3b's own repeated-call avoidance.
- `core/fake-payment-arbiter.ts` - `createFakePaymentArbiter()`: deterministic (no
  randomness, no clock, no network), the same role `@/modules/intake`'s
  `createFakeIntakeClassifier`/`@/modules/documents`'s `createFakeDocumentAnalyzer` play.
- `core/learning.ts` - pure transforms over caller-provided `Map`/`Set` state: name aliases,
  rejected pairs, learned payment channels. This phase never calls these from anywhere real -
  F3b owns persisting and loading the actual state.
- `core/safety.ts` - `detectDuplicatePayment` (two direction-compatible transactions both
  naming the same document's invoice number), `reminderAlreadyPaid` (a reminder whose
  underlying invoice, matched by invoice number + contact, is already fully paid).
- `core/settlement.ts` - F4's own pure arithmetic: `decomposeSettlement`
  (gross - fees - refunds vs. the actual payout, in cents, reporting any discrepancy) and
  `matchSettlementLinesToDocuments` (invoice number first - a dedicated field or embedded in a
  free-text description - then customer name + amount + date proximity). Wired by
  `PaymentsUseCases.matchSettlementReport` (decisions/0026).
- `core/platform-detection.ts` - F4's own real detection: `looksLikePlatformPayout` (a bank
  transaction's counterparty name/remittance text naming a known platform -
  `MatchableTransaction.isPlatformPayout`'s real wiring, decisions/0023's own "Hooks for you"),
  `isPlatformContactName`/`detectPlatformFromText` (fee-invoice detection, a name heuristic -
  see decisions/0026's own "Scope cut" for why this is not (yet) a persisted alias),
  `reconcileFeeInvoice` (a two-sided percentage tolerance, same default as
  `DEFAULT_SKONTO_TOLERANCE_PERCENT`).
- `core/app-store-payout-matching.ts` (decisions/0048-app-store-reports.md) - the
  reconciliation goal: `planApplePayoutPairing` (exact-amount, platform-named,
  120-day-window single-document pairing) and `planGooglePayoutPairing` (a small subset-sum
  search over consecutive not-yet-paid monthly reports per candidate credit, claiming each
  report at most once). Deliberately NOT built on `@/modules/accounts`'s own `payoutId`-based
  `tryPairPayout`/`findUnpairedBankMatch` (a fixed 3-day window, and neither report has a
  `payoutId` column) - see that ADR for why a new, small mechanism was the right call here.
- `index.ts` - the neutral entrypoint every consumer (`src/persistence/use-cases/payments-use-cases.ts`,
  `src/platform/mistral`'s real arbiter adapter, and this module's own `server.ts`/`client.ts`/
  `actions.ts`) imports from.
- `server.ts` (F3b, extended F4) - `getDocumentPaymentSectionProjection`/
  `listUnmatchedTransactionsProjection`/`listOpenItemsProjection` (`server/read-models.ts`): the
  ONLY place that decides whether a caller's `finance.read` allows amount/counterparty fields
  into the response at all (never merely hidden in the UI - see decisions/0025's decision 4).
  F4 adds `getSettlementReportProjection` (a settlement report's own decomposition + per-line
  match status - admin-only surface already, so no redaction branch of its own).
- `client.ts` (F3b, extended F4) - `PaymentSection` (the document-detail payment widget),
  `ZuordnungClient` (`/dashboard/finance/zuordnung`'s table, now also showing "Umbuchung von
  &lt;Plattform&gt;" for a detected-but-unreported platform payout), and `SettlementReportSection`
  (F4: a confirmed settlement report's own decomposition/match-status table), from `ui/`.
- `actions.ts` (F3b) - `confirmSuggestionAction`/`rejectSuggestionAction`/`unlinkTransactionAction`/
  `linkManuallyAction`/`markNoDocumentNeededAction` (all `finance.manage`) and
  `markSettledWithoutPaymentAction` (`documents.write` - it never references a transaction,
  decisions/0025's decision 11).

## The Mistral adapter

`src/platform/mistral/server/mistral-payment-arbiter.ts` implements `PaymentArbiter` the same
way `mistral-intake-classifier.ts` implements `IntakeClassifier`: `mistralFetch` (reused,
unmodified), `mistralChatResponseSchema` (reused, unmodified), `temperature: 0`,
`response_format: { type: "json_object" }`. Its German system prompt lives in
`src/platform/mistral/server/payment-arbiter-prompts.ts` (kept separate from `prompts.ts`/
`intake-prompts.ts` - a different job, a different output shape), explicitly instructing the
model it is ranking a fixed candidate list, never searching for one of its own, and that the
transaction's remittance text is untrusted data, never an instruction (the same prompt-injection
mitigation decisions/0016/0020 already establish). Selection by `AI_PROVIDER` happens in
`src/platform/mistral/server/get-payment-arbiter.ts`, a getter kept separate from
`get-ai-adapters.ts`/`get-intake-classifier.ts` for the same reason those two are kept apart
from each other (see either file's own header comment); `getPaymentArbiter()`/
`resetPaymentArbiterForTests()` are re-exported from `src/platform/mistral/server.ts`. Note
that the adapter itself returns the RAW `PaymentArbiterRawResult` - it does not call
`validateArbiterResult` itself, so every `PaymentArbiter` implementation (real and fake alike)
is validated identically, in exactly one place, by whichever caller (F3b, or a test) invokes
`rank()`.

## Public contract for the persistence layer (implemented by F3b)

`src/persistence/use-cases/payments-use-cases.ts` maps its own persisted rows into this
module's types at the call site - this module still never imports `@/persistence/**` or
`@/modules/intake`'s exact field set:

- A bank-transaction row -> `MatchableTransaction`: `amountCents` signed (positive = money in,
  negative = money out, matching `@/modules/intake`'s `NormalizedTransaction` convention
  already), `remittanceText` the joined structured+unstructured remittance information exactly
  like `camt053-parser.ts`'s own `remittanceInformation`, `isPlatformPayout: true` for a
  transaction already identified as a Stripe/Apple/... payout (excluded from stages 1-3
  entirely, only ever fed to `core/settlement.ts`).
- A document row -> `MatchableDocument`: **`direction` must be `"incoming"` or `"outgoing"`
  only** - a document whose `documents.direction` column (decisions/0021) is still `"unknown"`
  must never be turned into a `MatchableDocument` at all (there is nothing for "never cross" to
  check against). `openAmountCents` starts equal to `Math.abs(totalAmountCents)` and is F3b's
  own responsibility to keep in sync as `partialPaymentFor`/`remainingOpenAmount` are applied.
- A settlement-report line -> `SettlementLine`: F3b maps `@/modules/intake`'s
  `NormalizedSettlementLine` (from `core/mapping-validator.ts`) into this module's narrower
  shape - only the fields `core/settlement.ts`'s arithmetic actually uses.
- The orchestration itself (try stage 1, then 2, then 3; persist a confirmed
  `MatchSuggestion`; load/save the learning maps) lives in `payments-use-cases.ts`'s
  `runMatching` - this module intentionally still has no single `matchPayment()` entrypoint of
  its own (decisions/0023's decision 1 explains why); `runMatching` is the F3b-owned
  orchestrator decisions/0023 always expected a later phase to write.

## Known Limits

- `core/candidates.ts`'s scoring formula (amount-difference-ratio weighted against
  day-distance) and `core/arithmetic.ts`'s "smallest-amounts-first" truncation when more open
  documents than `maxItems` exist are both judgment calls, not something the F3a brief
  specified precisely - tested for the properties that matter (never hard-excluding a
  legitimate partial/collective candidate by amount, deterministic ordering), but may need
  tuning once real data exists.
- `findInvoiceNumbers`'s tolerant substring matching can, in principle, false-positive on a
  short invoice number that happens to appear inside unrelated text - mitigated by requiring
  at least 4 normalized characters for an alphanumeric candidate, not eliminated entirely. A
  digit-only candidate (security review finding, R1, suspected/low: a bare "2026" matched the
  year inside "Rechnung vom 15.03.2026") needs a stricter bar instead of the generic 4-character
  floor: at least 5 digits AND no digit immediately bordering the match once normalized (so it
  is never merely a substring of a longer digit/date run) - see `core/text-signals.ts`'s
  `MIN_DIGIT_ONLY_TOKEN_LENGTH`/`hasDigitOnlyWordBoundaryMatch`. decisions/0031 (G3) added one
  exception to that 5-digit floor: a short digit-only candidate directly preceded by one of a
  closed invoice-number-keyword list (`hasKeywordPrecededDigitOnlyMatch`) is still found - the
  two-letter keywords in that list (`RG`, `RN`) carry a higher coincidental-match risk than the
  longer ones, accepted since the exception can only ever widen a match, and `matchByRules`
  still separately requires a matching amount before auto-confirming anything.
- `core/learning.ts`'s functions are unverified against any real persisted alias/rejection
  store until F3b lands and actually calls them from somewhere.
- `hasContradictingInvoiceReference` (decisions/0033/G4) can, in principle, veto a genuinely
  correct match if a candidate's invoice number happens to collide, once normalized, with a
  DIFFERENT real invoice number the text names by coincidence - accepted, since a false veto
  only ever falls back to "no suggestion, a human reviews it manually", while the false
  POSITIVE it replaces (the observed defect) silently marks an invoice paid that was not. It
  also inherits `RG`/`RN`'s own higher coincidental-match risk from decisions/0031's keyword
  list, for the same reason that decision accepted it: this can only ever widen what counts as
  a named reference, never invent a false match.

## What F3b Added

Schema/persistence for a matching decision (`src/persistence/schema/payments.ts`:
`document_transactions`, `payment_aliases`, `payment_rejections`, `payment_no_document_rules`,
plus `documents.payment_status`/`paid_at` and `transactions.no_document_needed`); the
`runMatching` use case actually orchestrating the three stages together, including the AI
stage's cache-key reuse and self-rescheduling (decisions/0025's decision 6); every decision
action (confirm/reject/unlink/manual link/"kein Beleg nötig"/"ohne Zahlung erledigt"); calling
`core/learning.ts`'s `applyAliases`/`learnAliasFromConfirmation`/`filterRejectedPairs` from real,
persisted state; wiring `getPaymentArbiter()` into `create-request-services.ts`; and the
permission-scoped UI (the document-detail payment section, the inbox status chip/filter,
`/dashboard/finance`'s "Zuordnung"/"Offene Posten" tabs). See
decisions/0025-payment-matching-wiring.md for the full rationale and every judgment call.

Not implemented yet: F4's platform-payout decomposition (`core/settlement.ts` stays unwired to
anything real), incremental/delta matching (each `runMatching` call rebuilds its candidate pools
from scratch, decisions/0025's decision 12), and a scored manual-link candidate list
(decisions/0025's decision 13).

## Dependencies on other owners

`@/modules/contacts` (`normalizeName`, `nameSimilarity`, `normalizeIban` - reused for name/IBAN
comparison rather than duplicated, per this phase's own instructions). F4 adds `@/modules/intake`
(the `SettlementPlatform` type only, for `platform-detection.ts`/`view-types.ts`) and
`@/modules/accounts` (the `SettlementLineType` type only, for `view-types.ts`'s
`SettlementLineView`).

## Consumers

`src/platform/mistral/server/mistral-payment-arbiter.ts` (implements this module's
`PaymentArbiter` port), `server/get-payment-arbiter.ts` (binds `createFakePaymentArbiter()` or
the real adapter by env), `server/payment-arbiter-prompts.ts` (imports `MatchableDocument`/
`MatchableTransaction` for its prompt-building functions). `src/persistence/use-cases/payments-use-cases.ts`
(the entire orchestration layer), `src/persistence/schema/payments.ts`/`documents.ts`/
`accounts.ts` (the enum columns), `src/app/(app)/dashboard/documents/[id]/page.tsx`,
`src/app/(app)/dashboard/page.tsx` (the inbox), and `src/app/(app)/dashboard/finance/**`
(the "Zuordnung"/"Offene Posten" tabs).

## Tests

Table-driven unit tests for every function above, no DB, no network (`pnpm test`):
`tests/payment-status.test.ts`, `tests/text-signals.test.ts` (the tolerant invoice-number
matching table across separators/case/prefix noise, the R1 digit-only-floor table,
decisions/0031/G3's keyword-exception table: the exact observed "Re.Nr. 38 vom 02.07.25 IT und
Hosti" text, "Rechnung 38"/"RG-38", a bare keyword-less "38" still rejected, and a keyword not
directly adjacent to the digits still rejected; and decisions/0033/G4's
`extractInvoiceReferences`/`hasContradictingInvoiceReference` table: the two real texts from
the observed defect, a customer-number keyword never producing a reference, a bare number and a
date-only text both empty, and a text naming two references), `tests/rules.test.ts` (the
2.9%/3%/3.1% Skonto boundary table, direction never crossing, the auto-confirm predicate table,
and decisions/0033/G4's contradicting-invoice-number veto - a rules-stage pair is never produced
for it, while the "Re.Nr. 38" auto-confirm case is untouched), `tests/arithmetic.test.ts`
(subset-sum exact/ambiguous/no-solution/tolerance cases, the 15-item performance bound, the
`maxItems`/`maxSolutions` bounding behavior), `tests/candidates.test.ts` (date window,
never-hard-excludes-by-amount, same-contact-first sorting, deterministic tie-breaking, the
mirrored document/transaction directions), `tests/arbiter.test.ts` (hallucinated id rejection,
cross-direction rejection, confidence clamping, `autoConfirm` always `false`, the
candidate-count guard, cache-key determinism, and decisions/0033/G4's exact observed case: a
0.9-confidence pick rejected for naming a contradicting invoice reference),
`tests/fake-payment-arbiter.test.ts`, `tests/learning.test.ts` (alias learning/application,
rejected-pair filtering including a collective suggestion, learned payment channels),
`tests/safety.test.ts` (duplicate payment detection, reminder-already-paid),
`tests/settlement.test.ts` (settlement decomposition in cents, invoice-number-first matching
including the description-embedded case, the customer+amount+date fallback and its own
rejection cases), and `tests/platform-detection.test.ts` (F4: platform name matching
case-insensitively against legal-entity-style names, `looksLikePlatformPayout`'s
counterparty-then-remittance-text fallback, `reconcileFeeInvoice`'s two-sided tolerance
table).

`src/platform/mistral/tests/mistral-payment-arbiter.test.ts`,
`tests/payment-arbiter-prompts.test.ts`, and `tests/get-payment-arbiter.test.ts` (owned by
`src/platform/mistral`, see that module's own README) cover the real adapter, its prompt, and
its env-based getter.

F3b's own orchestration/persistence tests live in `src/persistence/tests/` (this module's
`core/` stays domain-only, no DB import of its own): `payments-use-cases.test.ts` (`runMatching`
with fakes - auto-confirm, suggestion-only, alias corroboration, rejection filtering, the AI
cache-key reuse and the follow-up-job self-reschedule condition; decisions/0033/G4's exact
observed case, a contradicting-invoice-number transaction producing no suggestion at all while
the correct transaction still auto-confirms; every decision action and its guard rails), plus
`documents-use-cases.test.ts`/`accounts-use-cases.test.ts`'s own updated assertions for the two
`match-payments` trigger points.
`tests/integration/workflows/payments-matching.integration.test.ts` (real Postgres + MinIO):
a real camt.053 import whose remittance texts name two invoice numbers exactly -> both
auto-confirm and go `paid`; a transaction with no invoice-number signal whose amount equals two
open invoices combined -> one `collective` suggestion covering both, never auto-confirmed;
rejecting one leg is never re-proposed; a further run changes nothing (idempotent).
`tests/e2e/payments.spec.ts` (`@smoke`): an admin uploads an invoice and a matching camt.053
statement, confirms the resulting suggestion under "Zuordnung", sees "Bezahlt" on the invoice;
a plain member sees the same status but never an amount or a counterparty.

F4 (decisions/0026-platform-settlements.md, owned jointly with `@/modules/accounts` - see that
module's own README "Tests" section for the full list): `matchSettlementReport`/
`attemptFeeInvoiceSettlement`/the real `isPlatformPayout` wiring are covered by
`src/persistence/tests/payments-use-cases.test.ts`'s own updated fakes (no DB) and by
`tests/integration/workflows/settlement-import.integration.test.ts`/`tests/e2e/settlement.spec.ts`
(real Postgres/MinIO/browser).
