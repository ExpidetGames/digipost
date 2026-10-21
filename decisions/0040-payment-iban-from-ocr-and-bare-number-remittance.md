# Payment IBAN from the OCR text, and a bare-number remittance line

Document type: decision
Lifecycle: active
Owner: src/modules/documents (payment IBAN), src/modules/payments (remittance rule)
Scope: `resolvePaymentIban` (`src/modules/documents/core/payment-iban.ts`) and
`isWholeRemittanceInvoiceNumber` in the rules stage (`src/modules/payments/core/rules.ts`)
Canonical responsibility: Active source for why the code, not the model, supplies the payment
IBAN, and when a remittance line consisting only of the invoice number auto-confirms
Maintenance triggers:
- The analyzer's invoice fields change
- A real invoice ends up with a wrong payment IBAN, or a direct-debit invoice with ours
- A bare-number remittance line is auto-confirmed against the wrong invoice
Last verified: 2026-09-22, initial version, against nine real invoices

## Status

Accepted

## Context

Comparing the stored payment IBAN of nine real invoices with their OCR text: the OCR text
held the correct IBAN on all nine. The model's copy was right on six, dropped two digits on one
("DE35 2000 00 0123 4567 89" for "DE35 2000 0000 0123 4567 89") and was empty on two. The own-IBAN
kind correction (decisions/0039) depends on this field.

Separately, invoices 17 and 21 were paid with remittance lines "17" and "21" and exact amounts. A
bare short number without a keyword is deliberately not an invoice signal (decisions/0031), so
both stayed suggestions needing a click.

## Decision

**Payment IBAN.** The code extracts every checksum-valid IBAN from the OCR text; the model's field
only says which one it meant. A named IBAN that is valid and present is taken; a mis-copy is
repaired to the one valid text IBAN with the same country code and check digits within four edits;
when the model named none, the single valid IBAN in the text is taken unless it is our own. Our own
IBAN appears on a supplier's direct-debit invoice as the account being debited, and without the
model naming it as the payee it must neither be stored as the payment IBAN nor flip the kind to
outgoing. ZUGFeRD's XML field is used as is.

**Bare-number remittance.** A remittance text that, normalized, is exactly the invoice number counts
as the invoice signal, but only together with an amount exact to the cent (never skonto). With that
signal the rules stage auto-confirms, like "Re Nr. 17" with the exact amount always did.

## Consequences

- Positive: invoice 4's broken IBAN is repaired; the six correct ones are unchanged.
- Positive: invoices 17 and 21 auto-confirm.
- Negative: an own outgoing invoice where the model names no payment IBAN keeps the field empty
  (invoices 5 and 6), because the code cannot tell a payee IBAN from a debited account on its own.
  Its kind then rests on the classifier alone, as before.
- Neutral: a remittance line "17" with a skonto-reduced amount stays a suggestion.
