# Apple's monthly reports do not share one column set

Document type: decision
Lifecycle: active
Owner: src/modules/intake
Scope: header recognition and column lookup in `apple-payment-summary.ts`
Canonical responsibility: Active source for which columns an Apple payment summary must carry and
how they are located
Maintenance triggers:
- Apple renames one of the four columns this reader reads
- The English wording is confirmed against a real English report (still a guess)
Last verified: 2026-09-23, against the owner's twelve 2025 reports

## Status

Accepted. Amends decisions/0048-app-store-reports.md's Apple reader.

## Context

Ten of the owner's twelve 2025 Apple reports were read; June and July imported nothing and stayed
"Sonstiges". Apple's column set varies by month: June 2025 has neither "Teilsaldo vor Steuern" nor
"Wechselkurs" (nine columns), July 2025 adds a "Saldo" column (twelve). The reader required an
exact eleven-column header and then read the proceeds by a fixed position derived from it.

## Decision

A report is recognized when its header row carries the four columns this reader reads - region,
units sold, proceeds and bank-account currency - in the language the title established, in any
order and next to any number of other columns. Every column is located by name in the file's own
header row, the payout footer by the proceeds column's own position.

## Consequences

- Positive: June (45,10 EUR) and July (66,80 EUR) parse, and a future column change is tolerated.
- Neutral: June's footer also states "Retournierte Zahlung" - the payout came back. The reader
  does not interpret that; the report simply finds no matching bank credit.
