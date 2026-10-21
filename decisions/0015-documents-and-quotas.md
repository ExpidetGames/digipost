# Documents core and quota enforcement

Document type: decision
Lifecycle: active
Owner: src/modules/documents, src/modules/billing
Scope: The documents data model (categories, documents, generated full-text search), the
status machine, the upload path and its limits, the object storage key layout for
documents, and quota enforcement semantics (total/monthly limits, packages, the hard stop)
Canonical responsibility: Active source for why the category taxonomy is fixed and global
for the MVP, how a document moves from upload to storage to a database row inside one
transaction with compensation, why the quota check runs twice (a pre-check and an
authoritative in-transaction re-check), and how a transaction is shared between the
documents and billing use cases without either writing the other's table
Maintenance triggers:
- The category taxonomy changes (a workspace-specific category is added, a key is renamed)
- The upload path's limits (size, page count, supported types) change
- The quota model (tiers, packages, the hard-stop semantics) changes
- OCR/LLM processing (P2b) or billing purchases (P3) land and need to extend this decision
Last verified: 2026-09-19, P2a (documents core + quota enforcement)

> **Note:** quotas are per workspace, and a user may now hold several workspaces
> (decisions/0070-several-workspaces-per-user.md). Nothing is shared between them: each has
> its own tier, its own total and its own monthly limit.

## Status
Accepted

## Context

Digipost's core value proposition (per the architecture brief) is scanning, storing, and
routing a small business's incoming paper mail. Before OCR, categorization, or routing can
exist (P2b), the product needs: a place to put a document (object storage, already wired by
P0a, decisions/0012-object-storage.md), a way to get one in (upload, magic-byte sniffed,
combined into a PDF), a way to find one again (full-text search, filters, pagination), and a
hard stop once a workspace's plan-based capacity runs out (quota enforcement) - Digipost is
metered SaaS, and shipping the routing/OCR pipeline (P2b) before the capacity that pipeline
consumes could ever be capped would let free-tier usage grow unbounded in the meantime.

This phase (P2a) explicitly excludes OCR, LLM categorization, searchable-PDF generation, the
job queue, routing rules, and notification e-mails (all P2b), billing UI and package purchase
(P3), and the camera scanner (P2c). It is designed so those slot in without a data-model or
architecture change - see "Consequences" for exactly where.

## Decision

### 1. Category taxonomy: fixed, global, seeded by migration

`categories` (`workspace_id` nullable, `key`, `name`) holds 10 stable, global rows (`key`
`workspace_id is null`) for the MVP: `invoice`, `reminder`, `authority`, `tax`, `contract`,
`insurance`, `bank`, `personnel`, `advertising`, `other`. `workspace_id` is nullable, not a
separate "is global" boolean, so a future per-workspace custom category is the same table,
no migration needed - `workspace_id` doubles as the global/custom marker.

