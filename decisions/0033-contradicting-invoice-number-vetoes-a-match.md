# A contradicting invoice number vetoes a match

Document type: decision
Lifecycle: active
Owner: src/modules/payments
Scope: `extractInvoiceReferences`/`hasContradictingInvoiceReference`
(`src/modules/payments/core/text-signals.ts`) and the veto they enforce in every one of the
three matching stages
Canonical responsibility: Active source for why a remittance text naming a different invoice
number than a candidate document is strong negative evidence enforced in code, not left to the
AI arbiter's own judgement, and exactly what is deliberately NOT vetoed by it (a missing
invoice number, a customer number, several named references)
Maintenance triggers:
- The invoice-number-keyword list (decisions/0031) changes
- A fourth matching stage is added
- A real false-positive shows the veto itself is too strict (vetoes a legitimate match) or too
  loose (misses a genuine contradiction)
Last verified: 2026-09-21, initial version

## Status

Accepted

## Context

An outgoing invoice number `12` (480,00 EUR) was correctly auto-confirmed against its
real bank transaction ("Re.Nr. 12 vom 02.07.25 Beratung und Hosting"), exactly as
decisions/0031-direction-from-kind-and-short-invoice-numbers.md intended. But a SECOND,
unrelated transaction was also suggested for the same document by the AI arbiter, at
confidence 0.9:

- transaction: 2025-11-14, 905,00 EUR, counterparty "BAUWERK GENERALBAU MUNCHEN, GMBH",
  remittance text "Re Nr. 15".
- the model's own stored explanation: "Die Rechnungsnummer im Verwendungszweck (15) weicht
  leicht von der im Kandidaten ab (12), aber es handelt sich um die ei..." (the model noticed
  the invoice numbers contradict each other, and suggested the match anyway).

Invoice 15 does not exist as a document in that workspace, so document 12 was the only
candidate ever offered to the arbiter, and the model talked itself into it despite naming the
exact contradiction in its own reasoning. The amount differs too (905,00 vs 480,00 EUR),
which alone was not enough for `validateArbiterResult`'s existing checks (hallucinated id,
cross-direction, empty open amount) to reject it - none of them look at what the text itself
claims about invoice numbers, only at document identity, direction and remaining balance.

decisions/0023's own "AI proposes, code verifies" contract (`validateArbiterResult`) already
re-checks a hallucinated id and a cross-direction pick; a candidate the text itself explicitly
contradicts belongs in the same category of thing code must catch, not something left to the
model's own confidence or explanation to get right.

## Decision

### 1. `extractInvoiceReferences`: only a keyword-introduced number counts as a claim

`extractInvoiceReferences(remittanceText)` (`core/text-signals.ts`) returns the set of
normalized invoice-number tokens the text explicitly names via one of the same closed,
`Re.Nr.`/`Re-Nr`/`RechnungsNr`/`Rechnungsnummer`/`Rechnung`/`RG`/`RN`/`Inv`/`Invoice` keywords
decisions/0031 already uses for its short-invoice-number exception (reused, not duplicated: the
same normalized keyword list, tolerant of separators/case) - a digit run immediately following
the keyword in its normalized form. A bare number with nothing in front of it, a date, or a
number introduced by an unrelated keyword (a customer number: "Kundennummer", "Kd.Nr.",
"KdNr" are simply absent from the list) never produces a reference: the text has to make an
explicit invoice claim before its absence from that claim can mean anything. Returns an empty
set when the text names none - deliberately not distinguished from "found nothing to confirm"
at this function's own level; the distinction between "no claim at all" and "a claim that
matches" is `hasContradictingInvoiceReference`'s job, not this function's.

### 2. The veto: enforced in code, in every stage, not left to the model

`hasContradictingInvoiceReference(remittanceText, invoiceNumber)` is `true` only when the text
names at least one reference AND the candidate's own (normalized) invoice number is not one of
them - `false` whenever there is nothing to contradict (no invoice number on the document, or
no reference named in the text at all). This predicate is applied as a hard veto in all three
places a matching stage can otherwise produce a suggestion:

