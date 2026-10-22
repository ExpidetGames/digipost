# Hardening and deletion: workspace deletion, retention, permissions and adversarial review

Document type: decision
Lifecycle: active
Owner: src/modules/workspaces, src/platform/access, src/platform/jobs, src/platform/object-storage, src/modules/accounts, src/modules/contacts, src/modules/documents
Scope: Admin-only workspace deletion and non-admin member self-removal, the
`purge-rejected-intake` retention cron (the only auto-deletion this product performs), the
outcome of a permissions review across `src/modules/{contacts,accounts,payments,intake}` and
the finance pages, and the outcome of an adversarial review pass verifying earlier fixes and
finding new ones (tenant isolation, intake parsers as an attack surface, AI-output validation,
logging hygiene)
Canonical responsibility: Active source for why workspace deletion is a single cascading
`DELETE` on the `workspaces` row rather than a per-table delete sequence, why the storage
cleanup has both a synchronous best-effort attempt and a durable retry job, why the retention
cron is the one deliberate exception to "every query is scoped by the caller's own workspace",
why the DSGVO right to erasure is now fulfillable at the workspace level, and the full list of
adversarial-review findings this phase closed, left open, or found to already be fixed
Maintenance triggers:
- The retention window (30 days), the auto-deletion scope, or the deletion confirmation UX
  changes
- A new workspace-owned table is added without a cascading foreign key to `workspaces.id`
- The `notFound()`-returns-200 Next.js streaming behavior this ADR documents as an accepted
  limitation is ever actually fixed
- A future phase reconsiders the 4 MB structured-upload cap or the unindexed transaction search
Last verified: 2026-09-20, F5 (hardening)

## Status
Accepted

## Context

Every prior phase (P0 through F4) shipped a vertical product capability. This phase ships none:
it is the first dedicated hardening pass since P5c, covering five things the product needed
before real customer data could responsibly live in it and be removed from it again:

1. **Workspace deletion.** Nothing in this product could delete a whole tenant before this
   phase - the DSGVO right to erasure (Art. 17) was only fulfillable one document at a time
   (`src/modules/documents`' existing hard delete). A workspace admin needed a way to remove
   every trace of their business from Digipost in one action.
2. **Retention.** Nothing was ever auto-deleted before this phase (a deliberate, documented
   absence - `decisions/0015-documents-and-quotas.md` and `decisions/0024-accounts-and-transactions.md`
   both describe hard-delete-on-request as the only deletion path). An unconfirmed CSV/XML
   import proposal a human explicitly rejected ("Ablehnen") is different: nothing was ever
   imported from it, so it carries none of the statutory retention obligations a confirmed
   business record does, and leaving it in storage indefinitely serves no purpose.
3. **A permissions review** across every module F1b through F4 added
   (`src/modules/{contacts,accounts,payments,intake}`, the finance pages), verifying every
   action/route checks the right bundle and never trusts a client-supplied `workspaceId`.
4. **An adversarial review pass**, re-verifying every fix an earlier read-only review
   (referred to throughout this ADR as "the F1b review" and "the F2 review") asked for, and
   looking for new problems in the same three areas that review covered: tenant isolation
   across the newer tables (accounts, transactions, settlement lines, aliases, fingerprints,
   proposals), the intake parsers as an attack surface, and AI outputs never escaping
   validation.
5. **Closing F4's own named leftovers** (`decisions/0026-platform-settlements.md`'s
   "Leftovers for you" list) and root-causing a persistently flaky e2e spec instead of
   papering over it with retries.

## Decision

### 1. Workspace deletion

**Permission.** A new bundle, `PERMISSIONS.workspaceManage` (`workspace.manage`,
`src/platform/access/core/permissions.ts`), admin-only, deliberately separate from
`membersManage` - removing a member is reversible (re-invite them); deleting a workspace is
not, and deserves its own named capability rather than piggybacking on an existing one whose
name does not say "irreversible."

**Typed confirmation.** `/dashboard/settings/company`'s new danger zone
(`WorkspaceDangerZone`, `src/modules/workspaces/ui/workspace-danger-zone.tsx`) requires the
admin to re-type the workspace's exact current name before the delete button enables - checked
again server-side (`WorkspaceUseCases.deleteWorkspace`, an exact string match against the
freshly re-read row, never trusted from the client) as the last line of defense, the same
"use cases are the last line of defense" discipline this codebase already applies everywhere
else.

