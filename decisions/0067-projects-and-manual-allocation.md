# Projects: one manual allocation primitive, net amounts, nothing automatic

Document type: decision
Lifecycle: proposed
Owner: src/modules/projects (not built yet)
Scope: What a project is, how an amount reaches one, and which amount is counted
Canonical responsibility: Active source for the internal controlling model
Maintenance triggers:
- Automatic assignment is reconsidered (read "Nothing is automatic" first)
- A second currency becomes common (read "Foreign currency" first)
- Time or effort is reconsidered (read "No effort" first)
Last verified: 2026-10-02, against the owner's own 2025 platform reports

## Status

Proposed. Design agreed with the owner; implementation sequenced after
decisions/0066-abschluss-check-and-export.md lands.

## Context

The owner wants the product to double as internal controlling: create projects, track costs
and revenue against them, see a per-project picture. The business is mostly apps (three
of them in the sample data) plus occasional website work.

Three measurements shaped the design:

| | |
| --- | --- |
| Google settlement lines carrying an app name | 900 of 904 |
| Apple settlement lines carrying an app name | **0 of 36** (the payment summary aggregates by country, not by app) |
| Apple share of 2025 app revenue | 900,00 EUR of 3.200,00 EUR, about 28 % |

An earlier draft proposed automatic attribution by product. Parsing the Google product title
for it misfiled 40 lines and about 300 EUR (13 %), because an app title can itself contain
parentheses ("Lifetime, all features!) (Example App ...") and Google sometimes
appends a quantity suffix ("(x4)"). The stable key would have been the report's Package ID,
which this product does not currently store.

The owner cut that whole branch: assignment is manual.

## Decision

**A project is a container**: name, status, optional customer contact, optional start and end.
Overhead is not a special concept; the owner creates an "Allgemeinkosten" project like any
other.

**One primitive: a part of a document's amount goes to a project.** A document may carry many
such allocations. This is the whole mechanism, and it covers every case with no second
feature: an Apple month split across three apps, a hosting bill split across apps, a domain
bill allocated whole to Allgemeinkosten, an outgoing invoice allocated whole to a website
project.

**Nothing is automatic.** No product rule, no contact rule, no rules engine. The one
concession the owner accepted is a **pre-filled split for Google reports**, whose app names
are in the file: the rows are presented filled in and the owner confirms or edits them.
Nothing is ever booked without that confirmation, the same shape payment matching already
uses. Apple reports have nothing to pre-fill from, so they are typed.

This also removes a problem the earlier draft had created: since the split is entered by hand,
Apple's aggregated payment summary is sufficient and no second Apple report type is needed.

**Three invariants keep it honest:**
- The allocations of a document may never exceed its amount. A hard constraint, not a warning.
- The unallocated remainder is always visible, per document and as its own line in the
  overview. "Allgemeinkosten" (decided: belongs to no product) and "nicht zugeordnet" (not
  looked at yet) are different states and must never collapse into one.
- Amounts are **net**. Platform revenue is reverse charge and carries no VAT, while most costs
  are gross; mixing them would understate every app project by roughly 19 %.

**The amount of a document is not one field.** For an invoice it is `total_amount_cents`; for a
platform report that column is empty on all 24 of the sample reports, and the amount is the
sum of its settlement lines. The allocation UI has to know both, or Apple would offer 0,00 EUR
to distribute.

**Foreign currency resolves through the bank.** A USD invoice is allocated by the EUR amount of
its matched bank transaction, which is what it actually cost including the exchange rate, and
keeps a project's total in one currency.

**A cost counts on its invoice date**, the same effective date the inbox and the Abschluss
already sort by (decisions/0058, 0060, 0061). Not the payment date: an EUR is cash-based, but
this is controlling, not a tax return, and the product only feeds the tax advisor
(decisions/0066).

## Consequences

- Roughly 170 allocations a year at a typical small-studio volume (12 Google reports times about
  four apps, 12 Apple reports the same, about 70 cost documents with one each), so about 15 a
  month. The Google pre-fill halves it.
- A bulk view of unallocated documents is part of the first build, not a later nicety. Without
  it the work is done one detail page at a time, which means it is not done, which means the
  controlling numbers are quietly wrong.
- Website projects will show close to 100 % contribution, because the founder's own work is not
  counted. The figure is therefore labelled "Deckungsbeitrag", never "Gewinn".
- Storing the Google Package ID is no longer needed for this feature. It remains the right key
  if automatic assignment is ever revisited.

## No effort, no time tracking

Deliberately out of scope, by the owner's decision. Nothing records hours, and nothing
estimates them.

## Alternatives considered

- **Rules engine (product id or contact to project).** Rejected by the owner: control over
  every assignment is worth more than the typing it saves, and a rule that silently misfiles is
  worse than a blank field.
- **Allocating overhead across projects by a key.** Rejected: it invents a precision nobody
  has. A visible "Allgemeinkosten" project says the same thing honestly.
- **Allocating settlement lines individually.** Rejected: about 900 Google lines and 40 Apple lines a
  year is not a human-scale unit. The document (one monthly report) is.
- **Fetching Apple's per-SKU financial report.** No longer necessary, see above.
