# src/modules/closing

Document type: reference
Lifecycle: active
Owner: src/modules/closing
Scope: The "Abschluss" room: the completeness check for a month or a year, and the ZIP export
handed to a tax advisor
Canonical responsibility: What a period is, what "this period is complete" measures, and what
the export contains and calls its files
Maintenance triggers:
- The effective-date expression changes (it is shared with the inbox on purpose)
- A new kind of gap belongs in the check, or an item's link target moves
- The export's sheets, columns, cross-reference wording, or file-naming rule change
- A real DATEV Buchungsstapel lands and this module stops being the only handover format
Last verified: 2026-10-03, every check item's link now carries the period as a `?from=`/`?to=`
date range, so a period-scoped count opens a period-scoped list (measured against the owner's
real 2025 and 2026-01). Previously, 2026-10-02,
decisions/0066-abschluss-check-and-export.md: this module landed.
Since then, two findings from real-world data: outgoing invoices got their own
`ausgangsrechnungen/` folder, and the two bare match COUNTS became real cross references
(`Nr.` on both sheets, plus a third "Zuordnungen" sheet).

## Purpose

Answers the one question with a deadline: **is this month (or this year) done, and can I hand
it over?** Two halves, both admin-only:

1. **The check.** Five gaps, each a real SQL `count(*)` scoped to the period, each a link into
   the existing list that closes it, plus the period's own totals so "keine Lücken" can never
   be read as "nichts da".
2. **The export.** One streamed ZIP: `uebersicht.xlsx` (three sheets, German headers, real
   dates and real numbers) plus every document's own file, under `ausgangsrechnungen/` when
   the workspace issued it and `belege/` otherwise.

This module deliberately does **not** become an accounting system: no chart of accounts, no
double entry, no DATEV format. See decisions/0066-abschluss-check-and-export.md for why, and
for what would have to be true before a DATEV Buchungsstapel is worth building.

## Public interfaces

- `index.ts` (neutral): `parseClosingPeriod`/`currentClosingPeriod`/`closingPeriodOptions`
  (`core/period.ts`), `readClosingPeriod`/`closingQuerySchema` (`core/schemas.ts`),
  `buildClosingReport`/`CLOSING_CHECK_KEYS` (`core/report.ts`),
  `belegFileName`/`assignBelegFileNames`/`slugifyFileNamePart`/`fileExtensionFor`/
  `closingDirectoryFor` (`core/file-names.ts`),
  `buildClosingCrossReferences`/`closingReference` (`core/cross-references.ts`),
  `closingDocumentName`/`closingDocumentNameSource` (`core/document-name.ts`). Every one of
  them is pure.
- `server.ts` (`server-only`): `getClosingReportProjection` for `/dashboard/abschluss`, and
  `createClosingExport`/`closingExportFileName` for `GET /api/closing/export`.