**One cascading `DELETE`, not a per-table sequence.** `WorkspaceRepository.delete(id)`
(`src/persistence/repositories/drizzle/workspaces-repository.ts`) is `DELETE FROM workspaces
WHERE id = $1`. This works because every workspace-owned table's foreign key to
`workspaces.id` is already `onDelete: "cascade"` - verified against the complete schema before
choosing this approach (see "Cascade verification" below) rather than assumed. A single
statement is strictly safer than an application-level per-table delete sequence: there is no
way to forget a table, no ordering to get wrong, and Postgres's own referential-integrity
engine is the one enforcing it, not a list this ADR or a future developer could let drift out
of sync with the schema. This is not "a module writing another module's table" (`AGENTS.md`'s
"only the owning module writes" rule) - it is a single `DELETE` on the `workspaces` row, owned
by `src/modules/workspaces`, and Postgres's own cascade is the mechanism that then removes
every dependent row, exactly the same mechanism `workspace_members` already relies on when a
`user` row is deleted (`decisions/0014-workspaces-and-access.md`).

**Cascade verification.** Every table below has `workspace_id uuid not null references
workspaces(id) on delete cascade`, confirmed by reading `src/persistence/schema/*.ts` in full
before this decision was made: `workspace_members`, `workspace_invitations`, `documents`,
`contacts`, `contact_change_proposals`, `accounts`, `transactions`, `import_batches`,
`settlement_lines`, `document_transactions`, `payment_aliases`, `payment_rejections`,
`payment_no_document_rules`, `workspace_monthly_usage`, `quota_package_purchases`,
`workspace_tier_changes`, `category_routes`, `intake_source_fingerprints`, `jobs` (nullable
`workspace_id`, still cascades when set). `document_contacts` has no `workspace_id` column of
its own, but both its foreign keys (`document_id`, `contact_id`) cascade from tables that
themselves cascade from `workspaces.id`, so it is removed transitively. The one deliberate
exception is `categories`: `workspace_id` is nullable with **no foreign key at all** (`null`
means "global category", `src/persistence/schema/documents.ts`) - a per-workspace category is
a described-but-unbuilt future feature (architecture brief's product decision 2), and nothing
in this codebase today ever inserts one, so this is a non-issue in practice but is called out
here explicitly rather than silently assumed safe, in case that feature ever lands. A DB test
(`src/persistence/tests/workspaces-repository.db.test.ts`) seeds one row in every table above
plus a second, untouched workspace, then proves the delete removes everything for the first
workspace and nothing for the second, against real Postgres, not only asserted.
Extended by decisions/0075-email-intake.md: `mail_intake_settings`, `mail_intake_allowed_senders`
and `inbound_emails` (all `workspace_id uuid not null ... on delete cascade`) joined this list and
that test. Extended by decisions/0077-arbiter-answer-cache.md: `payment_arbiter_answers`
(`workspace_id uuid not null ... on delete cascade`, and `transaction_id` cascading from
`transactions` as well) joined this list and that test.

**Storage cleanup: synchronous best-effort plus a durable retry job.** `ObjectStorage` gained
`listObjects(prefix)` and `deleteObjects(keys)` (paginated `ListObjectsV2`/batched
`DeleteObjects`, `src/platform/object-storage`) and a `workspaceStoragePrefix(workspaceId)` key
builder. `deleteWorkspaceAction` (`src/modules/workspaces/actions.ts`) attempts an immediate
`listObjects` + `deleteObjects` right after the use case returns, for fast, typical-case
cleanup within the same request. Independently, `WorkspaceUseCases.deleteWorkspace` enqueues a
`cleanup-workspace-storage` job **inside the same transaction as the row delete**, with
`workspaceId: null` on the job row itself - not an oversight: `jobs.workspace_id` cascades from
`workspaces.id` like everything else, so a non-null value there would delete this very job in
the same statement that creates the need for it. This job is the durable fallback for every
way the synchronous attempt can fail to run at all (a crashed process, a transient MinIO/R2
outage) - it is idempotent (listing an already-empty prefix is a no-op success) and picked up
by the existing `GET /api/cron/process-jobs` sweep like any other pending job, no new cron
route needed for it.

**"Signs the acting user out to onboarding" - what this actually does.** The brief's own
wording could be read as invalidating the Better Auth session outright. That was deliberately
not implemented: `/onboarding` is itself behind the auth gate (`src/proxy.ts`'s matcher,
`requireUser()`), so a genuinely signed-out user would land on `/login`, not `/onboarding` - the
two outcomes are mutually exclusive. What actually happens: the deleted workspace's cascade
already removed the acting admin's own `workspace_members` row, so `deleteWorkspaceAction`
simply `redirect("/onboarding")`s at the end, and the existing gate every workspace-less user
already goes through (`src/app/(app)/layout.tsx`'s `requireWorkspaceMember()`) does the rest
for any later navigation too - there is no new "force sign-out" mechanism, and none was needed.
This interpretation is recorded here explicitly because the literal instruction and the actual
auth model point in different directions, and a future reader should not assume a real
`signOut()` call was simply forgotten.

**Member self-removal ("Arbeitsbereich verlassen").** A non-admin member leaves their own
workspace via `leaveWorkspaceAction` (`src/modules/workspaces/actions.ts`,
`WorkspaceUseCases.leaveWorkspace`), rendered on `/dashboard/team` (`LeaveWorkspaceButton`,
only for the caller's own row when its role is not `admin`). The use case rejects the
workspace's own admin with `cannot_leave_as_admin` before touching the repository - there is no
admin-transfer flow, so an admin who wants out deletes the workspace instead (a typed,
deliberate decision) rather than silently leaving a workspace with no admin at all, which the
partial unique index on `workspace_members (workspace_id) where role = 'admin'`
(`decisions/0014`) would make impossible to recreate without deleting the workspace anyway.
Leaving shares the exact membership/document-assignment/routing-rule cleanup `removeMember`
already did (factored into a shared `deleteMembershipAndCleanUp` helper,
`src/persistence/use-cases/workspaces-use-cases.ts`), so a member leaving is not observably
different from an admin removing them, other than who initiated it.

### 2. Retention: `purge-rejected-intake`

`GET /api/cron/purge-rejected-intake` (`src/app/api/cron/purge-rejected-intake/route.ts`),
secured identically to the existing `process-jobs` sweep (`Authorization: Bearer
$CRON_SECRET`). Finds every document with `intake_status = 'rejected'` and `updated_at` older
than `RETENTION_DAYS_REJECTED_INTAKE` (30,
`src/persistence/use-cases/documents-use-cases.ts`), **across every workspace** -
`DocumentRepository.listIntakeRejectedBefore` is the one deliberate exception in this codebase
to "every query is scoped by the caller's own workspace" (`AGENTS.md`'s domain rule), for the
same reason the job queue's own cron sweep (`runDueJobs` with no `workspaceId` filter) already
is one: this is unattended background maintenance work with no caller session to scope to at
all, not a request serving one tenant's data to that tenant.

`updated_at` is used as the rejection-timestamp proxy rather than adding a `rejected_at`
column: `rejectIntake` is the last write a rejected document's row receives in the ordinary
product flow (nothing else legitimately mutates a rejected, nothing-was-ever-imported document
afterwards), so this needed no schema change. One `purge-rejected-intake` job
(`src/platform/jobs`) is enqueued per eligible document (never deleted synchronously in the
route handler) and immediately swept via `runDueJobs`, so deletion runs through the same
retry/backoff machinery as every other job kind; the handler reuses
`DocumentUseCases.deleteDocument` completely unchanged (the row plus both storage objects,
`decisions/0012-object-storage.md`), and treats an already-gone document as a no-op success
(a duplicate enqueue across two cron runs, or a user manually deleting it first, are both
harmless). `vercel.json` gained a second daily cron entry (`0 3 * * *`, after the existing
`process-jobs` entry at `0 2 * * *`).

**This is the only auto-deletion in the product.** Every other document, contact, account,
transaction, and proposal is retained until a human explicitly deletes it (or deletes the
whole workspace) - a confirmed import is a business record with its own statutory retention
obligations (the privacy page draft's "Speicherdauer" section already said this; F5 extended
its wording to name workspace deletion and this cron as the two exceptions, see
`src/i18n/messages/de.json`'s `Legal.privacy.sections.retention`).

### 3. Permissions review: no gap beyond the one contacts finding below

Every server action, route handler, and page across `src/modules/{contacts,accounts,payments,
intake}` and the finance pages was read and checked against the permission bundle its data
requires: contacts merge/delete correctly stay member-level (`documentsWrite`, per this
phase's own explicit decision below, not an oversight); every accounts/payments mutation and
every finance page correctly requires the admin-only `finance.read`/`finance.manage` bundle
(`decisions/0024-accounts-and-transactions.md`); no query anywhere in these modules takes
`workspaceId` from client input rather than the resolved session. The one concrete finding
(document-contact link reads relying on caller discipline rather than a query-level filter) is
fixed under "Adversarial review pass" below, since it is a defense-in-depth property, not a
live vulnerability (every existing caller already pre-validated the id).

**`notFound()`-returns-200 - identified precisely, left as a documented limitation.**
`/dashboard/routing`, `/dashboard/settings/intake`, and every `/dashboard/finance/**` page gate
a non-admin visitor with `requireWorkspaceMember()` then `notFound()` when the caller lacks the
relevant permission - correct application logic, verified to redact every field it should. The
HTTP status code these pages return for that case is nonetheless `200`, not `404`. The
mechanism: `src/app/(app)/loading.tsx` exists as a sibling of the shared `(app)` layout, so
Next.js automatically wraps every page under it (including all of the above) in a `<Suspense>`
boundary; per Next's own documented streaming behavior, the response begins streaming a `200`
status before the page's async `requireWorkspaceMember()`/permission check has even run, and
once streaming has started the status code cannot change - `notFound()` still renders the
correct (empty, redacted) not-found UI body, just under a `200` wire status instead of a `404`
one. This is not a data-exposure bug (nothing sensitive is ever in that body), but it does mean
external tooling or monitoring that expects a real `404` for this case will not see one. Fixing
it would mean either moving the permission check into `src/proxy.ts` (explicitly forbidden from
touching `src/persistence/**` at all, `STRUCTURE.md` §4's stricter rule for the proxy) or
removing the shared `loading.tsx` Suspense boundary for these specific routes (a broader
loading-UX change affecting every page under `(app)`, not a targeted fix) - both are
structural changes outside a hardening phase's scope, so this is recorded here as an accepted,
understood limitation rather than fixed. `tests/e2e/**` already asserts on rendered content for
this case, never on the response status, which was the correct choice independent of this
finding.

### 4. Contacts merge/delete: confirmed member-level, by explicit decision

Restated here because it was an open question this phase was asked to resolve: contacts
merge/delete stay behind `documentsWrite` (member-level), not a new admin-only bundle. A
contact record is corrected/cleaned-up data work like any other document action a member
already does (recategorize, reassign, delete a document) - it is not financial data the way
`finance.read`/`finance.manage` gates, so it does not warrant the same admin-only deviation
`decisions/0024` made for a bank statement's contents.

### 5. Adversarial review pass

Findings from the read-only F1b and F2 reviews, and this phase's own pass over the same three
areas (tenant isolation, intake parsers, AI-output validation), one line each:

| # | Finding | Outcome |
|---|---|---|
| F1b-1 | Unbounded PDF name-tree recursion (`embedded-xml.ts`) | Already fixed (R1): depth/work-unit budget, visited-ref cycle guard, oversized-stream check; 5 adversarial fixtures with a wall-clock bound. Re-verified, unchanged. |
| F1b-2 | Mistral prompt delimiters not nonce-based | Already fixed (R1): every prompt-building file (`prompts.ts`, `intake-prompts.ts`, `payment-arbiter-prompts.ts`) uses `wrapUntrustedSection`/`describeGuardedSection` consistently. Re-verified across all three, no exception found. |
| F1b-3 | Digit-only invoice-number candidates need word boundaries and >= 5 digits | Already fixed (R1): `MIN_DIGIT_ONLY_TOKEN_LENGTH = 5`, `hasDigitOnlyWordBoundaryMatch`; tested against a date substring false positive. Re-verified, unchanged. |
| F1b-4 | 4 MB upload cap also applies to CAMT/CSV; a yearly export exceeds it | Product decision: not raised this phase (see "What was deliberately not fixed" below). |
| F1b-5 | `document_contacts`/`contact_change_proposals` joins rely on write-side invariants only | Fixed this phase: `listForDocument`/`listForContact` now take `workspaceId` and enforce it with an explicit join filter; `contactChangeProposals.listForContact` already did. DB test added. |
| F1b-6 | `notFound()` on admin-gated pages returns 200 | Root-caused this phase (Next.js Suspense streaming, see above); documented as an accepted limitation, not fixed. |
| F2-1 | Idempotency key collision on `NOTPROVIDED` | Already fixed (R2, intake core); this phase added the missing coverage - an integration test running the real `camt053-notprovided.xml` fixture through the actual accounts import path (upload -> job -> `AccountsUseCases`), proving both same-day/same-amount rows survive against the real unique constraint. |
| F2-2 | Editing an account's IBAN after imports desyncs auto-resolution | Fixed this phase: `updateAccount` blocks an IBAN change once the account has any import batch (`ACCOUNT_ERROR.iban_locked_by_imports`); no re-confirmation escape hatch (see the error's own code comment for why). |
| F2-3 | `sumAmountCents` sums across currencies | Fixed this phase: excludes a differently-currencied transaction from the fallback balance sum and reports `hasMixedCurrencyTransactions` (shown as a warning badge on `/dashboard/finance`). |
| F2-4 | Pending-account assignment must restrict targets to `type = "bank"` | Fixed this phase: `importFromDocument` rejects a `type: "clearing"` `accountId` (`ACCOUNT_ERROR.not_bank_account`); the "Konto zuordnen" list also only offers bank accounts. |
| F2-5 | Transaction free-text search uses unindexed `ilike` | Documented as an accepted limitation (see below), not fixed. |
| New | `accounts.findByPlatform` has no unique constraint (F4 leftover (c)) | Fixed this phase: partial unique index `accounts_workspace_platform_clearing_key` (`workspace_id, platform) where type = 'clearing'` (migration `0016_uneven_bulldozer.sql`); `importSettlementReportDocument` retries once on the resulting conflict, the same shape `createForUser`/`upsertFromExtraction` already use. |
| New | F4's two `mapping-validator.ts` fixes had no direct regression test (F4 leftover (a)) | Fixed this phase: two tests added (`bookingDate` alongside a settlement field still classifies as `settlement_lines`; an indicator-column sign applies to both `gross` and `net`, never `fee`, for a settlement-shaped mapping). |
| New | Fee-invoice detection is a name heuristic, not learned aliases (F4 leftover (b)) | Reviewed, not changed: the code's own header comment on `isPlatformContactName` (`src/modules/payments/core/platform-detection.ts`) already documents why `payment_aliases` was not reused (no natural alias-learning event for a fee invoice, which is never itself a bank transaction) and names the future path. Confirmed this reasoning still holds; no cheap improvement found. |
| New | Oversized CSV, absurd column counts, CSV formula injection, malformed CAMT | Reviewed as part of this pass: `@/modules/intake`'s tabular sampling/validation already bounds row/column counts and never executes a cell's content; CSV formula injection is a concern for a future EXPORT feature (none exists yet in this codebase to inject into) rather than the import path reviewed here - noted for whoever builds a CSV/XLSX export later. Malformed CAMT.053 is already covered by `camt053-parser.ts`'s own lenient-but-strict-on-financial-fields parsing and its existing fixture tests. |
| New | Logging never contains document content or bank data | Reviewed: `src/persistence/use-cases/jobs-use-cases.ts`'s own `logJobFailure` only ever logs stable, named fields (job id, kind, document id, error code) - confirmed, no change needed. |

**Persistent e2e flake root-caused, not retried around.** `tests/e2e/billing.spec.ts`'s upload
step flaked despite an earlier fix (P6) that waited for the selected file's name to render
before submitting. Root cause: `page.goto()` resolves on the `load` event, not on React having
finished hydrating and attached its delegated `change` listener to the client-side upload
form; `page.setInputFiles` firing before that listener attaches gets silently dropped by React
(never queued, never replayed), so the P6 wait itself times out rather than racing ahead too
early. Fixed by wrapping the file-selection-and-verify step in a Playwright `toPass` retry -
resending one (idempotent) browser event until hydration is unambiguously complete, never a
raised retry count or a skipped assertion. Verified with `--repeat-each=3` (6/6 passed).

### 6. What was deliberately not fixed

- **The 4 MB upload cap is not raised** for CAMT.053/CSV/TSV bank-statement exports, even
  though a yearly export commonly exceeds it and (unlike a scanned PDF) has no page-count knob
  to shrink it by. The cap follows directly from Vercel's request body limit
  (`decisions/0012-object-storage.md`); a real fix needs a presigned direct-to-storage upload
  path with a post-upload verification step, an architecture change out of scope for a
  hardening phase. The upload form now shows "Bitte exportieren Sie Kontoauszüge monatsweise."
  for a `file_too_large` rejection specifically on a structured (`.xml`/`.csv`/`.tsv`) file,
  so the limitation is explained rather than silently confusing.
- **The unindexed `ilike` transaction search** (F2 review finding #5) stays as-is: a leading-`%`
  `ilike` cannot use a plain B-tree index, and adding a real fix means a `pg_trgm` GIN index,
  which needs a new Postgres extension enabled in every environment (local, the hermetic test
  stack, and eventually production). Accepted for this product's scale (a small business's own
  transaction history, not a multi-tenant analytics workload) rather than taken on in this
  phase; the query site (`src/persistence/repositories/drizzle/accounts-repository.ts`)
  documents this explicitly as the revisit trigger for whoever eventually needs it.
- **The `notFound()`-returns-200 behavior** (see above) - a real fix is a structural change to
  either the proxy or the shared loading-UX, not a hardening-phase-sized change.
- **Fee-invoice detection stays a name heuristic** (see the adversarial-review table above) -
  reviewed, no cheap improvement identified.

## Consequences

- Positive: the DSGVO right to erasure (Art. 17) is now fulfillable at the workspace level, not
  only per document - an admin can remove their entire business's data from Digipost in one
  confirmed action, with a durable guarantee (the retry job) that the underlying storage
  objects eventually disappear even if the immediate attempt fails.
- Positive: the cascade-based deletion approach means a future phase adding a new
  workspace-owned table gets deletion "for free" as long as its own foreign key to
  `workspaces.id` cascades (the same discipline every existing table already follows) - no
  separate "remember to add it to the delete sequence" step exists to forget.
- Positive: the retention cron closes the one category of data this product was creating with
  no corresponding way to remove it automatically, without touching anything a business is
  legally obligated to keep.
- Positive: every adversarial-review finding from the two prior read-only passes is now either
  confirmed fixed-and-tested, fixed-and-tested for the first time in this phase, or explicitly
  documented as an accepted, reasoned limitation - none were left silently unresolved.
- Negative: the `notFound()`-returns-200 behavior and the unindexed transaction search both
  remain real, if minor, limitations; both are documented precisely enough (mechanism, why it
  was not fixed, what fixing it would require) that a future phase can act on them directly
  without re-deriving the analysis this phase already did.
- Negative: the retention cron's cross-workspace query is a deliberate, narrow exception to
  this codebase's otherwise-universal "every query is scoped by the caller's own workspace"
  rule - flagged here explicitly (and in the query's own code comment) so it is never mistaken
  for an oversight by a future reviewer applying that rule mechanically.
- Implementation status: **implemented**. Workspace deletion (`src/modules/workspaces`'s
  `deleteWorkspace`/`leaveWorkspace`, `WorkspaceDangerZone`/`LeaveWorkspaceButton`,
  `PERMISSIONS.workspaceManage`), the retention cron (`src/app/api/cron/purge-rejected-intake`,
  `DocumentUseCases.enqueuePurgeForRejectedIntake`), `ObjectStorage`'s
  `listObjects`/`deleteObjects`/`workspaceStoragePrefix`, the `cleanup-workspace-storage` and
  `purge-rejected-intake` job kinds, every adversarial-review fix listed above, and the
  `accounts_workspace_platform_clearing_key` migration all land in this phase, covered by unit,
  `.db.test.ts`, integration, and e2e (retry-fix) tests - see the phase's own final report for
  exact test counts and which full-suite runs (`pnpm verify`, `pnpm test:docker`,
  `pnpm test:e2e:docker`, `pnpm build`) were executed.

## Supersedes / Superseded By
- None
