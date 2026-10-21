# Extraction direction and invoice fields: pipeline integration on top of C1's contacts model

Document type: decision
Lifecycle: active
Owner: src/modules/documents, src/platform/mistral, src/modules/workspaces
Scope: Extending the ONE existing analyzer call (decisions/0016-processing-pipeline-and-ai.md)
with per-document party extraction and invoice-shaped fields, deciding a document's
`incoming`/`outgoing`/`unknown` direction in code from those parties and the workspace's own
company profile, linking non-own parties into C1's contacts model
(decisions/0019-contacts.md), the onboarding/settings UI that collects and edits the company
profile those decisions rely on, and the minimal document/inbox UI surface this phase adds
Canonical responsibility: Active source for why direction is decided in code (never trusted
from the model), the exact linking-role resolution between an extracted party's own role hint
and the direction-implied role, why invoice amount/currency parsing is deterministic code
rather than model arithmetic, and which new permission bundle gates the company profile UI
Maintenance triggers:
- The direction decision matrix or the linking-role resolution changes
- The invoice field set, the amount-parsing rules, or the currency-inference rule changes
- The system prompt's own-company context format changes
- C3 finalizes the contacts UI route and this ADR's assumed `/dashboard/contacts/[id]` path
  turns out wrong
Last verified: 2026-09-20, C2 (pipeline integration)

## Status
Accepted

## Context

C1 (decisions/0019-contacts.md) built the contacts data model, matching, and verification
semantics, but deliberately shipped no extraction-prompt integration: `upsertFromExtraction`
existed as a stable contract with nothing calling it yet. This phase (C2) is the pipeline
integration: extending `src/platform/mistral`'s single analyzer call
(decisions/0016-processing-pipeline-and-ai.md, "never a second model call") to also extract
up to 3 parties per document plus invoice-shaped fields when the document is an
invoice/reminder/receipt, deciding whether the document is `incoming` or `outgoing` from
those parties, and linking every non-own party into C1's contacts model.

The central design constraint carried over from C1 applies here just as strongly: the model's
own output is never trusted for anything that matters. Direction is not a field the model
fills in - it is computed in code from the model's per-party `role` hints and C1's
`isOwnCompany`. Amounts are not the model's own arithmetic - they are parsed in code from the
raw text exactly as printed on the document. This mirrors decisions/0016's existing rule for
category/title/date and decisions/0019's rule for the contact fields themselves.

## Decision

### 1. One analyzer call, extended output

