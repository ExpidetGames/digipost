# The inbox sorts by the date the document carries, not by when it arrived

Document type: decision
Lifecycle: active
Owner: src/modules/documents
Scope: The `/dashboard` list's default order, its sort control, and the date shown per row
Canonical responsibility: Active source for how the inbox is ordered and which date a row shows
Maintenance triggers:
- A document kind starts carrying a period that could beat the upload-time fallback
- A second sort option is added (extend `DOCUMENT_SORTS`, its copy, and the db test)
Last verified: 2026-09-23, against the owner's own 98 documents

## Status

Accepted.

## Context

The inbox was ordered by `created_at desc` and each row also displayed `created_at`, so both
the order and the visible date were "when did this reach Digipost". The document's own date was
extracted, stored (`documents.document_date`) and even carried into the list projection, but
never used for either.

That is wrong for the way the product is actually filled. The owner uploaded 64 receipts in one
afternoon: 64 rows with the same date, carrying invoice dates spread across a year, in an order
that said nothing.

Coverage in the owner's own data at the time of this decision, and the reason the fallback below
exists at all:

| Kind | Documents | With a document date |
| --- | --- | --- |
| Eingangsrechnung | 56 | 56 |
| Ausgangsrechnung | 9 | 9 |
| Beleg | 6 | 6 |
| Plattformbericht (Apple, Google) | 24 | 0 |
| Kontoauszug | 3 | 0 |
| **Total** | **98** | **71** |

Every OCR'd document has a date. The 27 without are the tabular imports, and that is not a gap
to fix: a bank statement or an app-store report covers a *period*, not a day.

## Decision

- **`documentDate` is the default sort**, and the row shows that date. The product is a
  Posteingang: what matters is the date on the post, not the minute it was scanned.
- **A document with no own date falls back to its upload time**, through
  `coalesce(document_date, created_at::date)` rather than `nulls last`. The 27 undated documents
  keep their place in the timeline at the day they arrived, instead of collecting in a block at
  the end where nobody scrolls.
- **A row with no own date labels what it is showing** ("Eingang 23.09.2026"), so a fallback
  date is never mistaken for a document date.
- **`uploaded` stays available** as an explicit choice in the filter bar ("Zuletzt
  hochgeladen"), which is the right order right after a bulk upload.
- **The sort lives in the URL** like every other inbox filter, and `sort` is parsed with
  `.catch("documentDate")` so a stale bookmark with a removed value silently gets the default
  instead of a validation error.
- **`created_at desc, id desc` still follows** whichever primary order is chosen. Offset
  pagination needs a total order, and two documents created in one transaction can share a
  timestamp. A search (`q`) still ranks by `ts_rank` first.

## Consequences

- The visible date in a row changed meaning for every document that has its own date. This is
  the point, and the labelled fallback is what keeps it honest.
- `ListDocumentsFilter.sort` spells its union out rather than importing `DocumentSort` from
  `@/modules/documents`, exactly as `paymentStatus` already does: a persistence contract does
  not depend on a module that depends on it.
- Ordering by an expression means no index serves this directly. At the current scale (a page of
  50 rows out of low hundreds) that is irrelevant; a workspace with tens of thousands of
  documents would want an index on `coalesce(document_date, created_at::date)`, and that is when
  to add one, not now.

## Alternatives considered

- **`nulls last`.** Rejected: it hides every bank statement and app-store report behind the
  whole rest of the archive.
- **Backfill a document date for reports from their period.** Rejected for now: a period is not
  a date, and writing the period's end into `document_date` would make a report look like it
  carries a date it does not. The fallback achieves the ordering without the lie.
- **Keep upload order as the default and offer the document date.** Rejected by the owner
  directly: the document's date is what a Posteingang is about.