These are production reference data (every workspace needs them to exist, in every
environment, from day one), not seed data (`src/persistence/seed.sql` only ever runs against
local/test-stack hosts, `pnpm db:seed`'s allowlist) - they are inserted by a custom-SQL
migration (`src/persistence/sql/categories/categories.sql`, `on conflict (workspace_id, key)
do nothing`, `pnpm db:generate:custom categories`), which runs everywhere migrations run,
including production. The uniqueness constraint backing the taxonomy is `unique
(workspace_id, key) nulls not distinct` (`categories_workspace_key_key`): two global rows can
never share a key, exactly like two rows for the same workspace, which plain unique-index
NULLS DISTINCT semantics would not enforce on its own.

`name` holds the German display default; the UI's category badges and selects use it
directly rather than a `Categories.<key>` next-intl lookup, since the DB already holds
correct German text for the fixed taxonomy - `src/i18n/messages/de.json`'s `Categories`
namespace exists for documentation/consistency and any future code path that needs a label
from just a `key`, without a DB round trip.

### 2. `documents`: status machine, generated search, key layout

Status machine: `uploaded -> processing -> done | failed` (`error_code` set on `failed`),
enforced as a Postgres `CHECK` constraint, not only an application-level TypeScript union.
P2a only ever produces `uploaded` rows (nothing here transitions a document past that); P2b
owns every other transition.

`mime_type` is always `"application/pdf"`: the stored `original.pdf` object is always a PDF,
whether the upload was a single PDF (stored byte-for-byte) or 1..20 JPEG/PNG images (always
assembled into one PDF before storage, one page per image, page width fixed at A4
(`210mm`/`595.28pt`), height following each image's own aspect ratio). This column exists for
forward compatibility (a future upload path that is not always a PDF) rather than because
today's values vary.

`search_vector` is a Postgres `GENERATED ALWAYS AS (...) STORED` `tsvector` column (drizzle's
`customType` + `.generatedAlwaysAs(sql...)`; drizzle-kit emitted the correct `GENERATED
ALWAYS AS (...) STORED` DDL and a `USING gin` index on its own - no custom-SQL fallback was
needed here, unlike the categories seed data above), weighted `to_tsvector('german', ...)`
over `title` (A), `sender` (A), `original_file_name` (B), `ocr_text` (C). The inbox searches
it with `websearch_to_tsquery('german', q)`, ranked by `ts_rank` when `q` is present,
falling back to `created_at desc` otherwise. The generated expression references its sibling
columns by their literal (snake_case) database names in raw SQL, not through drizzle's
column-builder proxy: a generated column's expression is emitted verbatim into the migration,
and the table object referencing its own not-yet-finished column definitions during
construction is not a pattern drizzle supports cleanly.

Indexes: `(workspace_id, created_at desc)`, `(workspace_id, category_id)`, `(workspace_id,
assignee_user_id)`, `(workspace_id, status)`, plus the GIN index on `search_vector` - one per
filter/sort the inbox actually uses (architecture brief).

Object storage keys (decisions/0012-object-storage.md, unchanged by this decision):
`workspaces/<workspaceId>/documents/<documentId>/original.pdf` and `.../searchable.pdf`. The
document id is generated by the use case (`crypto.randomUUID()`), not the database's
`defaultRandom()`, specifically because the key must be known before the row exists (see
"Upload path" below) - `documents.create`'s contract (`CreateDocumentRow`) takes an explicit
`id`, the one deliberate deviation from every other owner area's "let the database generate
the id" convention in this repository.

### 3. Upload path: sniff, validate/assemble, quota pre-check, store, transact, compensate

`POST /api/documents` (`src/app/api/documents/route.ts`), the first route in this repository
built on `src/platform/api-pipeline`'s `access -> parse -> execute -> respond` step machine
(closing that owner's "adoption boundary" for the workspace-access step,
`src/platform/api-pipeline/README.md`):

1. **`access`**: `workspaceAccess(PERMISSIONS.documentsWrite)` - the caller's own workspace
   membership, never client input.
2. **`parse`**: a cheap `Content-Length` check first (413 before buffering, when the header is
   present - a chunked request has none, so the actual parsed byte size is re-checked
   afterward as the authoritative limit either way), then `request.formData()`, magic-byte
   sniffing (`src/modules/documents/core/magic-bytes.ts` - PDF/JPEG/PNG signatures, never the
   client's declared `Content-Type` or file extension), and either PDF validation
   (`pdf-lib`, rejects encrypted/unparseable PDFs and a page count over 20) or image assembly
   into one PDF (`src/modules/documents/core/pdf-assembly.ts`) - combined in
   `core/upload-processing.ts`'s `processUploadParts`, all pure/testable with small generated
   JPEG/PNG buffers, no I/O.
3. **`execute`**: `documents.createFromUpload` (below).
4. **`respond`**: `201 { documentId }`.

`createFromUpload` (`src/persistence/use-cases/documents-use-cases.ts`):

1. A **pre-check** (non-transactional): `evaluateQuota` (`src/modules/billing`) against the
   workspace's current stored-document count and this month's usage. Fails fast, before any
   storage write, for the common case of a workspace that is simply over its limit.
2. **`putObject`** of the final PDF to `original.pdf`, outside any transaction.
3. **One transaction**: `workspace.lockForUpdate` (`select ... for update`) serializes
   concurrent uploads for the same workspace, then the quota check re-runs authoritatively
   with the now-locked row and a fresh count/usage read, then the document row is inserted,
   then `billing.recordDocumentsCreated` runs (see "Cross-owner transaction sharing" below).
4. **Compensation**: if the transaction throws for *any* reason (the re-check fails, or an
   unrelated DB error), the already-stored object is deleted, so nothing is ever orphaned in
   storage with no matching row.

The pre-check is an optimization (skips a storage round trip in the expected case), not a
correctness mechanism; the transactional re-check with the row lock is what actually makes
"two concurrent uploads when exactly one slot remains" resolve to exactly one success -
proved by `src/persistence/tests/documents-use-cases-concurrency.db.test.ts` against real
Postgres.

### 4. Quota semantics (architecture brief's product decisions 1, 5, 6)

`src/modules/billing/core/plans.ts` is the single source for tier limits (`TIER_LIMITS`),
package definitions (`PACKAGES`), and the pure `evaluateQuota` function: the total limit is
checked first (gates regardless of tier), then the monthly limit if the tier has one (Free
has none). A package's `extraDocuments` raises the effective monthly limit but never past the
tier's total limit (`Math.min(monthlyLimit + extra, totalLimit)`). `workspaces.tier`'s
`WORKSPACE_TIERS` (`src/persistence/schema/workspaces.ts`) now re-exports
`src/modules/billing`'s `TIERS` rather than declaring its own copy - persistence importing
from a module's neutral entrypoint is allowed by the direction matrix
(`WEBAPP_TEMPLATE_SPEC.md` §4), and this keeps the tier list single-sourced in the module the
brief designates as its owner, per the brief's "single source" instruction.

`workspace_monthly_usage` (`workspace_id`, `period` = first UTC-month day, `documents_created`)
tracks creation counts per calendar month (product decision 1: a monthly limit counts
creation, deleting does not refund it); `quota_package_purchases` records one-off package
purchases scoped to the period they were bought in (product decision 5: capacity expires at
month end). P2a only reads `quota_package_purchases` (sums `extra_documents` for the current
period); P3 is its first writer.

### 5. Cross-owner transaction sharing: `billing.recordDocumentsCreated(repos, input)`

`src/persistence/use-cases/billing-use-cases.ts`'s `recordDocumentsCreated` is the one method
in this repository whose first parameter is an explicit `Repositories`, rather than reading
`deps.repos` like every other use-case method. `documents-use-cases.ts`'s `createFromUpload`
calls it from *inside* its own `uow.transaction(...)` callback, passing that callback's
transaction-bound `repos` - so the usage increment commits atomically with the document
insert, in one transaction, without `documents` ever writing `workspace_monthly_usage`
itself: the write still only ever happens inside `BillingRepository`'s own implementation
(`repositories/drizzle/billing-repository.ts`), `documents-use-cases.ts` only orchestrates
*when* it runs. `billing.getUsage` accepts the same optional `repos` parameter (defaulting to
`deps.repos`) so the authoritative in-transaction re-check reads usage through the same
transaction-bound connection the row lock is held on, not a separate, potentially
stale connection.

This is a deliberate, narrow deviation from "one use case owns one `uow.transaction` call"
(WEBAPP_TEMPLATE_SPEC.md §5.4's default shape): two owner areas' business rules (a document
must exist, and its workspace's usage must be incremented) need to commit as a single
database transaction, and neither owner's use case can be the other's dependency without
this explicit repos-passing seam. A future third owner area needing the same treatment
should follow the identical shape (accept `Repositories` explicitly on the specific method
that must share a transaction) rather than inventing a second pattern.

### 6. Read, search, filter, detail, recategorize, reassign, delete

`/dashboard` ("Posteingang"): list sorted by `created_at desc`, offset pagination (50/page,
`hasMore` computed by fetching one extra row rather than a separate `count(*)` query), search
(`websearch_to_tsquery`), category filter, status filter, "Meine Post" (`assignee =
<caller's own user id>`, resolved server-side, not client-suppliable). Filter/search/page
state lives entirely in the URL's search params; the filter bar is a plain `method="get"`
form, so filtering never needs client JavaScript (WEBAPP_TEMPLATE_SPEC.md §8: "Server
Components first").

`/dashboard/documents/[id]`: the PDF streamed from `GET /api/documents/[id]/file`
(workspace-scoped, 404 for another workspace's document id, `?download=1` for
`Content-Disposition: attachment` instead of `inline`), embedded same-origin via `<iframe>` -
`next.config.ts`'s `frame-ancestors` moved from `'none'` to `'self'` for exactly this (see
"Security headers" below). Recategorizing sets `category_source = "manual"`; reassigning
validates the target user is actually a member of the caller's own workspace
(`invalid_assignee` otherwise, checked via `workspaceMember.findByUserId`, a read - cross-owner
reads are fine, only writes are owner-exclusive); deleting removes the row and both possible
storage objects (any member may delete, product decision 9), tolerating (and logging) a
storage-delete failure rather than leaving the use case unable to complete a delete the user
asked for.

### 7. Removing a workspace member clears their document assignments

`src/persistence/use-cases/workspaces-use-cases.ts`'s `removeMember` now runs inside its own
`uow.transaction`, and after deleting the membership row, calls
`repos.document.clearAssigneeForUser(workspaceId, removedUserId)` - the documents owner's own
repository method, invoked from workspaces' use case only to share the transaction (the same
pattern as "Cross-owner transaction sharing" above, in the other direction: here `workspaces`
is the orchestrator and `documents` supplies the repository method actually doing the write).
Without this, a removed member could stay the invisible assignee of documents no one can
filter to under "Meine Post" again.

### 8. Security headers: `frame-ancestors 'self'`

`frame-ancestors` controls whether a *response* (this policy applies to every route,
including the file-streaming one, per `next.config.ts`'s blanket `headers()`) may be
embedded in a frame at all - not who a page itself may frame. `'none'` (the template's prior
default) would block the document detail page's own same-origin `<iframe>` from rendering
the PDF `GET /api/documents/[id]/file` returns. `'self'` is the strictest value that still
allows this: only a page on this exact origin may frame any response from it; no third party
ever can. `X-Frame-Options` remains unset (as before this decision): CSP `frame-ancestors` is
its modern replacement in every evergreen browser, and adding both would be redundant, not
stricter.

## Consequences

- Positive: the category taxonomy, quota model, and cross-owner transaction-sharing pattern
  are all designed to be extended, not replaced, by later phases:
  - **P2b (processing pipeline)** adds OCR/categorization: it transitions `status` through
    `processing -> done | failed`, fills `ocr_text`/`ocr_blocks`/`title`/`sender`/
    `document_date`/`summary`, sets `category_source = "auto"` when the LLM assigns a
    category (validated against `CATEGORY_KEYS`, falling back to `other`), and writes
    `searchable_pdf_key` once it builds the searchable PDF - none of this needs a schema
    change, only new use-case methods and a job queue calling them. It also owns
    notification e-mails and per-workspace routing rules (`category -> default assignee`),
    neither of which this phase implements.
  - **P2c (camera scanner)** is a client-only capture UI (`src/modules/scanner`) that calls
    the same `uploadDocument` helper (`src/modules/documents/client.ts`) the file-upload tab
    already uses - the "Kamera" tab in `src/app/(app)/dashboard/scan/page.tsx` is the
    explicit, marked slot it fills; no route or use-case change needed.
  - **P3 (billing)** adds the `/dashboard/billing` UI, the test-mode plan-change and package
    purchase actions (the first writer of `quota_package_purchases`), and the 80% warning
    e-mail job, which reads `QuotaEvaluation.totalRatio`/`monthlyRatio`
    (`src/modules/billing`'s `evaluateQuota`) - already returned today, just not consumed by
    anything yet. The `/dashboard/billing` link P2a's upload-error UI already shows on a
    quota error currently 404s until P3 adds that page.
- Positive: quota enforcement is correct under concurrency (proved against real Postgres, not
  only asserted), because the authoritative check runs inside the same transaction as the row
  lock, not as a separate step that a race could slip between.
- Negative: `createFromUpload`'s pre-check plus in-transaction re-check means a workspace at
  or near its limit does two `evaluateQuota` calls and two document counts per upload, not
  one - an accepted, small cost for avoiding an unnecessary storage write/delete round trip
  in the common (already-over-limit) rejection case.
- Negative: the `billing.recordDocumentsCreated(repos, input)` explicit-repos shape is an
  asymmetry against every other use-case method in this repository (which all close over
  `deps.repos`); it needs its own header-comment explanation (present in both
  `billing-use-cases.ts` and `documents-use-cases.ts`) so a future reader does not mistake it
  for an inconsistency to "fix" rather than a deliberate, narrow seam.
- Implementation status: **implemented** (P2a). Schema
  (`src/persistence/schema/documents.ts`, `src/persistence/schema/billing.ts`), the
  categories custom migration, repositories/use cases
  (`documents-use-cases.ts`, `billing-use-cases.ts`), the composition root, `src/modules/documents`
  and `src/modules/billing`, the upload/download routes, the `/dashboard`,
  `/dashboard/scan`, and `/dashboard/documents/[id]` pages, and unit/`.db.test.ts`/integration/e2e
  tests all land in this phase. OCR, categorization, the searchable PDF, the job queue,
  routing rules, notification e-mails (P2b), the camera scanner (P2c), and the billing UI/package
  purchase/warning e-mails (P3) are explicitly out of scope and not implemented.

## Supersedes / Superseded By
- None