`src/modules/documents/core/ports.ts`'s `DocumentAnalyzer.analyze()` gains an `ownCompany`
input parameter (`OwnCompanyContext`: the workspace's own name/address/VAT id, or `null` when
the admin has not filled in a company profile yet) and its `AnalysisResult` gains `parties:
ExtractedParty[]` (up to 3, each `{ role: DocumentContactRole } & ExtractedContactData` - C1's
own extracted-contact shape, reused directly rather than redeclared) and `invoice:
InvoiceFields | null`. The real Mistral adapter's system prompt
(`src/platform/mistral/server/prompts.ts`) asks for exactly this shape in one JSON response,
including a "das sind wir" block naming the workspace's own company so the model can label the
correct party as `recipient` (or `sender`, for the workspace's own outgoing invoices) instead
of guessing. `src/modules/documents/core/analysis-validation.ts`'s `validateAnalysisResult`
validates and clamps both new fields exactly as leniently as the existing ones (a malformed
party is dropped, not rejected; an unrecognized role degrades to `"mentioned"`, never
auto-trusted as `sender`/`recipient`).

### 2. Amount parsing is deterministic code, never model arithmetic

`src/modules/documents/core/amount-parsing.ts`'s `parseGermanAmountToCents` takes the raw
amount text the model is asked to reproduce "exactly as printed" (e.g. `"1.083,68 EUR"`) and
parses it deterministically: the last `.`/`,` before a 1-2 digit tail is the decimal separator,
anything else (including a 3-digit group, e.g. `"1.083"` alone) is a thousands separator.
Handles a leading/trailing `-` or accounting-style parentheses as a negative (credit note)
amount. `inferCurrency` prefers a plausible ISO 4217 code from the model, falling back to
`"EUR"` only when the raw text itself contains a euro sign or the word "EUR"/"Euro" - never a
guessed currency with no textual basis. Both are pure, unit-tested against the exact table
this phase's own tests exercise: `1.083,68`, `1,083.68`, `1083.68`, `EUR 12`, and
negative/credit-note variants.

### 3. Direction: decided in code, own-company match first

`src/modules/documents/core/direction.ts`'s `decideDirection(parties, ownCompany)` (pure,
takes C1's `isOwnCompany` and `OwnCompanyProfile`):

1. The workspace matches a party with `role: "recipient"` -> `"incoming"`.
2. Else the workspace matches a party with `role: "sender"` -> `"outgoing"` (checked second,
   deliberately: a reply thread that lists the workspace in both roles reads as incoming, the
   more common case for a scanned-mail inbox and the safer one to default to when the model
   contradicts itself).
3. Else, if the workspace does not appear among the parties AT ALL but there is EXACTLY ONE
   other party and the model marked it `sender` -> `"incoming"` (the common case: a plain
   scanned letter where the model extracts the sender block but never repeats the recipient's
   own address back to them).
4. Otherwise -> `"unknown"`.

`documents.direction` (`incoming|outgoing|unknown`) is `null` until processing has run at
least once, then always one of the three values - the same lifecycle
`title`/`sender`/`documentDate` already have.

### 4. Linking: the resolved counterparty's role wins, others keep their hint

`nonOwnParties` filters out every party `isOwnCompany` matches (never trusted from the model's
own label - the code check always wins, decisions/0019's own-company exclusion). Of the
remaining parties, `resolveLinkRoles` forces exactly one - the first party whose own role hint
does not already match what `direction` implies - to the directionally-correct role
(`"sender"` for an incoming document, `"recipient"` for an outgoing one); every other non-own
party (a debt-collection agency writing `on_behalf_of`, an insurer CC'd as `mentioned`) keeps
its own extracted role hint unchanged. `src/persistence/use-cases/documents-use-cases.ts`'s
`processDocument` then calls C1's `upsertFromExtraction` once per resolved party, inside its
own try/catch: a single contact-linking failure is logged and skipped rather than failing an
otherwise-successful OCR/categorization run. This is idempotent across a retry -
`upsertFromExtraction`'s own matching finds the same contact again (assuming the extraction is
deterministic, which the fake analyzer is and the real one usually is for an unchanged
document), and `document_contacts`'s composite primary key makes `link` itself a no-op the
second time.

`documents-use-cases.ts` reads the workspace's own company profile directly off the already
fetched `WorkspaceRow` (its plain `company_*` columns, decisions/0019) rather than adding a
`workspaces` use-case dependency - the same "read another owner's row directly inside a use
case" pattern `reassign` already uses for `workspaceMember.findByUserId`. `contacts` (C1's
`ContactUseCases`) is injected as a new dependency of `createDocumentUseCases`, built before
`documents` in the composition root (`src/persistence/composition/create-request-services.ts`)
the same way `billing` is handed to `documents` for `recordDocumentsCreated`.

**Read path**: `documents-use-cases.ts` also gains `getLinkedContacts(workspaceId,
documentId)`, reading `documentContact`/`contact` directly off the `Repositories` bundle
already available inside that use case, rather than adding a method to
`src/persistence/use-cases/contacts-use-cases.ts` (C1's own file - not edited by this phase;
`contacts-use-cases.ts`'s only other in-flight consumer, C3, is scoped to add `actingUserId`
to `mergeContacts` and nothing else this round). This is a read, not a write, so it does not
violate "only the owner writes" - it mirrors `reassign`'s existing read of
`workspaceMember`.

### 5. Persisted columns

`documents` gains `direction`, `invoice_number`, `total_amount_cents` (integer, negative for a
credit note), `currency`, `due_date`, `payment_iban`, `payment_reference`, `paid_note` - all
nullable, plus a non-unique index on `(workspace_id, invoice_number)` (an invoice-number
sequence is not guaranteed unique workspace-wide across different senders, and `null` is the
common case for a non-invoice document, so a unique index would be wrong here even before
considering the null case).

### 6. Own company profile: onboarding and settings

`/onboarding`'s form now also collects the company's address (`addressLine1` required,
`addressLine2` optional, `postalCode`/`city` required, `country` defaulting to `"DE"`) and an
optional VAT id, stored via C1's `updateCompanyProfile` right after `createForUser` in the
same `createWorkspaceAction` call - no separate permission check needed for that specific
call, since the freshly created workspace's creator is its sole admin either way. A new
admin-only page, `/dashboard/settings/company` ("Firmendaten"), edits the same fields for an
existing workspace, gated by a new permission bundle,
**`PERMISSIONS.companyProfileManage`** (`"company_profile.manage"`, admin-only) -
`src/platform/access`'s `PERMISSIONS` had no existing bundle that precisely named "manage the
workspace's own company profile" (decisions/0019's own "Consequences" section flagged this gap
and left the choice to this phase). A dismissible-per-session banner
(`sessionStorage`, `useSyncExternalStore` rather than `useState`+`useEffect` to avoid both a
hydration mismatch and this repository's lint rule against synchronous `setState` calls inside
an effect body) on `/dashboard` points admins at the settings page whenever
`addressLine1`/`postalCode`/`city` are still empty - covering every workspace created before
this phase.

