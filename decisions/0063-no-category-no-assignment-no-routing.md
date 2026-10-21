# No category, no assignment, no routing

Document type: decision
Lifecycle: active
Owner: src/modules/documents
Scope: The removal of `documents.category_id`/`category_source`, the `categories` table,
`documents.assignee_user_id`, the `category_routes` table, `/dashboard/routing`, the assignment
notification, and the `routing.manage` permission
Canonical responsibility: Active source for why a document has no category, no assignee and no
routing rules
Maintenance triggers:
- Someone proposes a second document taxonomy again (read "Context" first)
- Multi-person workflow is reconsidered (read "What this costs" first)
Last verified: 2026-09-23, against the owner's own 107 documents and 0 routing rules

## Status

Accepted. Removes what decisions/0015-documents-and-quotas.md (the category taxonomy) and
decisions/0016-processing-pipeline-and-ai.md (routing and the assignment notification) built,
and drops `routing.manage` from decisions/0014-workspaces-and-access.md's permission bundles.

## Context

The product carried two overlapping taxonomies. `kind` (`@/modules/intake`'s `DOCUMENT_KINDS`,
decisions/0020-universal-intake.md) says what a document IS and drives real behaviour: the
direction decision, payment matching, which deterministic reader runs, which clearing account a
settlement lands in. `category_id` (ten fixed global rows, from the original architecture brief)
was meant to say what a document is ABOUT, and its only functional consumer was routing: a rule
mapping a category to a team member, which then assigned the document and emailed them.

Four of the ten categories duplicated a kind outright (Rechnung, Mahnung, Vertrag,
Behördenschreiben). Measured against a real workspace (numbers rounded for this document):

| | |
| --- | --- |
| Documents with a category | 80 of 100, every one of them "Rechnung" |
| Documents with no category at all | 20 (every tabular import) |
| Routing rules ever created | 0 |
| Documents ever assigned to anyone | 0 |

So the category distinguished nothing, the routing it fed was never configured, and the
assignment that routing produced never happened. The three together cost a filter in the inbox,
a control on the detail page, a field the model had to guess on every document, a permission, a
settings page, an email template, a job, two tables and their repositories.

There is a real argument for a second dimension: an insurance invoice is an invoice by kind and
insurance by topic, and one list cannot say both. The owner weighed that and decided against
keeping the dimension on the strength of a hypothetical, while the product is a single-person
bookkeeping tool in practice.

## Decision

Remove all three, completely: schema, repositories, use cases, actions, pages, permission,
email, job, i18n namespaces and tests. Not hidden behind a flag, not left as dead columns.

`kind` is the product's one taxonomy.

## What this costs

Stated plainly, because this is the kind of removal that gets rediscovered as a regression:

- **The product can no longer hand a document to a person.** Every member sees the same inbox,
  and nothing marks a document as someone's job. Digipost is a shared archive with a payment
  engine, not a workflow tool. The marketing copy and README that promised "an die richtige
  Person weitergeleitet" are corrected in the same change rather than left standing.
- **Topic is no longer a facet.** Finding all insurance correspondence means full-text search,
  which works, rather than a filter, which was precise.
- **Reintroducing any of it is a new build**, not a revert: the tables are dropped and the data
  with them.

Accepted because none of it was in use, and because a feature nobody configured is a feature
that gets in the way of the ones they do use.

## Consequences found while removing it

Taking the two `LEFT JOIN`s (categories, assignee) out of the inbox's `list()` query left that
query with a single table, which changes how drizzle qualifies column names: the correlated
subquery that resolves a document's counterparty (decisions/0059-generated-document-names.md)
compiled to an unqualified `"id"`/`"direction"`, collided with `contacts.id` inside the
subquery, and silently returned no counterparty at all. The subquery now spells those two
columns out as already-qualified SQL rather than relying on drizzle's column-proxy
interpolation. Worth remembering: removing a join can change the SQL of a clause that has
nothing to do with it.

## Alternatives considered

- **Keep the category, strip the four duplicate values, rename it "Sachgebiet".** This was the
  recommendation, and it preserves the invoice-and-insurance case. The owner rejected it: the
  dimension is only worth its weight once non-financial mail actually arrives, and it can be
  built then against real examples instead of guessed ones.
- **Keep assignment without routing.** Rejected: assignment with no rule behind it is a manual
  step in a single-person workspace, and it was the mechanism routing existed to drive.
- **Leave the columns in place and hide the UI.** Rejected: a column nothing writes is a trap
  for the next person reading the schema, and the model would have kept guessing the field.
