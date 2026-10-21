# A paired platform payout leaves the clearing account, and a clearing account shows its own balance

Document type: decision
Lifecycle: active
Owner: src/modules/accounts
Scope: `AccountsUseCases.recordPlatformPayout`, its call from the app-store payout pairing, and
the balance shown for a clearing account in `listAccounts`
Canonical responsibility: Active source for how an Apple/Google payout is booked out of the
platform's clearing account and what that account's balance means
Maintenance triggers:
- A platform report starts carrying its own payout id (then decisions/0026's `tryPairPayout` path applies)
- Clearing accounts gain statements of their own
Last verified: 2026-09-23, against the owner's four Google reports and their bank credits

## Status

Accepted. Extends decisions/0026-platform-settlements.md and decisions/0048-app-store-reports.md.

## Context

After importing the owner's Google reports for January to April 2025, the Google clearing account
held all 90 report lines (236,40 EUR) and the 2025-05-14 credit of 141,60 EUR was correctly paired
with March and April. The account still showed no balance at all, and the money that had actually
arrived on the bank account was still sitting in the clearing account:

- `listAccounts` took a balance only from an imported statement's closing balance, or from the
  transaction sum when at least one import batch existed. A clearing account has neither.
- decisions/0026 books a payout out of the clearing account per `payoutId` group of a report.
  Apple's and Google's reports have no payout id (decisions/0048), so no payout was ever booked.

## Decision

- `recordPlatformPayout` books a debit over the paired amount on the platform's clearing account
  and puts the same `transferGroupId` on it and on the bank credit, exactly like decisions/0026's
  own payout pairing. It is idempotent per bank transaction and only runs for a CONFIRMED pairing,
  never for a suggestion: nothing is booked until a human (or the workspace's auto-confirm mode)
  has agreed.
- Payments asks `src/modules/accounts` for it through a narrow port instead of writing
  `transactions` itself (only the owning module writes its tables).
- A clearing account's balance is the sum of its own bookings and is shown as exact. A bank
  account without any import batch still shows nothing.

## Consequences

- Positive: the clearing account shows what the platform still owes (report lines minus payouts).
- Negative: pairings confirmed before this change have no payout booking; they need a one-time
  backfill (the owner's own May credit was backfilled by hand through this same use case).
- Neutral: a suggestion in mode `none` leaves the clearing account untouched until confirmation.
