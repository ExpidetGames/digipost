# Every Google Play row reaches the clearing account

Document type: decision
Lifecycle: active
Owner: src/modules/intake
Scope: how `google-play-earnings.ts` splits a report row into the revenue side and the fee side
Canonical responsibility: Active source for which Google Play row types are deducted as fees and
why every other row goes to the revenue side
Maintenance triggers:
- Google adds a row type that is a deduction of its own
- A second platform reader needs the same "never drop a row" rule
Last verified: 2026-09-23, against the owner's twelve 2025 reports

## Status

Accepted. Amends decisions/0048-app-store-reports.md's Google reader.

## Context

After importing all twelve 2025 reports the Google clearing account read 531,25 EUR, while the
reports minus the paid-out credits come to 470,75 EUR. The reports carry five row types; the
reader only ever recognized "Charge", "Google fee", "Refund" and "Google fee refund", and
`buildSettlementLineDrafts` only creates a line from a row that carries a gross or a fee amount:

- "Charge refund" (Google's real wording, -80,00 EUR in 2025) matched none of them and was dropped.
- "Tax" (-4,50 EUR) was dropped for the same reason.
- "Google fee refund" (+12,00 EUR) was booked as a fee, and a fee is always deducted, so it
  subtracted 12,00 EUR instead of adding it: 24,00 EUR of error.

The payout pairing was never affected: it uses the report's own net, the sum of every row.

## Decision

Only "Google fee", Google's own commission, is a fee line. Every other row - a charge, a refund, a
tax withheld, a refunded fee, an unknown future type - goes to the revenue side with the sign the
report states, so a negative row becomes a refund line and nothing is ever dropped. The sum of a
report's imported lines therefore always equals its own net.

`buildSettlementLineDrafts` keeps deducting fees by absolute value: Stripe states its fees as
positive numbers, and that rule is right for it. Making the sign meaningful there would have
inverted every Stripe fee.

## Consequences

- Positive: the clearing account shows what the platform owes to the cent (470,75 EUR for 2025).
- Negative: a refunded fee shows up as a revenue line rather than a negative fee. The money is
  right, the label is coarse; a dedicated line type would need a schema change.
- Neutral: existing imports keep their old lines - the owner's data was re-imported once by hand.