- No `actions.ts` and no `client.ts`: the Abschluss writes nothing and needs no client
  component (its period selector is a plain `method="get"` form, like the inbox's filters).

## Structure

- `core/period.ts` - a period is a month (`2026-01`) or a year (`2026`). Parsing, bounds
  checking, the inclusive `from`/`to` ISO dates (February's real length included), and the
  selector's own option list. No clock: every function that needs "today" takes an ISO date.
- `core/schemas.ts` - the one URL parameter, Zod-parsed at the boundary.
- `core/report.ts` - the check's pure shape: `CLOSING_CHECK_KEYS`, each item's link target,
  `complete` (every count zero) and `empty` (no documents and no transactions at all), which
  are deliberately two different statements.
- `core/file-names.ts` - `<folder>/<date>_<Name>_<id8>.<ext>`: the two folders, the slug
  rules, the media-type to extension table, and `assignBelegFileNames`, the single source both
  the workbook's "Datei" column and the archive entry read from.
- `core/cross-references.ts` - the numbering (`D-001` / `B-001`), which rows belong together,
  and how a confirmed counterpart that has no row in this workbook is named instead of
  dropped. Pure: every German word arrives as a label.
- `core/document-name.ts` - the generated name (decisions/0059), composed the same way the
  inbox composes it: a report's platform and month, a statement's kind and last booking, else
  the counterparty and the document's own date.
- `core/types.ts` - the two already-localized sheet-row shapes.
- `server/read-models.ts` - `getClosingReportProjection`, `getClosingExportData`, and
  `createClosingDocumentFileReader`.
- `server/export-workbook.ts` - the only `exceljs` user: three sheets, frozen header,
  autofilter, real `Date` and `number` cell values with German display formats.
- `server/export-archive.ts` - the only `archiver` user: a ZIP streamed as it is produced, one
  entry at a time.
- `server/export.ts` - assembles the two, and is where a document's file name is decided once.
- `tests/` - unit tests for every `core/` file plus the workbook, the archive, and the whole
  assembly.

## Persistence

**No table and no column of its own.** Every read is a period-scoped query over tables other
owners already own, reached through `src/persistence/use-cases/closing-use-cases.ts`
(`ClosingUseCases`, wired in `create-request-services.ts` with `{ repos }` only - it never
writes, so it gets no `UnitOfWork`). The repository methods it calls were added to the owning
repositories, because that is where a `count(*)` has to live:

- `DocumentRepository.countsForPeriod` / `listForPeriod` (owner: `src/modules/documents`)
- `TransactionRepository.countsForPeriod` / `listForPeriod` (owner: `src/modules/accounts`)
- `DocumentTransactionRepository.countSuggestedForPeriod` (owner: `src/modules/payments`)

The two `listForPeriod` reads return the confirmed counterparts THEMSELVES
(`confirmedTransactions` / `confirmedDocuments`, each with the counterpart's own date, amount,
currency and allocated portion), not a count: a count can be shown but not followed. The
check's own counts are untouched by that - they live in `countsForPeriod`, a different query.
A linked document's date and amount are read with the very expressions the "Dokumente" sheet
selects (`documentEffectiveDate`, `documentTotalAmountCents`, `documentCurrency`, all exported
from `repositories/drizzle/documents-repository.ts`), so one document can never show one date
on one sheet and another date on the next.

## Which date puts a row in a period

A transaction belongs to a period by its own `booking_date`, nothing derived.

A document belongs to a period by **`documentEffectiveDate`**, the exported SQL helper in
`src/persistence/repositories/drizzle/documents-repository.ts`:
`coalesce(document_date, <app-store report period end>, <bank statement last booking>,
created_at::date)` (decisions/0058, 0060, 0061). That expression is **shared, not copied**: the
inbox's own ordering and this module's period scoping are the same SQL, so an Abschluss can
never disagree with the inbox about which month a document belongs to. `closing-repository.db.test.ts`
pins that down against real Postgres, including by comparing `list`'s order with
`listForPeriod`'s.

## The check's five items

| Item | What it counts |
| --- | --- |
| Buchungen ohne Beleg | `TransactionRepository.listUnmatched`'s own three conditions (not confirmed, not "kein Beleg nötig", not on a clearing account) plus the period - one shared condition builder, never a second definition |
| Belege ohne Zahlung | Documents whose EFFECTIVE payment status is `open` or `overdue` (the same SQL `CASE` the inbox filter uses) |
| Wartet auf Bestätigung | Documents with `intake_status = 'pending_confirmation'` |
| Verarbeitung fehlgeschlagen | Documents with `status = 'failed'` |
| Offene Zuordnungsvorschläge | `suggested` matches on a transaction booked in the period |

Each item's link opens the list that resolves it, **narrowed to the same period** by the
plain `?from=`/`?to=` date range the three target pages now accept (the inbox,
`/dashboard/finance/zuordnung`, `/dashboard/finance/offene-posten`). Before that range
existed, a period-scoped count opened an all-time list: "24 Buchungen ohne Beleg" for 2025
opened a page of 28 rows from every year there has ever been, and a number nobody can
reproduce on the page it points at teaches the reader to distrust the whole page.

Plain ISO dates, never `?period=`: `ClosingPeriod` lives here, and this module already depends
on documents and payments, so making those understand a period would invert the dependency. A
date range is also a filter worth having on its own. `closing-repository.db.test.ts` pins the
resulting invariant against real Postgres - for one period, each count equals the length of
the list its link opens.

"Offene Zuordnungsvorschläge" counts DISTINCT transactions, not `document_transactions` rows,
because "Zuordnung" lists transactions and one transaction can carry several open suggestions.
Counting rows would print a number nobody can reproduce on the page the item links to, which
is the failure this check exists to prevent. A db test pins it: two open suggestions on one
transaction count as one.

**Known divergence, not yet decided:** "Belege ohne Zahlung" counts the EFFECTIVE payment
status (`open`/`overdue`, no direction filter), while "Offene Posten" lists the STORED status
(`open`/`partially_paid`/`overdue`) AND requires a direction. So a `partially_paid` document
not yet due is listed but not counted, and an `open` document with no direction is counted but
not listed. Both are zero in the owner's data today. Deciding it means deciding whether
"ohne Zahlung" includes a partly paid invoice, which is a product question.

## The export's layout

```
abschluss-2026-01.zip
├── uebersicht.xlsx
│   ├── "Dokumente"     Nr., Datum, Name, Gegenpartei, Art, Richtung, Betrag, Währung,
│   │                   Rechnungsnummer, Zahlungsstatus, Zugeordnete Buchungen, Datei
│   ├── "Buchungen"     Nr., Datum, Konto, Betrag, Währung, Gegenpartei, Verwendungszweck,
│   │                   Zugeordnete Belege, Status
│   └── "Zuordnungen"   Beleg-Nr., Belegdatum, Beleg, Belegbetrag, Währung, Buchungs-Nr.,
│                       Buchungsdatum, Buchungsbetrag, Zugeordneter Betrag
├── belege/
│   ├── 2026-01-15_Bauwerk-Generalbau_a1b2c3d4.pdf
│   ├── 2026-01-20_Kontoauszug_bb77ee10.xml
│   └── 2026-01-31_Apple_0f3c91aa.csv
└── ausgangsrechnungen/
    └── 2026-01-25_Kunde_cafe0001.pdf
```

**The two folders:** a document whose `direction` is `outgoing` is evidence the workspace
ISSUED and lands in `ausgangsrechnungen/`; everything else, incoming documents and everything
with no direction at all (a report, a bank statement), lands in `belege/`. A handful of
outgoing invoices were unfindable among seventy incoming ones, and they are a different thing.
The decision is made once, in `closingDirectoryFor`, and de-duplication runs per full path, so
the same file name in the two folders is not a collision.

**File naming:** `<folder>/<effective date>_<generated name, slugified>_<first 8 characters of
the document id>.<extension>`. Date first so an alphabetical listing is chronological; the
generated name (decisions/0059) so a human recognizes the file; the id slice so two documents
with the same name on the same day cannot collide. The slug transliterates German letters
(`Müller` -> `Mueller`, `ß` -> `ss`), strips diacritics, collapses every other non-alphanumeric
run to `-`, and truncates at 60 characters - no slash, dot, space, quote or control character
survives. The extension is the one the **media type** calls for, not always `.pdf`: a bank
statement stays `.xml` or `.mt940`, an app-store report `.csv`. A searchable PDF, where
processing produced one, is kept instead of the original and is always `.pdf`.

The workbook's "Datei" column and the archive entry are the same string by construction: both
are read out of one `assignBelegFileNames` result.

**The cross references.** Each sheet's first column is its own "Nr.": `D-001`, `D-002`, ... on
Dokumente and `B-001`, `B-002`, ... on Buchungen, numbered in that sheet's own row order.
"Zugeordnete Buchungen" and "Zugeordnete Belege" then hold the counterparts' numbers, comma
separated (`B-012, B-031`), and stay empty when there is none. They used to be bare counts,
which showed both sides of a pairing but never which belonged to which.

A confirmed counterpart can have no number here, and is then NAMED rather than dropped:

| Case | Cell |
| --- | --- |
| Its own date lies outside the period (a January booking settling a December invoice) | `außerhalb des Zeitraums (14.12.2025, 20,00 EUR)` |
| Its date lies inside the period but it is not a row of this workbook (today only a clearing account's own transactions, which the Buchungen sheet omits by design) | `nicht in dieser Übersicht (16.01.2026, 0,80 EUR)` |

Each is one `Closing.export` message (plus a date-only variant for a document that carries no
amount at all), formatted by the route, which owns the locale. The two are deliberately
different sentences: "außerhalb des Zeitraums" would be a false statement about a clearing
row. A marker contains commas of its own (a German amount does), so a cell holding one is
meant to be read by a human, not split by a machine.

The third sheet, **"Zuordnungen"**, holds one row per confirmed pairing that touches the
period, both sides named, so the pairing can be read without jumping between the other two
sheets. A side with no row here carries its label in place of a "Nr."; its date and amount are
real values either way, and the "Beleg" name column stays empty for a document this workbook
does not list. "Währung" is the document's own (the column sits beside "Belegbetrag"): where a
document and the booking that settled it are in different currencies - the owner's USD
invoices paid from a EUR account - the Buchungsbetrag beside it is in the account's currency,
not in that one.

The "Status" column on the Buchungen sheet still answers "fehlt hier etwas" on its own:
`zugeordnet` / `kein Beleg nötig` / `offen`.

## Practical size limit

The archive is **streamed**: `uebersicht.xlsx` is written first, then each document's bytes are
fetched from object storage, appended, and released before the next one is fetched
(`export-archive.ts`'s `appendAndDrain` waits for archiver to finish each entry, which is what
makes that true rather than merely intended). Peak memory is therefore roughly *the largest
single document* plus the workbook, not the size of the archive - a 5 GB year is no more
memory than a 50 MB month.

What does bound it is **wall clock**: the route's `maxDuration` is 60 seconds, and every
document costs one object-storage round trip. At a realistic 50-150 ms per object that is
comfortable for a month (tens to low hundreds of documents) and fine for most years; a
workspace with several thousand documents in one year can time out, and the fix then is to
export month by month. The row queries themselves are not the limit: both are single indexed
scans, and the workbook stays a few hundred kilobytes even for a full year.

Two further known limits, both accepted for now: the ZIP is written in the classic (non-Zip64)
format, so a single archive above 4 GB or 65,535 entries would need `forceZip64`; and because
the response streams, a failure after the first byte can only truncate the download, never turn
into an error status.

## Access

`finance.read` (admin-only, `src/platform/access`), the same gate as the rest of
`/dashboard/finance/**`: `/dashboard/abschluss` checks
`access.permissions.includes(PERMISSIONS.financeRead)` and then `notFound()`, and
`GET /api/closing/export` uses `workspaceAccess(PERMISSIONS.financeRead)` and answers
`{ errorCode }` JSON on failure. There is no member-level view of either: the check counts bank
transactions and the export contains every amount in the period
(decisions/0024-accounts-and-transactions.md's "a bank statement exposes salaries").

The workspace always comes from the resolved session. The only thing a caller may choose is the
period, which `parseClosingPeriod` validates to a bounded `YYYY-MM`/`YYYY` before it reaches
any query.

## Dependencies on other owners

`@/modules/documents` (`documentDisplayName`/`documentNameSource`), `@/modules/intake`
(`MT940_MIME_TYPE`), `@/platform/access`, and `src/persistence`'s contracts plus
`ClosingUseCases`. The document files themselves are read through
`DocumentUseCases.getFileForDownload`, the same workspace-scoped read
`GET /api/documents/[id]/file` serves - this module never touches
`@/platform/object-storage` directly.

## Tests

- Unit (no DB): `tests/period.test.ts` (parsing, bounds, February, the selector's options),
  `tests/report.test.ts` (every key present, `complete` vs. `empty`, one gap never hides
  another), `tests/file-names.test.ts` (transliteration, path-traversal and control characters,
  truncation, the media-type table, collisions), `tests/document-name.test.ts` (report,
  statement, counterparty, sender, and the never-for-outgoing rule),
  `tests/cross-references.test.ts` (the numbering, both directions of a reference, a pairing
  counted once although both sides know it, the out-of-period and the not-listed label, a
  document with no amount of its own), `tests/export-workbook.test.ts` (real `Date` and
  `number` cells, read back through exceljs),
  `tests/export-archive.test.ts` (a valid ZIP, one entry in flight at a time, failure destroys
  the stream), and `tests/export.test.ts` (the whole assembly against stubbed read models: the
  archive's name, a searchable PDF kept as `.pdf` while a never-OCR'd statement keeps `.xml`,
  an outgoing invoice under `ausgangsrechnungen/` while everything else stays under `belege/`,
  and - by unzipping `uebersicht.xlsx` back out of the archive - that the "Datei" column holds
  exactly the paths the archive actually contains, that every "Nr." a cell points at resolves,
  and that the "Zuordnungen" sheet pairs an in-period and an out-of-period side correctly).
- DB (`src/persistence/tests/closing-repository.db.test.ts`, real Postgres): which date puts a
  document in a period for all four `coalesce` arms, that the period scoping and the inbox's
  ordering agree, the four document counts, the transaction counts against exactly
  `countUnmatched`'s conditions, the transaction list's account/currency/linked documents, the
  suggestion count scoped by its transaction's booking date, and the confirmed links
  themselves from both sides (a counterpart outside the period, a mere suggestion ignored, and
  a linked platform report read with the same effective-date and settlement-line-sum
  expressions the Dokumente sheet uses) - all of it workspace-scoped.
