# Direction from kind, and short invoice numbers: two defects found on one real invoice

Document type: decision
Lifecycle: active
Owner: src/modules/documents, src/modules/payments
Scope: Adding `documents.kind` (and, as a last resort, a deterministic own-company-in-text
check) as more reliable signals ahead of the model's per-party role hints when deciding a
document's direction, and a narrow keyword-gated exception letting a short, bare invoice
number be found in a bank transaction's remittance text
Canonical responsibility: Active source for why `decideDirection` takes `kind`/`documentText`
in addition to `parties`/`ownCompany`, the exact priority order between the four signals, and
why `findInvoiceNumbers`' digit-only floor now has a keyword-gated exception
Maintenance triggers:
- The direction priority order changes, or a new signal is added
- The invoice-number-keyword list changes
- decisions/0021's or decisions/0023's own direction/text-signal decisions are revisited
Last verified: 2026-09-21, initial version

## Status

Accepted

## Context

Investigating a real invoice that failed to match its bank transaction (decisions/0025's
payment matching) surfaced two independent, narrow defects in code decisions/0021 and
decisions/0023 (R1) had already shipped.

**Defect 1**: `decideDirection(parties, ownCompany)`
(`src/modules/documents/core/direction.ts`) decided a document's direction ONLY from the
model's own `parties[]` and their `role` labels: it needed a party `isOwnCompany` matched
whose role was `sender` or `recipient`. Three consecutive analyzer runs of the SAME real
outgoing invoice, with the SAME prompt and model (`ministral-8b-latest`), produced three
different, mutually inconsistent party lists:

- Run 1: the workspace's own GbR correctly labeled `sender`, the customer `recipient` -
  correct parties, but `isOwnCompany` still failed to match at the time because the
  workspace's stored name was stale.
- Run 2: the same parties, plus an unrelated third party ("musterfirma").
- Run 3: the CUSTOMER labeled `sender`, the workspace's own company not in the list AT ALL,
  plus a different unrelated third party ("MUSTERBANK PAYMENTS").

Every run resolved `direction = unknown`, which cascades into `payment_status =
not_applicable`, which excludes the document from payment matching entirely
(`payments-use-cases.ts` only ever considers a document whose direction is
`incoming`/`outgoing`) - even though a transaction matched it exactly on invoice number and
amount.

Meanwhile `documents.kind` - decided by a SEPARATE classifier call
(decisions/0020-universal-intake.md/decisions/0022-intake-wiring.md's `IntakeClassifier`, or a
self-identified format like ZUGFeRD) - was `outgoing_invoice` in every single run. The OCR
text itself also reliably contained the workspace's own company name and postal code in the
letterhead. Both are more reliable signals than the model's own per-party role labels turned
out to be for this document.