### 7. UI surface (minimal - C3 owns the contacts pages)

The document detail page shows the direction badge ("Eingang"/"Ausgang", nothing rendered for
`unknown`), the invoice fields when any are present, and the linked contacts with their role
and an "unbestätigt" badge for an unverified contact, linking to
**`/dashboard/contacts/[id]`** (the path C2 and C3 agreed on as fixed for this round). The
inbox gains a direction filter (Eingang/Ausgang/Alle) in the URL's search params
(`documentListQuerySchema`) and shows the extracted amount, formatted in the document's own
currency (falling back to EUR), when present.

## Consequences

- Positive: every "never trust the model" guarantee C1 established for contact fields now
  extends to direction and invoice amounts too - both are pure, dependency-free, unit-tested
  functions (`core/amount-parsing.ts`, `core/direction.ts`) callable independently of the
  database or any adapter.
- Positive: `getLinkedContacts` living on `DocumentUseCases` instead of `ContactUseCases`
  keeps `contacts-use-cases.ts` untouched this round, honoring the file-scope boundary the
  orchestrator drew between C2 and C3 for that specific file.
- Negative: `resolveLinkRoles`'s "force exactly the first non-matching party to the
  directionally-correct role" heuristic is a judgment call, not something the brief specified
  precisely - a document with more than one plausible counterparty and no party already
  carrying the expected role could pick the "wrong" one to force. Accepted as a reasonable
  default; `mergeContacts` (C1) remains the correction path if it ever misfiles a document
  under the wrong contact.
- Negative: a contact-linking failure inside `processDocument` is logged and swallowed rather
  than failing the job - an otherwise-successful OCR/categorization run is not rolled back
  over a contacts-side error, but this means a linking failure is only visible in logs, not
  the document's own `errorCode`. Accepted: linking is additive information, not something the
  inbox's core promise (an OCR'd, categorized, routed document) should depend on.
- Negative: `resolveLinkRoles`'s "first party" heuristic and `decideDirection`'s "exactly one
  other party" fallback both assume the model's own party ORDER is meaningful (most important
  first) - true for both the fake analyzer and the real prompt's own instruction ("die
  wichtigsten zuerst"), but not something the code can verify.
- Implementation status: **implemented** (C2). Schema (`documents`'s new columns and index),
  the extended `DocumentAnalyzer` port and both adapters (real Mistral, fake), direction/
  linking logic, the onboarding/settings UI, the dashboard banner, and the minimal document
  detail/inbox UI surface all land in this phase. **Not implemented yet, explicitly out of
  scope for C2**: the contacts list/detail/proposal-review UI itself (C3), and wiring a
  "relation type hint" from extraction into `contacts.relation_type` (the brief's own
  extraction field list names this, but `@/modules/contacts`'s `ExtractedContactData` - C1's
  locked contract this round - has no such field; adding one would mean editing
  `contacts-use-cases.ts`, out of scope for C2's file assignment. A future phase can add it as
  an additive field once that file is open for changes again).

## Supersedes / Superseded By
- None
