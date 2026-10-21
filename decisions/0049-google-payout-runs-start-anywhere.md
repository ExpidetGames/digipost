# Google payout runs may start at any open month

Document type: decision
Lifecycle: active
Owner: src/modules/payments
Scope: `planGooglePayoutPairing` in `src/modules/payments/core/app-store-payout-matching.ts`
Canonical responsibility: Active source for which runs of monthly Google Play reports may explain
one Google bank credit
Maintenance triggers:
- Google changes its payout schedule
- A real credit is explained by a run ending more than two months before it
Last verified: 2026-09-22, against the owner's January to April 2025 reports

## Status

Accepted. Amends decisions/0048-app-store-reports.md's Google pairing.

## Context

With the owner's real Google Play earnings reports for January to April 2025 (net 30,10, 52,40,
80,25 and 61,35 EUR), March + April is exactly the 2025-05-14 credit of 141,60 EUR. The pairing
still found nothing: it only tried runs starting at the oldest unclaimed report. January and
February belong to the 2025-03-14 credit of 152,50 EUR, which also needs December 2024 (not
uploaded, predicted net 70,00 EUR), so they could never be claimed and blocked every later run.

## Decision

A run of consecutive still-unclaimed reports may start at any of them. It qualifies when its sum
is exact to the cent and its last month lies one or two months before the credit's booking month
(Google pays mid-month for the balance of the previous month or two). Exactly one qualifying run
is taken; two or more leave the credit unexplained. Claimed reports are never paired twice.

## Consequences

- Positive: a missing older report no longer blocks every later payout.
- Negative: a payout that covers balances older than two months before it is not explained; it
  stays manual.