- `core/rules.ts`'s `matchByRules` (stage 1): checked immediately after the direction check,
  before any amount/secondary-signal logic runs, so a contradicting candidate is skipped
  outright rather than merely scored lower.
- `src/persistence/use-cases/payments-use-cases.ts`'s `aliasBoostSuggestions` (stage 1's own
  alias-corroboration extension, decisions/0025 decision 10): the same check, since a learned
  alias is not itself a license to override a textual contradiction.
- `payments-use-cases.ts`'s stage-2 candidate pool: `selectCandidateDocuments`'s result is
  filtered through this predicate BEFORE the subset-sum search, the partial-payment scan, or
  stage 3's AI arbiter (which reuses the same filtered list) ever see it - a contradicting
  document is removed from the candidate pool for that transaction entirely, not merely denied
  a suggestion at the end.
- `core/arbiter.ts`'s `validateArbiterResult` (stage 3): checked on the model's own picked
  candidate, independent of whatever candidate list it was actually given - the same "verified,
  never merely assumed to have received an already-correct list" discipline
  `validateArbiterResult`'s direction re-check already established. This is deliberately
  redundant with the stage-2 pre-filtering above: `validateArbiterResult` is a pure, directly
  testable function, and its own guarantee ("a contradicting pick can never survive") must hold
  regardless of what upstream candidate-selection code does or does not filter.

### 3. What is deliberately NOT vetoed

- A document with no invoice number at all: nothing for the text to contradict, so
  `hasContradictingInvoiceReference` returns `false` and every other signal (amount, IBAN,
  name) works exactly as before.
- A remittance text naming a customer number instead of (or in addition to) an invoice number:
  `extractInvoiceReferences` only recognizes the invoice-number keyword list, never a
  customer-number keyword, so a customer number sitting next to an unrelated bare number never
  manufactures a false reference.
- A remittance text naming SEVERAL invoice references at once (a collective payment covering
  more than one invoice): the veto only fires when the candidate's own number is in NONE of
  them - a candidate that is any one of the named references is unaffected, matching
  decisions/0023's own collective-payment model.
- The positive, already-shipped path: "Re.Nr. 12" plus document 12 extracts `{12}`, the
  candidate's own number is a member, no veto - auto-confirm still fires exactly as
  decisions/0031 left it.

## Consequences

- Positive: the exact observed defect (a transaction naming "Re Nr. 15" suggested for document
  12 despite a textual contradiction the model itself noticed) is now impossible at every
  stage, not just patched at the one call site it happened to surface at.
- Positive: the fix is entirely additive to already-tested pure functions plus one filter line
  in the orchestrating use case - no schema change, no new dependency, and the positive
  auto-confirm path is untouched (proven by keeping its own test green, not merely by
  inspection).
- Negative / accepted risk: a document whose invoice number happens to collide, once
  normalized, with a DIFFERENT real invoice's number named in the text (a genuine coincidence,
  not the observed defect's shape) would also be vetoed - accepted, since a false veto merely
  falls back to no suggestion (a human reviews it manually), while a false match silently marks
  an invoice paid that was not.
- Negative / accepted risk: `extractInvoiceReferences` inherits `RG`/`RN`'s own
  higher coincidental-match risk from decisions/0031's keyword list (a short, two-letter
  keyword can appear inside unrelated running text) - accepted for the same reason decisions/0031
  accepted it: this only ever widens what counts as a named reference (and therefore only ever
  makes the veto MORE likely to fire on real, if noisy, evidence), never invents a match.
- Implementation status: **implemented**. `core/text-signals.ts`'s `extractInvoiceReferences`/
  `hasContradictingInvoiceReference`, the veto in `core/rules.ts`'s `matchByRules`,
  `core/arbiter.ts`'s `validateArbiterResult`, and `payments-use-cases.ts`'s
  `aliasBoostSuggestions`/stage-2 candidate filtering all ship in this change, with unit tests
  covering the exact observed case at the arbiter, rules, and `runMatching` orchestration
  levels.

## Supersedes / Superseded By
- None
