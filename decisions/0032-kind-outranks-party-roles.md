# Direction: `documents.kind` outranks the analyzer's party roles

Document type: decision
Lifecycle: active
Owner: src/modules/documents
Scope: The priority order inside `decideDirection`, specifically that the intake classifier's
`kind` decides an invoice's direction before the analyzer's own `parties[].role` labels are
consulted
Canonical responsibility: Active source for why the model's role labels are the weaker signal and
`kind` the stronger one, and what evidence established that
Maintenance triggers:
- The analyzer or the intake classifier changes model, prompt or output shape
- A new `DocumentKind` carries an implied direction
- Role labels become reliable enough to promote again (for example with a larger chat model)
Last verified: 2026-09-21, against the owner's real outgoing invoice

## Status
Accepted

## Context

`decisions/0031-direction-from-kind-and-short-invoice-numbers.md` introduced a four-step priority
order and kept the analyzer's party roles at step 1, on the assumption that an explicit
own-company role is the strongest available signal. Testing that change against the document it
was written for disproved the assumption within minutes.

The document is an invoice the owner's own company issued. Four consecutive processing runs, same
prompt, same model (`ministral-8b-latest`, the only chat model this API key may use):

| Run | What the analyzer returned | Resulting direction |
|---|---|---|
| 1 | own company as `sender`, customer as `recipient` | `unknown` (own company not yet recognizable, workspace name was stale) |
| 2 | same, plus a "musterfirma" party | `unknown` |
| 3 | customer as `sender`, own company **absent**, "MUSTERBANK PAYMENTS" mentioned | `unknown` |
| 4 | customer as `sender`, own company as **`recipient`** | `incoming`, which is wrong |

In run 4 the priority order worked exactly as 0031 specified and still produced the wrong answer:
the model claimed the owner had received their own invoice, step 1 believed it, and step 2 never
ran. `documents.kind` was `outgoing_invoice` in every one of the four runs.

A wrong direction is worse than no direction: it survives as data, sets `payment_status`, and
sends the document down the wrong side of payment matching.

## Decision

`directionFromKind(kind)` runs first. Only when `kind` carries no direction of its own (a letter,
a contract, an authority letter, an unclassified document) do the party roles decide, followed by
the deterministic own-company-in-text check and finally `unknown`. Everything else from 0031
stays as it is.

## Consequences

- Positive: the direction of an invoice now rests on the signal that was right every time,
  produced by a separate call with a much narrower question ("what kind of document is this")
  than "who are the parties and what role does each play".
- Positive: a mislabelled own-company party can no longer invert the direction of an invoice.
- Negative: a misclassified `kind` now inverts it instead. That risk is real but was observed to
  be far smaller, and a wrong `kind` is visible in the inbox filter, where a user can correct it,
  while party roles are invisible.
- Neutral: documents whose kind carries no direction are unaffected, and so are the integration
  fixtures, which all resolve through an own-company party.

## Supersedes / Superseded By
- Amends `decisions/0031-direction-from-kind-and-short-invoice-numbers.md`'s priority order (its
  steps 1 and 2 swap). Everything else in 0031, including the short-invoice-number keyword
  exception, remains in force.
