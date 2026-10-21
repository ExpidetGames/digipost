# MT940 support: a second self-identifying, deterministic bank-statement format

Document type: decision
Lifecycle: active
Owner: src/modules/intake
Scope: Why SWIFT MT940 joins camt.053 as a deterministically-recognized, self-identifying
bank-statement format (never routed through the AI classifier), the exact structural
detection rule, the German `:86:` subfield-to-`NormalizedTransaction` mapping table, the
credit/debit/reversal sign rule, encoding, this phase's hard limits, and the file-picker bug
this phase also fixes
Canonical responsibility: Active source for `src/modules/intake/core/mt940-parser.ts`'s field
mapping and known limits, and for why `ui/upload-form.tsx`'s file picker no longer restricts
uploads by file extension
Maintenance triggers:
- The MT940 field-mapping table changes, or a new `:86:` subfield/SEPA tag is recognized
- The hard limits (`MAX_LINES`/`MAX_STATEMENTS`/`MAX_TRANSACTIONS`) are revisited
- A real-world MT940 export is found that this parser mishandles
Last verified: 2026-09-21, initial version

## Status

Accepted

## Context

Two real bank statements exported from a bank (a CAMT.053 v08 XML and an
MT940 text file) and neither could be uploaded. Root-cause analysis found two independent
bugs, both fixed by this phase:

1. **The upload was rejected purely client-side.** The server already sniffs a file's real
   content by bytes (`sniffFileKind`) and never trusts its extension - `detectCamt053`
   correctly recognized the CAMT.053 v08 file's namespace. But `ui/upload-form.tsx`'s file
   `<input accept="...">` attribute ended in `.csv,.tsv,.xml`, so the OS file picker hid a file
   whose extension was `.camt053v08` (a version-suffixed extension some banks use) before it
   ever reached the server. The server was never wrong; the picker second-guessed it.
2. **MT940 had no support at all.** `sniffFileKind` returned `"unknown"` for it (a plain-text,
   tag-based format with no XML namespace and no consistent CSV/TSV delimiter), so the upload
   failed with `unsupported_file_type` regardless of the file picker.

Beyond fixing the immediate bug, MT940 is common enough among German banks (and is one of two
export formats Musterbank itself offers, alongside CAMT.053) that first-class, deterministic
support is worth building the same way decisions/0020-universal-intake.md already built it for
CAMT.053.

## Decision

### 1. The file picker stops deciding what is acceptable

