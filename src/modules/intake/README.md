# src/modules/intake

Document type: reference
Lifecycle: active
Owner: src/modules/intake
Scope: The universal intake recognizer's pure domain layer only (no I/O, no persistence, no
UI, no route): file-kind sniffing, self-identifying-format detection (camt.053, embedded
ZUGFeRD/Factur-X/XRechnung XML), the camt.053 parser, tabular sampling, the `IntakeClassifier`
port and its lenient output validation, the deterministic fake classifier, the mapping
validator, and content-level duplicate-detection helpers (decisions/0020-universal-intake.md,
phase F1a)
Canonical responsibility: The single source for the document-kind/settlement-platform/
semantic-field taxonomies (`DOCUMENT_KINDS`/`SETTLEMENT_PLATFORMS`/`SEMANTIC_FIELDS`), the
camt.053 normalization rules (batch-entry expansion, the idempotency key formula), the
CSV/TSV sampling and column-type-inference heuristics, and the "AI proposes, code verifies"
validation both `parseIntakeClassification` and `validateMapping` implement
Maintenance triggers:
- The document-kind taxonomy, settlement-platform list, or semantic-field list changes
- The camt.053 parser needs to support a namespace-prefixed message or a version outside
  02-08
- A new self-identifying tabular/XML/text format is added, or the MT940 field-mapping table
  changes
