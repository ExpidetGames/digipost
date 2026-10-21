# Invoice numbers in remittance text: the veto reads leniently, the confirmation strictly

Document type: decision
Lifecycle: active
Owner: src/modules/payments
Scope: how `findInvoiceNumbers`, `extractInvoiceReferences` and `hasContradictingInvoiceReference`
(`src/modules/payments/core/text-signals.ts`) read a number phrase such as "Re Nr. 21/ 24"
Canonical responsibility: Active source for why the contradiction veto accepts every plausible
reading of a number while the positive invoice-number signal accepts only the first one
Maintenance triggers:
- A real payment is vetoed although it belongs to the document (the veto is too strict)
- A payment is auto-confirmed against the wrong document because of a number phrase
- The invoice-number keyword list (decisions/0031) changes
Last verified: 2026-09-22, initial version, against a real-world invoice 21

## Status

Accepted. Amends decisions/0033-contradicting-invoice-number-vetoes-a-match.md.

## Context

An outgoing invoice 21 (312,50 EUR, dated 06.03.2025) was paid on 11.03.2025 with the
remittance line "Re Nr. 21/ 24", invoice 21 of 2024 in the common German number/year form, by the
customer's proprietor privately, so no name or IBAN signal was available. Amount and direction matched
exactly. The document still stayed open, for two reasons:

1. Every comparison ran on `normalizeToken`, which strips all separators, so "21/ 24" became
   "2124". `extractInvoiceReferences` therefore reported the reference "2124", and the veto from
   decisions/0033 called the correct payment a contradiction ("2124" is not "21") and blocked it in
   all three matching stages.
2. The positive keyword rule (decisions/0031) required a non-digit after the number in the
   normalized text, and found nothing either.

Checking the veto on the same occasion revealed an older false veto of the same kind: a document
numbered "RE-2026-00002" paid as "Re Nr. 2026-00002" was vetoed too, because the document's own
number was compared only with its letter prefix intact.

## Decision

A number phrase is now read on the raw text: a keyword, then digit runs joined only by "/" or "-".
The two consumers read it with deliberately different strictness, because they have opposite
failure costs:

- **The veto is lenient.** It fires only when no plausible reading fits. The references of
  "Re Nr. 21/ 24" are "21", "24" and "2124"; the document's own number is compared as written, as
  digits only (letter prefix dropped) and without leading zeros. A false veto silently loses a
  correct match that no later stage can recover, so doubt must mean "no veto".
- **The confirmation is strict.** `findInvoiceNumbers` additionally accepts only the FIRST digit
  run of a phrase. "Re Nr. 21/ 24" finds invoice 21 and never invoice 24. This signal, together
  with a matching amount, auto-confirms a payment without a human, so doubt must mean "no match".

Everything else from decisions/0033 stands, including the case it was written for: "Re Nr. 15"
against invoice 12 has no fitting reading and is still vetoed.

## Consequences

- Positive: invoice 21 auto-confirms against its payment (tested with the same values).
- Positive: prefix and zero-padding differences no longer veto a correct match.
- Negative: a phrase like "21/24" now also offers "24" as a reading, so a document numbered 24
  is no longer vetoed by it. It is not matched by it either (the confirmation takes the first run
  only), it simply falls through to the arithmetic stage and the AI arbiter like any payment
  without an invoice signal.
- Neutral: a date written directly after a number with "/" or "-" ("Re Nr. 21-02.07.25") can add a
  harmless extra reading; a date separated by words ("Re.Nr. 12 vom 02.07.25") cannot.

## Supersedes / Superseded By

- Amends decisions/0033 (which reading counts as a reference). Does not supersede it.
