# A document is named after who it is with, and a row shows only what asks something

Document type: decision
Lifecycle: active
Owner: src/modules/documents
Scope: The generated name an inbox row shows, and which chips a row still carries
Canonical responsibility: Active source for how a document is labelled in a list
Maintenance triggers:
- The counterparty role per direction changes (`documents-repository.ts`'s `list` subquery)
- A new chip is proposed for the inbox row (see "Only what asks something" below)
- `SHORT_COMPANY_NAME_MAX_LENGTH` or the display-only legal forms change
Last verified: 2026-09-23, against a sample workspace of about a hundred documents

## Status

Accepted. Builds on decisions/0058-inbox-sorts-by-the-document-s-own-date.md.

## Context

Two problems in the same list row, raised by the owner together.

**The name was whatever the file was called.** "Rn_42_Bauwerk Generalbau München.pdf",
"Invoice-E725A309-0031.pdf", "xv-pacs_invoice_Azz7doV7iqajT1.pdf", "financial_report (5).csv".
Every sender names files their own way, so the column that should let you scan a list was the
one column with no shared shape at all. The analyzer's `title` was the fallback, which is better
prose but no more uniform.

**Every row carried four chips that always said the same thing.** "Rechnung", "Eingang",
"Bezahlt", "Verarbeitet": on a healthy inbox that is four labels per row stating that nothing is
wrong, competing for attention with the two or three rows where something is.

## Decision

**The name is generated: the counterparty, then the document's own date.** "Bauwerk Generalbau,
24.11.2025".

- The counterparty is the contact linked in the role the document's direction makes the other
  party: the `sender` of an incoming document, the `recipient` of an outgoing one. In the
  the sample data every one of the OCR'd documents has exactly one such link.
- `documents.sender` is only a fallback, and never for an outgoing document. Checked against
  real data: for all nine outgoing invoices that column held "musterfirma", the workspace's own
  company, because the sender of an outgoing invoice is us.
- A document with no linked contact at all (every tabular import) falls back to its file name
  without the extension, so a row always shows something.
- The date half follows decisions/0058: the document's own date, or the upload date labelled
  "Eingang" when it has none.
- Nothing is stored. The name is derived per render, so correcting a contact's name corrects
  every document filed under it, with no migration and nothing to keep in sync.

**Company names are shortened for display** (`shortenCompanyName`, owned by
`src/modules/contacts`, which owns what a company is called): the legal form comes off, then the
rest is cut at a word boundary past 22 characters. A German legal form is found by asking
`normalizeName` whether dropping a trailing word changes the normalized name, so no second list
of German suffixes exists. Non-German forms ("Inc", "Ltd", "SE", ...) come off through a
display-only list that `normalizeName` never consults: that function decides whether two names
are the same company (decisions/0019-contacts.md), and widening its list to make a label read
better would change matching behaviour.

**Only what asks something of the reader stays on the row.** The four always-on chips are gone;
what remains is "Bestätigung nötig", "überfällig", "Fehlgeschlagen", and the spinner while a
document is still processing, plus the amount and the assignee. Category, direction and payment
status remain filters in the bar above, and all of it stays on the detail page.

The analyzer's `title` moves to a muted second line: it is the one genuinely informative free
text a document carries, and it no longer has to double as an identifier.

## Consequences

- The counterparty costs one correlated scalar subquery per listed row. A join was rejected
  outright: decisions/0019-contacts.md allows several contacts in the same role on one document
  (a debt collector writing for a creditor), and a join would then return that document twice
  and break offset pagination. A db test pins exactly that case.
- `ListDocumentsResult` now carries `DocumentListRow`, a type of its own, rather than adding a
  field to `DocumentWithRelations` that every other read would leave `null`.
- A "Bezahlt" document now looks exactly like an ordinary one in the list. That is intended: the
  absence of a warning is the information.
- Two documents from the same counterparty on the same date show the same name. They stay
  distinguishable by amount and by their subject line, and the detail page still shows the
  original file name.

## Alternatives considered

- **Store the generated name on the document.** Rejected: it would need a migration, a backfill,
  and a rewrite whenever a contact is renamed or a document is reclassified, all to avoid a
  string concatenation.
- **Literally the first 10 characters of the contact plus the date**, as first sketched.
  Rejected: "Telekom De" and "Bauwerk Ge" are worse than the file names they replace. Stripping
  the legal form and cutting at a word boundary reaches the same goal and still reads as a name.
- **Keep the chips but grey them out.** Rejected: a quieter version of the same noise.
- **Drop the failure and confirmation chips too**, since the filters cover them. Rejected: those
  are the rows a person has to act on, and a list that hides its own problems is not a work list.
