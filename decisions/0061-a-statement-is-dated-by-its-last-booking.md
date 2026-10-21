# A bank statement is dated by its last booking

Document type: decision
Lifecycle: active
Owner: src/modules/documents
Scope: `BankStatementIntakeResult.lastBookingDate`, and the name and sort position of a
bank-statement document
Canonical responsibility: Active source for how a bank statement is labelled and ordered
Maintenance triggers:
- The statement reader's transaction shape changes (`bookingDate`)
- Another document kind needs a date derived from its own contents
Last verified: 2026-09-23, against three sample statements

## Status

Accepted. Completes decisions/0060-app-store-reports-are-named-by-their-period.md, which named
the bank statement as the one document class still left on the file-name fallback.

## Context

After decisions/0059 and 0060, exactly three documents in the sample workspace still read as
their file name and sorted by the day they were uploaded:

```
OLD_Musterbank_statement_2109, Eingang 21.09.2026
Musterbank_statement_21092026, Eingang 21.09.2026
Musterbank_statement_21092026, Eingang 21.09.2026
```

Three rows, two of them identical, for statements covering entirely different months. The
statements do know their own dates: every parsed transaction carries a `bookingDate`. Unlike an
app-store report, a statement has no single period field, and the owner named the rule directly:
the date of the last booking in the file.

## Decision

- **The reader records `lastBookingDate`** on `BankStatementIntakeResult`: the latest
  `bookingDate` over every parsed transaction.
- **Computed before truncation.** `buildBankStatementIntakeResult` caps the embedded
  transactions at `MAX_EMBEDDED_ROWS` (500), keeping the first ones. Taking the maximum over the
  embedded rows would therefore give the wrong date for any statement with more than 500
  bookings, so the reduction runs over the full input. A unit test puts the latest booking past
  the cap specifically to pin this down.
- **The inbox dates and sorts the statement by it**, as the next arm of the same `coalesce` the
  previous two decisions built up: `document_date`, then a report's period end, then a
  statement's last booking, then the upload day. The value is guarded with
  `~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'` before the cast, for the same reason the period is.
- **The statement is named after its kind**: "Kontoauszug, 29.01.2026". `platformLabel` on
  `DocumentNameParts` becomes `typeLabel`, since it now carries two things a document can be
  named by when it has no counterparty: a report's platform, and a statement's kind.
- **`document_date` stays empty**, consistent with decisions/0058 and 0060: the date is derived
  from the file's contents, not asserted as a field the statement carries.

## Consequences

- The three statements already in the sample workspace were imported before this field existed.
  Their transactions were all embedded (`truncated: false`), so their `lastBookingDate` was
  backfilled with a one-off `UPDATE` on the development database, guarded on `truncated = false`
  so it could never write a wrong date. A statement re-imported later recomputes it anyway.
- `lastBookingDate` is optional in the intake-result schema, so a statement stored before this
  decision still parses and simply falls back to its upload date.
- Every document class in the product now has a name and a date derived from what it is, and
  the file name is the fallback of last resort rather than the normal case.

## Alternatives considered

- **Compute the maximum in SQL over the embedded transactions**
  (`jsonb_array_elements(intake_result->'transactions')`). Rejected: it silently gives the wrong
  answer for a truncated statement, and it costs an array expansion per row inside the sort.
- **The statement's own closing-balance date from camt.053.** A reasonable alternative, but it
  does not exist in MT940, and the owner asked for the last booking, which both formats have.
- **Name the statement after its account** ("MUSTERBANK Geschäftskonto"). Tempting, since the IBAN is
  on every transaction, but it needs a lookup into `src/modules/accounts` from a documents-owned
  read. Worth doing when a workspace has more than one bank account; not now.
