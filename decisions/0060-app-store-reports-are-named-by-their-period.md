# An app-store report is named and sorted by the month it covers

Document type: decision
Lifecycle: active
Owner: src/modules/documents
Scope: The name and the sort position of a document whose `intakeResult` carries a period
Canonical responsibility: Active source for how a periodic report is labelled and ordered
Maintenance triggers:
- A reader starts storing its period somewhere other than `intakeResult.appStorePayout.period`
- Another document kind gains a period (a bank statement, a quarterly report)
Last verified: 2026-09-23, against the owner's own 24 Apple and Google reports

## Status

Accepted. Completes decisions/0058-inbox-sorts-by-the-document-s-own-date.md and
decisions/0059-generated-document-names.md for the one document class both had left on their
fallback path.

## Context

decisions/0058 sorted the inbox by the document's own date and decisions/0059 named a row after
its counterparty. An Apple or Google report has neither: no `document_date`, no linked contact.
Both decisions therefore fell back to the upload day and the uploaded file name, and the result
was the worst list in the product:

```
financial_report, Eingang 23.09.2026
financial_report (1), Eingang 23.09.2026
financial_report (2), Eingang 23.09.2026
... 24 of these, in the order the browser happened to send them
```

Twenty-four rows, one label, no order, sitting as a block at the top of the inbox because they
were all uploaded on the same afternoon. That is exactly the failure decisions/0058 set out to
fix for a bulk upload of receipts, reappearing for the reports.

They do have the information. Both readers (decisions/0048-app-store-reports.md) already record
the month, and all 24 of the sample reports carry it: `intakeResult.appStorePayout.period`,
twelve Apple months and twelve Google months of 2025.

## Decision

- **A report is named after its platform and its period**: "Apple, November 2025", "Google,
  November 2025". `platformLabel` outranks the counterparty in `documentNameSource`, which costs
  nothing because a report never has one.
- **It sorts at the END of the month it covers.** The list's date expression becomes
  `coalesce(document_date, <period end>, created_at::date)`, so a March report sits between the
  March and the April invoices rather than on the day it was uploaded.
- **The period is read from `intakeResult`, not copied into a column.** Both readers already
  store it, one jsonb path serves the name and the sort, and there is no migration, no backfill
  and no second copy to keep true. The SQL guards the value with `~ '^[0-9]{4}-[0-9]{2}$'`
  before `to_date` ever sees it, so a malformed period degrades that one row to the upload-date
  fallback instead of failing the whole query. A db test covers exactly that.
- **`document_date` stays empty for a report**, as decisions/0058 already decided. A period is
  not a day, and now that the row says "November 2025" rather than a date, nothing has to
  pretend otherwise.

## Consequences

- A bank statement is now the only document left on the pure file-name fallback. Its camt.053 /
  MT940 intake result carries statement dates but no period field, and giving it one is a
  separate decision with its own reader work.
- The list query does a jsonb lookup per row for the period and another inside the sort
  expression. At a page of 50 rows this is not measurable; if the sort ever needs an index, the
  period wants to become a real column first (the precedent `documents.platform` already set),
  and that is the moment to add it, not now.
- The two "Sonstiges"-classified reports from before decisions/0051 would show as their file
  name, because nothing wrote them a period. They were re-imported and no longer exist.

## Alternatives considered

- **Write the period's last day into `document_date`.** Rejected again, for the reason
  decisions/0058 gave: a semantic column filled with a synthetic value is a trap for every
  later reader of it, and the sort expression achieves the same ordering without lying.
- **A `period` column with a migration and a backfill.** Rejected for now as premature: it buys
  an index nothing yet needs, and the jsonb path is already the readers' own source of truth.
- **Name the report after the file.** That is the status quo this decision removes.
