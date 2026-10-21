# The classifier knows the company, and suggestions keep only the date-closest pairing

Document type: decision
Lifecycle: active
Owner: src/modules/intake (classifier input), src/modules/payments (suggestion pruning)
Scope: `IntakeClassifierTextInput.ownCompany`, the intake system prompt's company block, the
foreign-IBAN mirror rule in `processOcrDocument`, and `closestByDate`/`keepClosestSuggestions`
in `payments-use-cases.ts`
Canonical responsibility: Active source for how incoming and outgoing invoices are told apart,
and why a recurring charge yields one suggestion per invoice instead of a cross product
Maintenance triggers:
- The classifier prompt or its input changes
- Matching gains a signal stronger than the date for recurring charges
Last verified: 2026-09-22, initial version

## Status

Accepted

## Context

The owner bulk-uploaded 64 receipts from 2025. Two defects:

1. Several supplier invoices were classified as the owner's own outgoing invoices (four from
   IONOS, a fee from the city of Beispielstadt), and IONOS landed in the contact book as a customer. The
   classifier only ever received the OCR text, never who the user is, and every invoice is
   "outgoing" from its issuer's point of view. Since decisions/0036 the kind decides the roles, so
   a wrong kind inverts everything downstream.
2. Recurring charges (IONOS 4,20 EUR and 12,00 EUR monthly, Notion 24,90 EUR monthly) produced a
   cross product: every monthly invoice matched every equal debit of the same vendor inside the
   60-day candidate window. 170 open suggestions, 28 transactions and 19 documents with several.

## Decision

1. The classifier receives the company profile for text input (name, aliases, address, own IBANs
   from the profile and imported accounts, domains, the user's own description) plus an explicit
   rule: `outgoing_invoice` only when the user's company issued the invoice, `incoming_invoice`
   when another company billed it, `receipt` for receipts and payment confirmations. The profile
   text is neutralized against guard delimiters and stays outside the untrusted input section.
2. Mirror of decisions/0039: an `outgoing_invoice` whose verified payment IBAN (decisions/0040)
   belongs to someone else becomes an `incoming_invoice`, once at least one own account is known.
   Our own invoices ask for payment to one of our accounts.
3. Suggestions keep only the date-closest pairing: within one transaction's rules suggestions
   (unless one auto-confirms, the invoice number beats any date), and at the end of every
   matching run across all open suggestions, first per transaction, then per document. Ties
   survive for a human. Collective suggestions are left alone.

## Consequences

- Positive: a supplier invoice addressed to a person of the company is recognized as incoming.
- Positive: a year of monthly subscriptions yields about one suggestion per invoice.
- Negative: a payment made much later than its invoice, while another equal invoice of the same
  vendor lies closer in time, pairs with the wrong month; both stay suggestions, never confirmed.
- Negative: an own outgoing invoice paid to an account that is in neither the profile nor the
  imported statements flips to incoming. Add every own account to the profile.
