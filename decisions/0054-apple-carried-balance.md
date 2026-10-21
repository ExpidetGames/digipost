# A carried balance is not earned twice

Document type: decision
Lifecycle: active
Owner: src/modules/intake
Scope: the carried-balance ("Saldo") handling in `apple-payment-summary.ts`
Canonical responsibility: Active source for how an Apple report that carries a returned payout
into the next month is booked
Maintenance triggers:
- Apple renames the carried-balance or exchange-rate column
- A platform other than Apple starts carrying balances forward
Last verified: 2026-09-23, against the owner's June and July 2025 reports

## Status

Accepted. Extends decisions/0048-app-store-reports.md and decisions/0053-apple-column-sets-vary.md.

## Context

The owner's June 2025 payout (45,10 EUR) was returned: their bank account was blocked while the
payment profile moved to a new bank. Apple's June report states "Retournierte Zahlung", carries
the amount into the July report's "Saldo" column, and July's "Gewinn" therefore contains June's
money as well. Paid out on 2025-09-04 as 66,80 EUR, which the pairing matched correctly.

The clearing account showed 45,10 EUR left over, because June's proceeds were booked twice: once
as June's own revenue and once inside July's.

## Decision

When a report carries a balance, a region row's revenue is its proceeds minus that carried
balance, converted with the report's own exchange rate. The payout total still comes from the
footer and still covers both months, so the bank pairing is unchanged.

## Consequences

- Positive: the clearing account stops double counting a returned payout.
- Negative: Apple converts the same foreign balance at two different monthly rates (2,20 USD was
  1,90 EUR in June and 1,89 EUR carried into July), so a residue of a cent per affected foreign
  region can remain on the clearing account. It is Apple's own rounding, not a lost amount.
