# Card merchant names, and foreign currency in the arbiter prompt

Document type: decision
Lifecycle: active
Owner: src/modules/payments (name similarity), src/platform/mistral (arbiter prompt)
Scope: `counterpartyNameSimilarity` in `src/modules/payments/core/text-signals.ts` and the
payment arbiter's system prompt
Canonical responsibility: Active source for how card-payment counterparty names are compared, and
what the arbiter is told about foreign-currency invoices
Maintenance triggers:
- A bank formats card counterparty names differently
- Exchange rates become available to matching
Last verified: 2026-09-22, initial version

## Status

Accepted

## Context

Twelve monthly Automattic invoices in USD each had their EUR card debit one or two days later,
yet only five got a suggestion. The debits from January to June read "AUTOMATTIC,AUTOMATTIC.CO"
(or "AUTOMATTIC,HTTPSAUTOMATT"), from July on just "AUTOMATTIC". The card network appends a
location or URL after a comma; the extra words lowered the token similarity to "Automattic Inc"
from 0.50 to 0.33, below the 0.40 threshold, so decisions/0044's evidence gate rejected the
arbiter's correct picks. For May to July the arbiter itself answered "passt zu keiner Rechnung":
it did not know that a USD invoice is debited in EUR at the exchange rate.

## Decision

- `counterpartyNameSimilarity` also compares the names up to the first comma and takes the best
  score. This can only raise a similarity, never lower it; unrelated names stay at 0.
- The arbiter prompt explains foreign currency: the debited amount differs by the exchange rate,
  typically up to 20 %, which is no contradiction; decide by vendor and date, and for monthly
  invoices of one vendor pick the closest date.

## Consequences

- Positive: card payments with a merchant suffix match their vendor (Automattic, IONOS, Notion).
- Negative: a contact name containing a comma is also compared by its first part, which can raise
  a similarity for a company whose name starts like another's.
