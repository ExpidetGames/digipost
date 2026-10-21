# An empty search param means absent, not invalid

Document type: decision
Lifecycle: active
Owner: src/modules/documents
Scope: The three list-page query schemas (`documentListQuerySchema`,
`contactListQuerySchema`, `transactionListQuerySchema`) and any future one
Canonical responsibility: Active source for how a `method="get"` filter form's empty fields are
read
Maintenance triggers:
- A new list page with a URL-state filter form is added (wrap its schema the same way)
- A filter field is added to one of the three existing schemas
Last verified: 2026-09-23

## Status

Accepted.

## Context

The owner reported that setting a filter in the inbox, pressing "Filtern" and waiting for the
reload left every filter blank again.

The cause is in the boundary, not the UI. A `method="get"` form submits EVERY field it contains,
so picking one filter and leaving the rest alone produces
`?q=&category=&status=done&direction=&kind=&paymentStatus=&sort=documentDate`. Four of those
empty strings then fail their own field's validation (`z.uuid()` for `category`, `z.enum()` for
`direction`, `kind` and `paymentStatus`), which fails the whole `safeParse`, and the page's
fallback for an unparseable query is "no filters at all". Reproduced directly against the
schema:

```
success: false
issues: category: invalid_format, direction: invalid_value, kind: invalid_value, paymentStatus: invalid_value
```

The same bug was in all three list pages, because all three schemas follow the same pattern:
`/dashboard` (Posteingang), `/dashboard/contacts`, and `/dashboard/finance/[accountId]`. The
accounts one had a second, quieter variant: `minAmountCents: z.coerce.number()` reads `""` as
`0`, so an untouched amount box silently became a "at least 0 euros" filter rather than no
filter.

## Decision

Each of the three query schemas is wrapped in `z.preprocess(blankToUndefined, ...)`, which
replaces `""` with `undefined` across the whole object before any field is validated. An empty
search param is the absence of that filter, which is what the URL actually means, and never a
validation failure.

Applied to the whole object rather than field by field, deliberately: a filter added later is
covered without anyone having to remember this decision exists.

`blankToUndefined` is duplicated in each module's own `core/schemas.ts` rather than shared. That
follows the precedent already set by `optionalText`, which exists twice for the same reason: a
module's validation boundary does not reach into another module for eight lines, and a
`src/shared/` owner would need its own README and structure entry for that.

## Consequences

- Every list page keeps its filters on submit, which is what the forms always looked like they
  did.
- The URL still carries the empty params (`?q=&category=&status=done`). Harmless, and cleaning
  it would need client JS on a form that deliberately has none.
- A genuinely malformed param (a hand-edited `?category=not-a-uuid`) still fails the whole parse
  and still falls back to no filters. That is the correct behaviour for input nobody's browser
  would produce.

## Alternatives considered

- **Strip empty values in each page's own `firstParam` helper.** Rejected: it fixes the three
  callers that exist today and leaves the schema, which is the declared boundary
  (`WEBAPP_TEMPLATE_SPEC.md` §2.5), just as fragile for the next one.
- **Make each field tolerate `""` individually** (`z.union([z.literal(""), z.uuid()])` and so
  on). Rejected: it repeats the same idea once per field and puts the burden on whoever adds
  the next filter.
- **A shared `src/shared/url-query/` owner.** Rejected for eight lines, see above.
