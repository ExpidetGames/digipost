# The Google Play reader recognizes a report by the columns it reads

Document type: decision
Lifecycle: active
Owner: src/modules/intake
Scope: `detectGooglePlayEarnings`/`parseGooglePlayEarnings` in
`src/modules/intake/core/google-play-earnings.ts`
Canonical responsibility: Active source for how a Google Play earnings report is recognized and
how its columns are located
Maintenance triggers:
- Google renames or moves a column this reader reads
- A second platform reader needs the same tolerance
Last verified: 2026-09-23, against the owner's twelve 2025 reports

## Status

Accepted. Amends decisions/0048-app-store-reports.md's Google reader.

## Context

The owner uploaded all twelve 2025 Google Play earnings reports. Ten were read; November and
December were classified as "Sonstiges" and imported nothing. Google renamed columns from November
2025 ("Product id" to "Package ID", "Base Plan ID" to "Base Plan or Purchase Option ID") and added
"Sales Channel". The reader required the whole header to match its own fixed list, cell by cell,
and then located columns by their position in that fixed list rather than in the file.

## Decision

Recognition requires only the seven columns this reader actually reads (Description, Transaction
Date, Transaction Type, Product Title, Buyer Country, Merchant Currency, Amount (Merchant
Currency)), in any order, and every column is located by name in the file's own header row. A
report missing one of those seven is not recognized and falls through to the generic tabular path.

## Consequences

- Positive: renamed, added or dropped columns the reader never reads no longer break it, and the
  owner's November and December reports parse (net 295,40 and 301,15 EUR, exactly the credits of
  2025-12-15 and 2025-11-17).
- Negative: a different CSV that happens to carry those seven column names would be read as a
  Google report. All seven together make that improbable enough to accept.
