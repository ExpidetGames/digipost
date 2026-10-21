# A card charge names its receipt

Document type: decision
Lifecycle: active
Owner: src/modules/payments
Scope: Stage 1 of payment matching (`matchByRules`) and the alias boost in `payments-use-cases.ts`
Canonical responsibility: Active source for matching a card charge to its receipt by the
reference in the statement descriptor
Maintenance triggers:
- A bank puts the card descriptor somewhere other than the counterparty name or remittance text
- A merchant's descriptor reference stops appearing verbatim on its receipt
- The reference signal is allowed to auto-confirm without an exact amount
Last verified: 2026-10-21, against a sample set of Meta card charges

## Status

Accepted. Extends decisions/0023-payment-matching.md's stage 1.

## Context

Meta bills ads per receipt and charges the card for each one. The bank statement shows the
charge as:

```
04.03.2026   -25,00 EUR   counterparty "FACEBK *K3M9P2QX7R"   remittance text: (none)
05.03.2026   -25,00 EUR   counterparty "FACEBK *W6ZN1CDJ5L"   remittance text: (none)
```

Each receipt prints the same reference ("Referenznummer: K3M9P2QX7R") next to the card it was
charged to. The receipt's invoice number (FBADS-100-200000001) never appears on the statement,
so stage 1 had no invoice signal. Two receipts carried the same amount, and the AI arbiter
paired them crosswise. The whole Meta reconciliation had to be fixed by hand.

The reference is the strongest evidence in the data: it is unique per charge and appears on
both sides verbatim.

## Decision

A card charge's statement descriptor has the shape `MERCHANT *REFERENCE`. Stage 1 reads the
reference after the asterisk from the transaction's counterparty name and its remittance text
(`extractStatementReferences`). It then looks for it as a whole token, case-insensitively, in
the candidate document's OCR text (`documentNamesStatementReference`, fed by
`MatchableDocument.referenceText`).

- A token counts as a reference only if it is at least 6 characters of mixed letters and digits,
  or at least 8 digits. A plain word ("PAYPAL *MUSTERSHOP") or a short number is never one.
- The signal counts only with an amount exact to the cent. With that, it is as strong as an
  invoice number in the remittance text: it can auto-confirm, and it lifts the 45-day window of
  decisions/0044. It has its own reason code, `statement_reference_in_document` ("Referenz der
  Kartenzahlung steht im Beleg"), so the UI says what was actually found.
- Stage 2's corroboration check accepts it as a signal too, but never as the invoice number.

Checked against sample data: every Meta card charge resolves to exactly one receipt,
the same pairing a person reconciled by hand.

## Consequences

- Any merchant using this descriptor shape (Meta, PayPal, Google, Amazon, and others) gets
  deterministic matching, provided its receipt prints the reference.
- A contact with a clearing account (decisions/0068) is still excluded from matching entirely.
  This rule matters for card-billed suppliers without one.
- No veto: a receipt naming a different reference is not rejected, only not boosted. A same-amount
  twin can therefore still reach the AI stage when the right receipt is missing.