**Defect 2**: `src/modules/payments/core/text-signals.ts`'s `MIN_DIGIT_ONLY_TOKEN_LENGTH = 5`
(R1's own hardening, decisions/0023) means a short, real invoice number like "12" can never be
found in a remittance text, so decisions/0023's auto-confirm condition ("the invoice number
appears in the remittance text AND the amount matches") can never fire for it, no matter how
good the amount match is. A real bank transaction's remittance text read literally
"Re.Nr. 12 vom 02.07.25 Beratung und Hosting" - the invoice number is right there, immediately after
an unambiguous keyword, but the 5-digit floor rejected it outright regardless of that context.

## Decision

### 1. `decideDirection` gains two more inputs, tried in strict priority order

`decideDirection(parties, ownCompany, kind, documentText)` (`kind: DocumentKind | null`,
`documentText: string | null`, both required - a caller must pass `null` explicitly rather
than silently omitting a signal it does have):

1. An own-company party's own role hint (unchanged from decisions/0021): a party
   `isOwnCompany` matches with role `recipient` -> `incoming`; with role `sender` ->
   `outgoing` (checked second, on purpose - a reply thread listing the workspace in both
   roles reads as incoming). The strongest signal when it is actually present, and it wins
   even when `kind` would suggest something else.
2. Otherwise, `kind`: `outgoing_invoice` -> `outgoing`; `incoming_invoice`/`reminder` ->
   `incoming`. Any other kind carries no direction signal of its own.
3. Otherwise, a deterministic text check: does the own company's name (normalized via
   `@/modules/contacts`'s `normalizeName`, reused rather than duplicated) or its postal code
   appear anywhere in `documentText`, AND is exactly one party marked `sender`? If so, the
   own company is the (unlisted) recipient -> `incoming`. Weakest signal, and it replaces
   decisions/0021's old, structurally-only fallback ("we are absent, and there is exactly one
   OTHER party marked sender") - that old rule invented a direction from party COUNT alone,
   with no evidence the document actually concerns the workspace at all; this one requires an
   actual textual match first.
4. Otherwise -> `unknown`, exactly as before. A direction is never invented when none of the
   three signals resolves it.

`src/persistence/use-cases/documents-use-cases.ts`'s `processOcrDocument` now computes `kind`
BEFORE the real `decideDirection` call (a self-identified ZUGFeRD invoice still needs its own
`kind` decided first via a party-only direction guess -
`decideDirection(parties, ownCompany, null, null)`, unchanged from before this ADR - and every
other OCR'd document's `kind` comes from the classifier, independent of direction), then
passes that `kind` and the document's own full OCR text into the real, priority-ordered
`decideDirection` call.

### 2. A narrow, keyword-gated exception to the digit-only invoice-number floor

`findInvoiceNumbers` keeps R1's `MIN_DIGIT_ONLY_TOKEN_LENGTH = 5` floor for a BARE digit-only
candidate (that floor exists precisely because a short number like "2026" collides with the
year inside an ordinary German date, and that risk has not gone away). The exception:
a digit-only candidate under that floor is still accepted when it appears in the remittance
text immediately after one of a small, closed set of invoice-number keywords - `Re.Nr.`,
`Re-Nr`, `RechnungsNr`, `Rechnungsnummer`, `Rechnung`, `RG`, `RN`, `Inv`, `Invoice` - tolerant
of spacing, dots, colons, and hyphens between the keyword and the number (all already
stripped by `normalizeToken`'s existing normalization, so no separate matching logic was
needed for that tolerance) and case-insensitive. The same word-boundary-after-the-number
requirement as the bare case still applies (the candidate must not be a mere prefix of a
longer digit run) - only the LEADING boundary requirement is replaced by "a recognized keyword
sits there instead of a digit".

This is deliberately narrow: a generic "any word before a short number" rule was rejected as
too permissive (see decisions/0023's own R1 finding); gating on a specific, closed keyword
list keeps the false-positive surface small while still finding the real case.

## Consequences

- Positive: the observed real-invoice case (own company absent from `parties`, the customer
  mislabeled `sender`, a correct `kind`) now resolves `outgoing` instead of `unknown`, and its
  bank transaction can now auto-confirm once its short invoice number is found too - the two
  defects compounded on the SAME real document.
- Positive: both fixes are additive to existing, already-tested pure functions
  (`decideDirection`, `findInvoiceNumbers`) - no schema change, no new dependency, no change to
  what `unknown` means downstream (`payments-use-cases.ts`'s exclusion rule is untouched).
- Negative: priority 3's own-company-in-text check is a plain substring match on the company's
  normalized name or raw postal code - not a structured "party" match, so a company whose name
  happens to appear in running prose for an unrelated reason (rare, but not impossible) could
  still trigger it, exactly as narrowly scoped as its "priority 3, weakest" position implies.
- Negative: the two-letter keywords `RG`/`RN` in the invoice-number-keyword list carry a
  higher coincidental-match risk than the longer ones (`Rechnungsnummer`, `Invoice`, ...) -
  accepted since the exception only ever widens what `findInvoiceNumbers` can find (never
  narrows a previously-found match), and `matchByRules`' auto-confirm still separately requires
  a matching amount before this signal alone would ever auto-confirm anything.
- Implementation status: **implemented**. `src/modules/documents/core/direction.ts`'s
  `decideDirection`, its one call site in
  `src/persistence/use-cases/documents-use-cases.ts`'s `processOcrDocument`, and
  `src/modules/payments/core/text-signals.ts`'s `findInvoiceNumbers` all ship in this change,
  with unit tests covering all four direction priorities (including the exact observed case)
  and the keyword exception (including the exact observed remittance text).

## Supersedes / Superseded By
- None