`ui/upload-form.tsx`'s `<input type="file">` no longer has an `accept` attribute at all. The
server sniffs real content by bytes and never trusts a file's extension or declared MIME type
either way (decisions/0020's own principle) - an `accept` list can only ever HIDE a file the
server would have handled correctly, never add safety, and there is no realistic way to
enumerate every extension a bank might use (`.camt053`, `.camt053v08`, `.mt940`, `.sta`,
`.txt`, ...) up front. Drag-and-drop already had no such filter (`addFiles` never inspected
`dataTransfer.files` by extension), so nothing needed to change there. The visible German hint
text (`Scan.description`/`Scan.dropzone`, "PDF, JPG, PNG, Kontoauszug als CAMT.053-XML, MT940
oder CSV") is what actually communicates what is supported, updated to name MT940 explicitly.

`STRUCTURED_FILE_PATTERN` (used only for the client-side "file too large, export monthly
statements instead" hint, shown before the file ever reaches the server) is broadened from
`/\.(xml|csv|tsv)$/i` to `/\.(xml|csv|tsv|mt940|sta|txt|camt053(v\d+)?)$/i` to cover the same
extensions. **Judgment call**: `file_too_large` is decided purely by byte count, before the
server ever sniffs the file's content (`src/app/api/documents/route.ts`'s
`readRequestBodyWithByteCap`/`Content-Length` check runs first) - there is no server-reported
"kind" to key this specific hint off, so the file name remains the only signal available for
it. Every other upload error already comes from the server's own content sniff and needs no
name-based heuristic.

### 2. MT940 is the second self-identifying, deterministic format

Mirroring decisions/0020's "one deliberate exception" for camt.053: a structurally
self-identifying format is recognized deterministically, never by asking a model. MT940's
structural signal is unambiguous - `sniffFileKind` (`core/file-kind.ts`) adds a new `"mt940"`
`FileKind`, detected by a plain-text scan for SWIFT tag lines at a line start: `:20:`
(Transaction Reference Number, mandatory, always the first field) plus at least one `:61:`
(Statement Line). This tolerates:

- A leading SWIFT block-header envelope (`{1:...}{2:...}{3:...}{4:` ... `-}`/`{5:...}`) some
  banks emit - stripped before the line-start check.
- Either CRLF or LF line endings.
- A trailing lone `-` record terminator (needs no special handling - it never itself starts
  with `:`, so it never interferes with the tag-line scan).

Checked in `sniffFileKind` right after the XML check and before the CSV/TSV delimiter
heuristic: an MT940 file's tag lines have no consistent per-line delimiter count of their own
(so it would never accidentally sniff as CSV/TSV), and a real CSV/TSV/XML export never contains
a line starting with `:20:`/`:61:` (so this ordering never mis-sniffs one format as the other) -
proven by dedicated tests (`mt940-parser.test.ts`'s "does NOT detect a CSV/XML file as MT940").

Once sniffed, MT940 is treated exactly like camt.053 end to end: `processIntakeUpload`
(`@/modules/documents`) fully parses it (bounded by this parser's own hard limits, §5 below) and
rejects a genuinely malformed or absurdly oversized file at upload time with a clear German
message, rather than deferring to a `failed` processing job; `decideIntakeBranch`
(`@/modules/documents/core/intake-branch.ts`) gains an `"mt940"` branch alongside `"camt053"`;
`processDocument` dispatches to it by the document's own stored MIME type
(`@/modules/intake`'s `MT940_MIME_TYPE`, `"application/vnd.mt940"` - MT940 has no formal IANA
media type, so this application picks one vendor-tree identifier and uses it consistently);
`kind` is always `"bank_statement"` and `intake_status` is always `"confirmed"` immediately, no
model call and no human confirmation gate (decisions/0020, decision 1's own rationale: asking a
model "is this a bank statement" when the file already says so structurally would only add
latency, cost, and error for zero informational gain). `AccountsUseCases.importFromDocument`
gains the identical MT940 branch for re-parsing on import.

### 3. Reuse camt.053's own normalized shape - no MT940-specific mapping code downstream

`Mt940Statement` (`core/mt940-parser.ts`) is a plain type alias of `Camt053Statement`, and every
MT940 transaction is normalized into the exact same `NormalizedTransaction` shape camt.053
produces. This is deliberate, not incidental: it means `@/modules/accounts`'s
`mapCamt053StatementsToImportable`, the accounts import service, the idempotency-key v2
composite, and the reconciliation check all work on an MT940 statement completely unmodified -
no second mapping function, no MT940-specific branch anywhere outside
`src/modules/intake/core/mt940-parser.ts` and the two dispatch points named above.
`mt940StatementReconciles` is a one-line wrapper around `camt053StatementReconciles` (same
arithmetic: opening balance plus the sum of every transaction's signed amount equals the
closing balance), kept as a separate export purely so a caller/test reaches it under a name
that matches this format, per this ADR.

### 4. Field-mapping table

**Structural parsing** (`tokenizeFields`/`groupIntoStatements`): the file is split into SWIFT
tag lines (`:NN:` or `:NNA:` at a line start) plus their continuation lines; `:20:` starts a
new statement group (a file may concatenate several MT940 messages, "multiple statements per
file"). `:86:`'s own "wraps at 65 characters" convention is exactly this same continuation
mechanism - every continuation line collected for one field is joined with **no separator**
before its subfields are parsed, reconstructing the original unwrapped content.

| MT940 field | Content | Maps to |
|---|---|---|
| `:20:` | Transaction Reference Number | `statementId` fallback (when `:28C:` is absent) |
| `:25:` | Account Identification (IBAN, or a German bank-code/account-number pair like `10020030/1234567`) | `accountIban` - **only when IBAN-shaped** (`^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$`, shape only, no mod-97 checksum); a non-IBAN identification is dropped, not surfaced elsewhere (see "Known limits") - the document then falls into `@/modules/accounts`'s existing "pending account" flow exactly as decisions/0024 already describes for a tabular source with no own-account IBAN |
| `:28C:` | Statement Number/Sheet Number (e.g. `00001/001`) | `statementId` |
| `:60F:`/`:60M:` | Opening balance: `C`/`D` mark, `YYMMDD`, 3-letter currency, comma-decimal amount | `openingBalance` (`Camt053Balance`, `type` kept as the raw MT940 tag, e.g. `"60F"` - MT940's Final/Intermediate distinction is not camt.053's Booked/Available one, so no forced translation between the two vocabularies) |
| `:61:` value date | `YYMMDD` | `valueDate` |
| `:61:` entry date | Optional `MMDD` | `bookingDate`, year resolved against the value date's own year with a rollover guard (a booking month more than 6 months from the value date's month is assumed to fall in the adjacent calendar year); falls back to the value date itself when absent |
| `:61:` D/C mark | `C`/`D`/`RC`/`RD` | `creditDebit` - `C`→credit, `D`→debit; a reversal (`R` prefix) **flips** the base mark (`RC`→debit, `RD`→credit) |
| `:61:` funds code | Optional single letter before the amount | Consumed, not otherwise used (rare; only meaningful for a non-default currency) |
| `:61:` amount | Comma-decimal digits | `amountCents` (magnitude; sign from the mark above) |
| `:61:` transaction type | `N` + 3 further characters (`NTRF`, `NDDT`, `NMSC`, ...) | First component of `bankTransactionCode` |
| `:61:` customer reference | Up to 16x; `NONREF` is a documented placeholder | `entryReference`, kept raw (normalized to `null` only inside the idempotency-key composite, via the existing `normalizeReference`/`PLACEHOLDER_REFERENCES` - `NONREF` was already in that set) |
| `:61:` `//`bank reference | Up to 16x, after `//` | `accountServicerReference` **fallback** - only used when `:86:`'s Primanota (`?10`) is absent, see below |
| `:61:` supplementary details | Optional continuation line, up to 34x | Appended to `remittanceInformation` (`"; "`-joined) - no dedicated field exists for it in the shared `NormalizedTransaction` shape |
| `:86:` leading digits before the first `?nn` | German "Geschäftsvorfallcode" (business transaction code), e.g. `:86:105?00SEPA` | Second component of `bankTransactionCode` |
| `:86:` `?00` | Booking text (Buchungstext) | Third component of `bankTransactionCode` |
| `:86:` `?10` | Primanota (the bank's own internal document number for this booking) | `accountServicerReference` - **takes priority** over `:61:`'s `//` bank reference (Primanota plays the same "bank's own reference for the entry" role camt.053's `AcctSvcrRef` does) |
| `:86:` `?20`-`?29`, `?60`-`?63` | Remittance parts | `remittanceInformation` - concatenated **in order, with no separator** (that is what German banks intend: the embedded SEPA tags, not whitespace, are what actually separates one logical piece from the next) |
| `:86:` `?30` | Counterparty BIC | `counterpartyBic` |
| `:86:` `?31` | Counterparty account/IBAN | `counterpartyIban` - **only when IBAN-shaped**, same rule and rationale as `:25:` above |
| `:86:` `?32`/`?33` | Counterparty name | `counterpartyName` - concatenated with no separator, overridden by an embedded `ABWA+` tag when present (see below) |
| `:86:` `?34` | Text-key extension (Textschlüsselergänzung) | Fourth component of `bankTransactionCode` |
| `:86:` with no `?nn` subfield at all | Unstructured free text | `remittanceInformation` verbatim |
| SEPA `EREF+` (inside the concatenated remittance text) | End-to-end reference | `endToEndId` |
| SEPA `MREF+` | Mandate reference | `mandateId` |
| SEPA `CRED+` | Creditor id | `creditorId` |
| SEPA `ABWA+` | A different originator/payer name than `?32`/`?33` | `counterpartyName` override (preferred when present - more specific about who the money actually came from/went to) |
| SEPA `KREF+`, `SVWZ+` | Customer's own reference; the free-text Verwendungszweck | Parsed (`parseSepaTags`) but not surfaced as a separate field - `SVWZ+`'s content is already part of `remittanceInformation` verbatim (it is one of the concatenated `?2x`/`?6x` parts), and `KREF+` has no corresponding `NormalizedTransaction` field (see "Known limits") |

`bankTransactionCode` is the `"/"`-joined concatenation of whichever of [`:61:` transaction
type, `:86:` GVC, `:86:` `?00` booking text, `:86:` `?34` text-key extension] are actually
present (e.g. `"NTRF/051/GUTSCHR/000"`) - mirrors camt.053's own `Domn/Fmly/SubFmlyCd`-style
joined code, `null` when none of the four parts exist at all.

**Idempotency key**: the same v2 algorithm (`idempotency-key.ts`) and the exact same field
order as camt.053's own `camt053IdempotencyKeyFields` - deliberately, so a bank offering both a
camt.053 and an MT940 export of the same underlying statement produces the same keys either
way (both describe the identical underlying transaction). One `OccurrenceCounter` per
`parseMt940` call, shared across every statement in the file, for the same reason camt.053's
own parser scopes it that way.

### 5. Hard limits (in the spirit of the R1 review)

`parseMt940` never loops unbounded on a pathological file - it rejects absurd input early with
one of three stable `Mt940ErrorCode`s, never an unclassified exception:

- `mt940_too_many_lines` - more than 200,000 lines (checked immediately after splitting the
  text, before any field-level work).
- `mt940_too_many_statements` - more than 1,000 `:20:` groups.
- `mt940_too_many_transactions` - more than 50,000 `:61:` entries across the whole file.

These are deliberately generous relative to the 4 MB upload cap (a real file anywhere near
these limits would have to consist almost entirely of pathologically short lines) - they exist
as a defensive backstop, not a limit any legitimate export is expected to approach. An
individual malformed `:61:` line (one this parser cannot make sense of at all - no leading
6-digit value date, or no recognizable `C`/`D`/`RC`/`RD` mark) is instead **skipped**, not
thrown: a partially-corrupt file still yields whatever it can legitimately parse rather than
failing the whole document (`tests/fixtures/mt940-malformed.mt940` proves this).

### 6. Encoding

German MT940 exports are frequently Windows-1252/ISO-8859-1, not UTF-8 (the same reality
decisions/0020's own CSV/TSV path already handles). No new encoding logic was needed: `parseMt940`
takes already-decoded text, and `@/modules/intake`'s existing `decodeTextBytes`/`detectEncoding`
(UTF-8-first, falling back to Windows-1252 the moment decoding produces a replacement
character) already handle this correctly for MT940 too - proven by
`tests/fixtures/mt940-valid-cp1252.mt940`, a byte-for-byte Windows-1252 encoding of the same
statement as the UTF-8 fixture, umlauts intact end to end.

## Consequences

- Positive: the file-picker bug (§1) is fixed for every current and future bank-export
  extension at once, not just the two named in the bug report - the server's own content sniff
  was always correct; nothing about it needed to change.
- Positive: MT940 support required zero new code anywhere downstream of
  `src/modules/intake/core/mt940-parser.ts` and its two dispatch points - the shared
  `NormalizedTransaction`/`Camt053Statement` shape did exactly the job decisions/0020 designed
  it to do.
- Negative (known limits, accepted): a non-IBAN `:25:`/`?31:` account identification (a German
  bank-code/account-number pair) is dropped rather than surfaced anywhere - the same limitation
  camt.053's own parser already has for a statement using `<Othr>` instead of `<IBAN>`, not a
  new gap this phase introduces. `KREF+`'s customer reference is parsed but has no
  `NormalizedTransaction` field to land in (the shared shape is fixed by decisions/0020's own
  "reuse camt.053, no new fields" design goal) - a future phase could add one if a real need
  shows up. The occurrence-index idempotency-key disambiguation inherits camt.053's own
  documented cross-file limitation (two separate, overlapping partial exports of the same
  period may number a repeated, otherwise-identical entry differently across the two imports).
  `parseMt940` only supports the unprefixed, un-namespaced tag grammar every fixture and the
  product owner's own Musterbank export use (`:NN:`/`:NNA:` tags) - a message using SWIFT's optional
  namespace/network-header conventions beyond the `{1:}{2:}{3:}{4:}{5:}` envelope this parser
  already strips is not specifically tested.
- Implementation status: **implemented**. `core/mt940-parser.ts` (parser, hard limits,
  `MT940_MIME_TYPE`), `core/file-kind.ts`'s `"mt940"` sniff, `@/modules/documents`'s upload-route
  wiring (`intake-upload-processing.ts`), `intake-branch.ts`'s `"mt940"` branch,
  `documents-use-cases.ts`'s `processMt940Document`, `accounts-use-cases.ts`'s MT940 re-parse
  branch, the file-picker fix (`upload-form.tsx`), and new/updated German copy all land in this
  phase, covered by unit tests (parser fixtures including a CP1252 variant and a malformed one,
  sniffing, branching, the upload route, `processDocument`, and the accounts import),
  `.integration.test.ts` coverage against real Postgres/MinIO through the actual `POST
  /api/documents` route (an MT940 upload end to end, a duplicate rejection, an
  empty/unparseable-file rejection, the accounts import with correct signs/counterparties, and
  a CAMT.053 v08 file uploaded under a bank-specific extension proving name-independence), and
  one e2e spec extension (`tests/e2e/finance.spec.ts`, the same account/amounts as the existing
  camt.053 test, uploaded under a real Musterbank-style `.mt940` extension).

## Supersedes / Superseded By
- None