- Apple's or Google's real report format changes, or a real English-locale Apple export is
  found (decisions/0048-app-store-reports.md's own English header guess is unverified)
- This module gains `server.ts`/`client.ts`/`actions.ts` (still not needed as of F1b - see
  "What F1b Added" below)
- The idempotency-key algorithm (`core/idempotency-key.ts`) or its field order/version changes
Last verified: 2026-09-22, decisions/0048-app-store-reports.md added two more self-identifying,
deterministic readers - `core/apple-payment-summary.ts` (Apple's monthly "iTunes Connect -
Zahlungen und Finanzberichte" payment summary, recognized by its own title cell and header) and
`core/google-play-earnings.ts` (Google Play's monthly earnings report, recognized by its own
exact 26-column header) - and fixed `core/file-kind.ts`'s delimiter sniff to count outside
double quotes and accept a delimiter three sampled lines agree on rather than requiring
unanimity (both real reports' own title/footer rows, or a quoted comma, used to make them
sniff as `"unknown"`). See that ADR for the full field-mapping/payout-pairing rules.
Previously last verified 2026-09-21, decisions/0028-mt940-support.md added MT940 as a second
self-identifying, deterministic bank-statement format (`core/mt940-parser.ts`,
`core/file-kind.ts`'s `"mt940"` sniff) - see that ADR for the full field-mapping table and
this phase's other maintenance triggers above. Previously last verified 2026-09-20, F4
(platform settlements, decisions/0026-platform-settlements.md) fixed two bugs in
`core/mapping-validator.ts`'s settlement-line branch, found while building F4's own unit test
against the REAL fake-classifier mapping rather than a hand-trimmed one: `isBankTransactionMapping`
no longer misclassifies a settlement-report mapping as bank-shape just because it also maps
`bookingDate` (Stripe's own real mapping does); an `amountSign.mode === "indicator_column"`
source (Apple's "Sales or Return" S/R) now correctly flips the sign of `gross`/`net` per row -
previously never applied at all for a settlement-line row, silently importing every return as
a sale. `NormalizedSettlementLine` also gained `description` (the mapped `description` column,
when present - `SEMANTIC_FIELDS` already had it, this branch simply never read it). Previously,
R2 fixed a confirmed data-loss bug in the idempotency key (see "Idempotency key" below):
`core/idempotency-key.ts` is a shared helper used by both `camt053-parser.ts` and
`mapping-validator.ts`; F1b (decisions/0022-intake-wiring.md) added `parseTabularRows` and
`decodeTextBytes` to this module's own neutral entrypoint before that.

## Purpose

Digipost's intake is not only scanned paper mail: bank statements (CAMT.053 XML, bank CSV
exports), payment-provider payout reports (Stripe), platform settlement reports (Apple App
Store, Google Play), the company's own outgoing invoices, and anything else a small business
drops in, all go through the same intake. The guiding principle
(decisions/0020-universal-intake.md): **the file format only decides how we read the
content; what the content IS is decided by AI, at the content level, for every format
alike** - except a format that identifies itself unambiguously (camt.053 by its ISO 20022
XML namespace; ZUGFeRD/Factur-X by its embedded XML attachment), which is recognized
deterministically, never by asking a model.

This module (`src/modules/intake`) is the **domain layer only** for phase F1a: pure,
framework-free functions with no I/O, no database, and no UI, exactly the same shape
`src/modules/contacts` took for its own C1 phase. It answers:

1. **What kind of file is this, at the byte level?** (`sniffFileKind`)
2. **Does this file identify its own content unambiguously?** (`detectCamt053`,
   `extractEmbeddedXml`)
3. **If it is a self-identifying bank statement, what does it actually say?**
   (`parseCamt053`)
4. **If it is some other tabular file, what does a model need to see to guess its meaning?**
   (`sampleTabular`)
5. **Given that sample (or OCR text), what does the model think this is, and is its answer
   trustworthy?** (`IntakeClassifier`, `parseIntakeClassification`, the real Mistral adapter
   in `src/platform/mistral`, and `createFakeIntakeClassifier` for tests)
6. **Once a human confirms a proposed column mapping, does it actually hold for every row?**
   (`validateMapping`)
7. **Is this file, or this specific invoice, something we have already imported?**
   (`fileHash`, `semanticInvoiceKey`)

## Structure & Responsibilities

- `core/file-kind.ts` - `sniffFileKind(bytes)`: PDF/JPEG/PNG by magic bytes, XML by a
  `<?xml` prolog or root element (BOM-tolerant, UTF-8/UTF-16), MT940 by SWIFT tag lines at a
  line start (`:20:` plus at least one `:61:`, decisions/0028-mt940-support.md - checked before
  the CSV/TSV heuristic below so the two never get confused), CSV/TSV by a delimiter
  (`,` `;` `\t` `|`) whose occurrences outside double-quoted spans agree, on the same positive
  count, across at least 3 of the sampled lines (or every line, for a shorter sample) - a
  preamble/footer row of a different shape no longer disqualifies the whole file
  (decisions/0048-app-store-reports.md), else `"unknown"`. `detectEncoding(bytes)` (UTF-8 vs
  Windows-1252) is exported separately since it is useful to a caller independent of the
  overall kind decision.
- `core/xml-safety.ts` - `assertSafeXml`/`UnsafeXmlError`/`createSafeXmlParser`/
  `parseXmlSafely`: the XXE/entity-expansion gate every XML entry point in this module calls
  first. See its own header comment for why a text-scan gate, not a parser option, is what
  actually makes this safe against this exact `fast-xml-parser` version.
- `core/camt053-detect.ts` - `detectCamt053(xmlText)`: a namespace-pattern match
  (`urn:iso:std:iso:20022:tech:xsd:camt.053.001.0X`, versions 02-08), never a full parse.
- `core/embedded-xml.ts` - `extractEmbeddedXml(pdfBytes)`: walks a PDF's own
  `/Names/EmbeddedFiles` name tree (pdf-lib has no public read API for attachments, only
  `PDFDocument.attach` for writing them - see the file's own header comment) looking for
  `factur-x.xml`/`zugferd-invoice.xml`/`xrechnung.xml`, case-insensitively.
- `core/camt053-parser.ts` - `parseCamt053(xmlText)`: statements, opening/closing balances,
  and normalized transactions. A batch entry (`NtryDtls` with several `TxDtls`) expands into
  one `NormalizedTransaction` per `TxDtls`; an entry with no `NtryDtls/TxDtls` at all (a bank
  fee, say) produces exactly one transaction from its own Ntry-level fields. Only the
  common, unprefixed-default-namespace convention (`<Document
  xmlns="urn:iso:...">`) is supported - documented as a known limitation in the file's own
  header comment, not silently assumed. `camt053StatementReconciles` is a small pure
  reconciliation check (opening + sum(transactions) == closing). Each transaction's
  `idempotencyKey` is computed by the shared `core/idempotency-key.ts` helper - see
  "Idempotency key" below.
- `core/mt940-parser.ts` - `parseMt940(text)`: the second self-identifying, deterministic
  bank-statement format (decisions/0028-mt940-support.md). `Mt940Statement` is a plain type
  alias of `Camt053Statement`, and every transaction is the same `NormalizedTransaction`
  camt.053 produces, so `@/modules/accounts`'s mapper/import service/idempotency-key composite
  work unmodified for both formats. `mt940StatementReconciles` mirrors `camt053StatementReconciles`
  exactly. `MT940_MIME_TYPE` (`"application/vnd.mt940"`, MT940 has no formal IANA media type)
  is the one stable string `@/modules/documents`/`@/persistence` key their MT940-specific
  branching off. See decisions/0028-mt940-support.md for the full `:61:`/`:86:`/SEPA-tag
  field-mapping table, the credit/debit/reversal sign rule, and this file's own hard limits
  (`MAX_LINES`/`MAX_STATEMENTS`/`MAX_TRANSACTIONS`, `Mt940ParseError`/`MT940_ERROR`).
- `core/apple-payment-summary.ts` - `detectApplePaymentSummary`/`parseApplePaymentSummary`
  (decisions/0048-app-store-reports.md): Apple's monthly "iTunes Connect - Zahlungen und
  Finanzberichte" payment summary, a third self-identifying, deterministic format - recognized
  by its own title cell (a tab-separated report name and reporting period, in one quoted CSV
  field) and an exact 11-column header, in German or an unverified English guess. Produces one
  `NormalizedSettlementLine` per region row plus the report's own stated payout total/currency
  (its footer, or the sum of proceeds when the footer is missing).
- `core/google-play-earnings.ts` - `detectGooglePlayEarnings`/`parseGooglePlayEarnings`
  (decisions/0048-app-store-reports.md): Google Play's monthly earnings report, a fourth
  self-identifying, deterministic format - recognized by an exact 26-column header.
  `Transaction Type` (`Charge`/`Refund`/`Google fee`/`Google fee refund`/anything else) decides
  each row's `gross`/`fee`/neither shape; dates are `"Jan 5, 2025"`, parsed by this file's own
  `parseGoogleDate` (never `mapping-validator.ts`'s `parseDateToIso`, which this format never
  routes through).
- `core/idempotency-key.ts` - `normalizeReference`, `computeIdempotencyKeyV2`,
  `OccurrenceCounter`: the shared v2 idempotency-key algorithm both `camt053-parser.ts` and
  `mapping-validator.ts` use to compute `idempotencyKey` for a normalized bank transaction -
  see "Idempotency key" below for the full rationale, field orders, and known limits.
- `core/amount-parsing.ts` - `detectAmountFormat`/`parseAmountToCents`: German
  (`1.083,68`), US (`1,083.68`), and plain (`1083,68`/`1083.68`) decimal formats, majority-vote
  detected from a column of sample values, with a thousands-grouped value always winning
  over an ungrouped one (an unambiguous signal a plain value alone cannot give).
- `core/tabular-sample.ts` - `sampleTabular(text, options)`: header, up to 10 data rows, the
  total row count, a per-column type guess (`date`/`amount`/`iban`/`id`/`text`, with the
  detected date format or amount format attached), and a `fingerprint` (sha256 over the
  normalized header, delimiter, and column count) identifying this exact source layout
  across re-imports (decisions/0020's "confirm once, fingerprint the source" flow;
  `intake_source_fingerprints`, decisions/0022-intake-wiring.md, stores this verbatim).
  `parseTabularRows(text, { delimiter, quoteChar })` (F1b) parses every DATA row (not just
  `sampleTabular`'s bounded preview) using an already-known delimiter/quote - what
  `validateMapping`'s `fullRowsIterator` needs against the real, full-size file.
- `core/classification.ts` - the taxonomies (`DOCUMENT_KINDS`, `SETTLEMENT_PLATFORMS`,
  `SEMANTIC_FIELDS`), the `IntakeClassifier` port, and `parseIntakeClassification`: the
  lenient-parse-then-verify function both the real and fake adapters funnel their raw output
  through. Any column name a model's `columnMapping`/`amountSign` references that is not
  actually present in the sample's header is dropped, never trusted - the "code verifies"
  half of decisions/0020's "AI proposes, code verifies" principle.
- `core/fake-intake-classifier.ts` - `createFakeIntakeClassifier()`: recognizes this
  module's own test fixtures by header signature (Stripe, Apple, Sparkasse, Musterbank) for
  tabular input, and a small keyword table for OCR text input, exactly like
  `src/modules/documents/core/fake-document-analyzer.ts`'s own pattern. Selected by
  `AI_PROVIDER=fake` via `src/platform/mistral`'s `getIntakeClassifier()`.
- `core/mapping-validator.ts` - `validateMapping(sample, fullRowsIterator, mapping,
  amountSign, options?)`: applies a mapping to every row (not just the 10-row sample),
  strictly - every date must parse, every amount must parse, the amount-sign shape
  (`signed_column`/`separate_credit_debit_columns`/`indicator_column`) must actually hold
  per row, and an optional `expectedTotalCents` must reconcile. Any problem anywhere makes
  the whole result `{ ok: false, problems }`; otherwise it returns normalized
  `bank_transactions` (when the mapping targets bank-statement fields) or `settlement_lines`
  (payout/platform-settlement fields). A `bank_transactions` row's `idempotencyKey` is
  computed by the same shared `core/idempotency-key.ts` helper `camt053-parser.ts` uses, with
  a shorter field list (see "Idempotency key" below).
- `core/duplicate.ts` - `fileHash` (exact-file-duplicate, sha256 of the raw bytes; F1b's
  `POST /api/documents` computes this over the exact bytes about to be stored and
  `createFromUpload` rejects a match with `duplicate_document` before storage or the quota
  check) and `semanticInvoiceKey` (content-level "same invoice, different file" duplicate,
  sha256 of invoice number + normalized sender + amount; F1b's
  `@/modules/documents`'s `findSemanticDuplicate` uses this for the "möglicherweise doppelt"
  hint, computed live against `(workspace_id, invoice_number)`, never persisted as its own
  column).
- `core/file-kind.ts` also exports `decodeTextBytes(bytes)` (F1b): the same BOM-tolerant,
  UTF-8/Windows-1252-aware text decoding `sniffFileKind` uses internally, exposed so a caller
  that already knows a file is XML/CSV/TSV (the upload route, the processing job) can decode
  it the identical way without re-sniffing.
- `index.ts` - the neutral entrypoint every consumer (F1b's `src/modules/documents` and its
  persistence/route code, and `src/platform/mistral`'s real adapter) imports from.

## The Mistral adapter

`src/platform/mistral/server/mistral-intake-classifier.ts` implements `IntakeClassifier` the
same way `mistral-analyzer.ts` implements `DocumentAnalyzer`: `mistralFetch` (reused,
unmodified), `mistralChatResponseSchema` (reused, unmodified), `temperature: 0`,
`response_format: { type: "json_object" }`, and every parsed result funneled through this
module's own `parseIntakeClassification`. Its German system prompt lives in
`src/platform/mistral/server/intake-prompts.ts` (kept separate from `prompts.ts`, the
document-categorization prompt - a different taxonomy and output shape). Selection by
`AI_PROVIDER` happens in `src/platform/mistral/server/get-intake-classifier.ts`, a getter
kept separate from `get-ai-adapters.ts` rather than added to it (see that file's own header
comment for why); `getIntakeClassifier()`/`resetIntakeClassifierForTests()` are re-exported
from `src/platform/mistral/server.ts`.

## Idempotency key

Every normalized transaction this module produces (`NormalizedTransaction.idempotencyKey`
from `parseCamt053`, `NormalizedBankTransactionFromMapping.idempotencyKey` from
`validateMapping`) carries a stable `idempotencyKey` that `@/modules/accounts`'s
`TransactionRepository.insertManyIdempotent` uses verbatim as the natural upsert key
(`ON CONFLICT (account_id, idempotency_key) DO NOTHING`, decisions/0024-accounts-and-transactions.md).
Getting this key wrong means silent data loss: a colliding key on a re-import is
indistinguishable, at the database level, from a genuine duplicate, and the second row is
simply never inserted.

**R2 fixed a confirmed data-loss bug in the original ("v1") formula.** It picked "the most
specific reference" via `endToEndId ?? accountServicerReference ?? entryReference ??
remittanceInformation ?? ""`. ISO 20022 / German banks routinely emit the literal placeholder
`NOTPROVIDED` as `EndToEndId` when the underlying SEPA payment carried none. Since `??` only
falls through on `null`/`undefined` (never on a non-empty string), that placeholder WON over
every genuinely unique reference the entry actually had - two ordinary same-day, same-amount
transactions on the same account (two identical-amount direct debits, two transfers) were
enough to collapse onto the same key, and the second was silently dropped.

**The v2 algorithm** (`core/idempotency-key.ts`, deliberately named/versioned in code so a
future change to this formula is visible rather than a silent, undocumented drift) fixes both
halves of the bug:

1. `normalizeReference` maps every known "no reference" placeholder - `NOTPROVIDED`,
   `NOT PROVIDED`, `NONREF`, `NOREF` (case-insensitive, whitespace-collapsed-and-trimmed
   first) - plus a genuinely empty or whitespace-only value, to `null`, BEFORE it is ever
   compared or hashed. A placeholder can therefore never masquerade as "the" reference, and a
   whitespace/case variant of the same placeholder or the same genuine reference always
   normalizes identically.
2. The key hashes a composite of EVERY available discriminator, never "the first non-empty
   one" - two transactions differing in only one field (say `AcctSvcrRef`) now get different
   keys even when every other field, including a shared `NOTPROVIDED` `EndToEndId`, is
   identical.

The counterparty's name is read at both `RltdPties/<party>/Pty/Nm` (camt.053.001.04 and
later, where a related party is a choice type) and `RltdPties/<party>/Nm` (.001.02/.03), and
the agent's BIC at both `BICFI` and `BIC`: the accepted namespace range covers both shapes, so
the parser has to read both (decisions/0064-camt053-wraps-its-parties.md).

**Field order, camt.053** (`camt053IdempotencyKeyFields` in `core/camt053-parser.ts`): account
IBAN, booking date, value date, signed amount cents, currency, credit/debit, normalized
EndToEndId, normalized AcctSvcrRef, normalized NtryRef, bank transaction code, mandate id,
counterparty IBAN, normalized remittance text - in exactly that order.

**Field order, tabular mapping** (`tabularIdempotencyKeyFields` in
`core/mapping-validator.ts`): booking date, value date, signed amount cents, currency,
credit/debit, normalized EndToEndId, normalized reference/description, counterparty IBAN -
deliberately shorter than camt.053's list because a confirmed column mapping cannot provide an
own-account IBAN, `AcctSvcrRef`, `NtryRef`, a bank transaction code, or a mandate id
(decisions/0020's closed `SEMANTIC_FIELDS` vocabulary has no such columns at all).

**Remaining collisions: the occurrence index.** Even the full composite can still collide for
two entries that are genuinely indistinguishable by every field this application reads (the
fixture `camt053-notprovided.xml`'s two bank-fee entries: same day, same amount, same bank
transaction code, no `NtryRef`/`AcctSvcrRef`/counterparty on either). `OccurrenceCounter`
(one instance per `parseCamt053`/`validateMapping` call, i.e. per file) tracks how many times
an identical pre-hash composite has already been seen and folds that count into the hashed
input for the second, third, ... occurrence, so both rows still get distinct keys and both
survive the import instead of one silently vanishing.

**Known limitation (accepted trade-off):** occurrence numbering is only meaningful, and only
deterministic, within the boundary of one file. Two SEPARATE, overlapping partial exports of
the same statement period (say the same day re-exported twice, each containing one of two
otherwise-identical entries) may number a repeated entry differently across the two imports,
so the occurrence-index disambiguation does not, by itself, guarantee idempotency ACROSS
files for this specific edge case - a documented, deliberate trade-off against the original
bug's silent, undetectable data loss WITHIN a single file, not a claim that this scenario is
fully solved.

**Pre-production, no migration needed.** The key format changes from v1 to v2 with this fix.
No production data exists yet and no statement has ever been imported in this workspace, so
there is nothing to migrate: every `idempotency_key` value that will ever exist in the
`transactions` table is a v2 key from the moment this fix lands.

## Fixtures (`tests/fixtures/`)

All synthetic; no real bank, company, or person is represented.

- `camt053-valid.xml`: a plausible camt.053.001.02 statement, 6 entries (one a 3-`TxDtls`
  batch), a SEPA direct debit with mandate/creditor id, German umlauts in counterparty
  names, opening/closing balances that reconcile.
- `camt053-notprovided.xml`: R2's fixture for the idempotency-key fix - two same-day,
  same-amount entries both with `EndToEndId=NOTPROVIDED` but different `AcctSvcrRef`
  (must get different keys), plus two bank-fee entries identical across every field this
  parser reads (must get different keys via the occurrence index).
- `malicious-xxe.xml` / `malicious-billion-laughs.xml`: an external-entity and an
  entity-expansion-chain attack, both rejected by `assertSafeXml` before any parser ever
  sees them.
- `musterbank-statement.csv`: `;`-delimited, German decimal-comma amounts including one
  thousands-grouped value (`1.083,68`).
- `sparkasse-statement.csv`: modeled on the publicly documented Sparkasse "Umsatzanzeige"
  CSV export column layout (`Auftragskonto`, `Glaeubiger ID`, `Mandatsreferenz`, ...),
  `;`-delimited, quoted fields.
- `stripe-payout.csv`, `apple-financial-report.tsv`: the exact column layouts specified for
  this phase (Stripe's payout-reconciliation export; Apple's App Store financial report),
  including a refund row and a "Return" (`R`) row respectively, to exercise
  `separate_credit_debit_columns`-adjacent and `indicator_column` amount-sign handling.
- `mt940-valid.mt940` (decisions/0028-mt940-support.md): a realistic German MT940 export, two
  statements, several `:61:`/`:86:` pairs, structured `?20`-`?29` remittance parts with
  `EREF+`/`SVWZ+`/`MREF+`/`CRED+` SEPA tags, German umlauts in a counterparty name, a `NONREF`
  customer reference, a reversal (`RC`) mark, a `:86:` record wrapped across multiple physical
  lines, and balances that reconcile on both statements.
- `mt940-valid-cp1252.mt940`: a byte-for-byte Windows-1252 encoding of the same statement -
  proves `decodeTextBytes` round-trips its umlauts correctly.
- `mt940-malformed.mt940`: sniffs as MT940 (has `:20:`/`:61:`) but its one `:61:` line cannot be
  parsed at all - proves the parser skips it and still returns the statement (0 transactions)
  rather than throwing.
- `mt940-duplicate-shaped.mt940`: mirrors `camt053-notprovided.xml`'s own idempotency-key
  fixture - two same-day, same-amount debit fee lines with different `//` bank references (must
  get different keys without help), plus two entries identical across every field this parser
  reads (must get different keys via the occurrence index).
- `apple-payment-summary.csv`, `google-play-earnings.csv` (decisions/0048-app-store-reports.md):
  synthetic reproductions of the real iTunes Connect payment summary and Google Play
  earnings export formats (same columns, delimiters, quoting and number formats; invented
  order ids, app names, amounts and `00000` buyer postal codes).

## Known Limits

- The idempotency key's occurrence-index disambiguation (see "Idempotency key" above) is only
  deterministic within one file: two separate, overlapping partial exports of the same
  statement period may number a repeated, otherwise-identical entry differently across the
  two imports. Accepted trade-off, not a claim this specific edge case is fully solved.
- `parseCamt053` only supports the unprefixed default-namespace convention
  (`<Document xmlns="urn:iso:...">`); a namespace-prefixed message (`<Doc:Document
  xmlns:Doc="...">`) is not recognized. Not observed among this product's target banks.
- `mapping-validator.ts`'s slash-date parsing (`MM/DD/YYYY`) always assumes US month-first
  order; a European `DD/MM/YYYY` slash-dated source would need explicit disambiguation this
  module does not attempt (the tabular sources this application targets that use slash
  dates - Stripe, Apple - are always US-formatted).
- `validateMapping`'s reconciliation check only runs when the caller supplies
  `expectedTotalCents`; most tabular payout/settlement formats carry no such total at all,
  so this is best-effort, not a universal guarantee.
- `sampleTabular`'s CSV/TSV dialect detection (delimiter, quote character) is heuristic, run
  over a bounded prefix of the file - a source with a genuinely unusual dialect (an
  uncommon quote character, inconsistent column counts even in valid data) may need a
  caller-supplied `SampleTabularOptions.delimiter` override.
- `extractEmbeddedXml`'s PDF `/Names/EmbeddedFiles` name-tree walk (security review finding,
  R1) is bounded, not exhaustive: a `PDFRef` is only ever expanded once (closing off both a
  DAG - two parents sharing one child - and a genuine cycle), the walk never recurses past 32
  levels, and it never does more than 256 total node-visits-plus-`/Names`-entries across the
  whole tree. A legitimate ZUGFeRD/Factur-X/XRechnung PDF is nowhere near any of these bounds
  (a handful of entries, one or two levels deep); a name tree that IS this deep/wide/cyclic is
  itself a strong signal of a malicious file, and the function degrades to "attachment not
  found down that path" for it rather than throwing or hanging. An embedded file whose
  declared or already-read size exceeds 10 MB is skipped before its stream is decoded, so an
  oversized or compression-bomb-shaped attachment is never inflated into memory. Worth
  revisiting for ADR 0020's successor if a legitimate source ever needs a deeper/larger tree
  than these bounds allow (none observed so far).
- `parseMt940` (decisions/0028-mt940-support.md): a non-IBAN `:25:`/`?31:` account
  identification (a German bank-code/account-number pair) is dropped rather than surfaced
  anywhere else - the same limitation `parseCamt053` already has for a statement using
  `<Othr>` instead of `<IBAN>`. SEPA `KREF+`'s customer reference is parsed but has no
  `NormalizedTransaction` field to land in (the shared camt.053 shape is fixed by design - see
  the ADR's "reuse camt.053" decision). Only the unprefixed, un-namespaced SWIFT tag grammar
  every fixture and a typical Musterbank export use is specifically tested; a message
  using SWIFT conventions beyond the `{1:}{2:}{3:}{4:}{5:}` envelope this parser already strips
  is not.
- `apple-payment-summary.ts` (decisions/0048-app-store-reports.md): the English header names
  (`HEADER_EN`) are an unverified guess - the one real report seen was German only. A real
  English export with differently-named columns will not be recognized until a real fixture
  updates this table.
- `google-play-earnings.ts` (decisions/0048-app-store-reports.md): resolves a report's own
  period to the earliest month among its rows, for the (not expected) case of a report
  spanning more than one calendar month.

## What F1b Added (decisions/0022-intake-wiring.md)

Everything this README originally deferred is now implemented, entirely in
`src/modules/documents`/`src/persistence/**` (this module itself gained only the two small
exports named above): `documents.kind`/`file_hash`/`intake_status`/`intake_result` and the
`intake_source_fingerprints` table, `POST /api/documents` accepting XML (camt.053 only)/CSV/TSV
alongside PDF/JPEG/PNG (still capped at 4 MB per request - a structured file large enough to
need a chunked/streamed path is a known, still-unaddressed limitation, same as before), the
processing job's branching between OCR/camt.053/tabular-known/tabular-unknown, the confirmation
UI and its Server Actions, the admin-only `/dashboard/settings/intake` fingerprint list, and
both duplicate checks wired into the actual upload/detail-view code paths. See
decisions/0022-intake-wiring.md and `src/modules/documents/README.md` for the wiring itself;
this module's own domain layer and its "Known Limits" above are unchanged by that phase.
