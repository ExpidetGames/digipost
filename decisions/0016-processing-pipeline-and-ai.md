# Processing pipeline and AI: jobs, Mistral OCR/analysis, searchable PDF, routing, notifications

Document type: decision
Lifecycle: active
Owner: src/platform/jobs, src/platform/mistral, src/modules/documents, src/modules/workspaces
Scope: The asynchronous processing pipeline that turns an uploaded document into a
categorized, searchable one (`uploaded -> processing -> done | failed`): the job queue
recipe, its triggers, the Mistral OCR/chat adapters and their deterministic fakes, the
searchable-PDF construction, per-category routing rules, and the assignment notification
e-mail
Canonical responsibility: Active source for why the job queue is a generic, domain-free
dispatcher with handlers wired by the composition root, how a `MistralRequestError` becomes
a job-queue retry decision, why the searchable PDF's text layer is best-effort rather than
pixel-perfect, and the Vercel Hobby cron limitation this phase accepts
Maintenance triggers:
- The job queue's schema, claim query, or backoff formula changes
- A new job kind is added, or an existing one's payload shape changes
- Mistral's OCR/chat API contracts change, or a new AI provider is added
- The routing/notification model changes (e.g. more than one rule per category)
- Vercel's Hobby-plan cron limitation changes, or an external scheduler replaces it
Last verified: 2026-09-19, P2b (processing pipeline)

## Status
Accepted

## Context

decisions/0015-documents-and-quotas.md's "Consequences" named exactly what this phase adds:
OCR/LLM categorization, the searchable PDF, the job queue, routing rules, and notification
e-mails - none of which P2a implemented, but all of which P2a's schema already anticipated
(`documents.ocr_text`/`ocr_blocks`/`title`/`sender`/`document_date`/`summary`/
`searchable_pdf_key`/`category_source`/`assignee_user_id` all existed, unused, before this
phase). This phase fills every one of those fields in, without a schema change to any
P2a-owned column.

The architecture brief specifies the job queue recipe (WEBAPP_TEMPLATE_SPEC.md §14), names
Mistral OCR/chat as the categorization engine, and states product decision 7 (routing rules,
one per category, notify the assignee) and decision 8 (the LLM also extracts
title/sender/date/summary, all untrusted, validated with Zod).

## Decision

### 1. The job queue: generic dispatcher, domain-free

`src/persistence/schema/jobs.ts` (owner `src/platform/jobs`): `jobs(id, kind, payload jsonb,
workspace_id, status, run_at, attempts, max_attempts, locked_until, last_error_code,
created_at, updated_at, completed_at)`. `status` only ever tracks the *terminal* outcome
(`pending | done | failed`) - an in-flight claim is represented by `locked_until` being in
the future, not a fourth "processing" status value, which keeps the claim predicate a single
comparison (`status = 'pending' and run_at <= now() and (locked_until is null or
locked_until < now())`) rather than two overlapping state machines. `workspace_id` is
nullable (a future job kind might not be workspace-scoped) but present and indexed so the
UI's own workspace-scoped "kick" (below) never needs a jsonb payload scan.

`repositories/contracts/jobs-repository.ts` / `repositories/drizzle/jobs-repository.ts`:
`enqueue`, `claimDue` (`select ... for update skip locked`, Drizzle's `.for("update",
{ skipLocked: true })` exactly as WEBAPP_TEMPLATE_SPEC.md §14 specifies - two concurrent
claimers never receive the same row, proved against real Postgres in
`src/persistence/tests/jobs-repository.db.test.ts`), `markSucceeded`, `markFailed`,
`reschedule`, `findById`. `Repositories.jobs` joins the bundle like every other owner's
repository.

`src/persistence/use-cases/jobs-use-cases.ts` (owner `src/platform/jobs`) is the actual
runner, and is deliberately **domain-free**: it claims due jobs (inside its own short
transaction - the `for update` lock is only held for the claim itself, never across a
handler's execution, since a handler may call Mistral over HTTP and must never hold a
database lock open for that long), looks up a handler by `kind` in a `handlers` map, runs
it *outside* any transaction, and records the outcome. It has no idea what
`"process-document"` means. A handler throws `src/platform/jobs`'s `TransientJobError` or
`PermanentJobError`; any other thrown error is treated as transient (a genuine bug is
retried and eventually surfaces via `max_attempts` exhaustion, never silently recorded as
permanent on its first occurrence). Backoff is `src/platform/jobs/core/backoff.ts`'s pure
`computeBackoffMs(attempt)`: exponential (`base * 2^(attempt-1)`, capped at 5 minutes),
scaled by a "half jitter" factor in `[0.5, 1)` so many jobs failing at once do not all retry
at exactly the same instant.

**Handlers registered where they belong.** `src/persistence/composition/job-handlers.ts`
(rank `composition`, so - unlike a use case - it may import a module's own privileged
`server.ts`) builds the `kind -> handler` map from `create-request-services.ts`'s own
already-built use cases: `process-document` calls `documents.processDocument` (a method on
`DocumentUseCases`, decision 2 below); `send-assignment-email` reads the document back via
`documents.getById`, renders `@/modules/documents/server`'s `renderAssignmentEmail`, and
sends it via the injected `Mailer`. This is why `documents-use-cases.ts` itself never
imports `@/modules/documents/server` (the "Neutral-Entrypoint-Regel",
WEBAPP_TEMPLATE_SPEC.md §5.4: a use case may only reach a module's *neutral* entrypoint,
never its `server.ts`/`client.ts`) - `src/modules/documents/index.ts` (new in this phase) is
that neutral entrypoint, re-exporting the processing pipeline's ports, pure helpers
(`buildSearchablePdf`, `joinOcrText`, `sanitizeWinAnsi`, `validateAnalysisResult`), and both
deterministic fakes, so both `documents-use-cases.ts` (a use case) and `src/platform/mistral`
(a platform owner implementing this module's ports) can reach them without crossing the
module's boundary anywhere but this one file.

**Triggers**, three of them, all calling `src/platform/jobs/server`'s one public function
`runDueJobs({ limit, workspaceId? })`:

1. **`after()`**: `POST /api/documents`'s route handler (`src/persistence/use-cases/documents-use-cases.ts`'s
   `createFromUpload` enqueues `process-document` inside the SAME transaction as the document
   insert) and `retryProcessingAction` both call `after(() => runDueJobs({ workspaceId, limit: 5 }))`
   right after their own work, so processing starts immediately after the 201/success response
   without blocking it (`next/server`'s `after`, stable since Next 15.1, works in Route
   Handlers and Server Functions alike).
2. **Cron sweeper**: `GET /api/cron/process-jobs` (`src/app/api/cron/process-jobs/route.ts`),
   secured by the existing `Authorization: Bearer $CRON_SECRET` access step
   (`src/platform/api-pipeline/server/cron-auth.ts`'s first real adopter), `maxDuration = 60`,
   claims across every workspace (no `workspaceId` filter) with `limit = 20`. `vercel.json`
   points a cron entry at it (`schedule: "0 2 * * *"`).
3. **Workspace-scoped "kick"**: `kickProcessingAction` (`src/modules/documents/actions.ts`) -
   while the Posteingang or a document's detail page shows any document in
   `uploaded`/`processing`, a client-side poller (`src/modules/documents/ui/processing-poller.tsx`)
   calls this Server Action once on mount and then calls `router.refresh()` every ~3 seconds
   until the server-rendered state says nothing is left to wait for. This is what makes local
   development without a cron scheduler self-heal after a dev-server restart, and gives
   production a second, low-latency trigger alongside `after()` and the cron sweep.

**Vercel Hobby only allows a daily cron schedule.** `vercel.json`'s `"0 2 * * *"` is the most
frequent schedule Hobby permits; the `after()` trigger and the UI "kick" are what actually
keep processing latency low on Hobby (typically seconds, not up to 24 hours) - the cron
sweep exists purely as a safety net for a job that both other triggers somehow missed (a
crashed request, a user who never revisits the page). **Production on Vercel Pro** (or an
external scheduler hitting the same URL, e.g. every 1-5 minutes) removes this ceiling
entirely; this is a known, accepted limitation of the MVP's hosting tier, not a defect.

### 2. `DocumentUseCases.processDocument`: OCR -> categorize -> searchable PDF -> route -> notify

One method, `src/persistence/use-cases/documents-use-cases.ts`'s `processDocument({ workspaceId,
documentId })`, is the `process-document` job's entire body:

1. Load the document; a missing row (deleted while the job was pending) is a silent no-op
   success, not a failure - there is nothing left to process.
2. `document.markProcessing` (status -> `processing`, clears `error_code` - the start of any
   attempt, first or retried).
3. `objectStorage.getObject(storageKey)` for the original PDF bytes.
4. `ocrEngine.recognize({ pdfBytes, fileName })` (the `OcrEngine` port,
   `src/modules/documents/core/ports.ts`).
5. `joinOcrText` (markdown joined across pages, image/table placeholders stripped) for
   `ocr_text`; `truncateForAnalysis` (6000 chars) before it reaches the analyzer prompt.
6. `analyzer.analyze({ text, fileName })` (the `DocumentAnalyzer` port) -> `{ category, title,
   sender, documentDate, summary }`, already validated (see decision 4).
7. `buildSearchablePdf(pdfBytes, ocrPages)` (pure, `pdf-lib`) -> stored at
   `documentSearchableKey(...)`.
8. One transaction: `document.markDone` (every field above, `category_source = "auto"` when
   a category resolved), then **auto-routing**: if the document has no assignee yet and a
   rule exists for the resolved category (`categoryRoute.findAssignee`), `document.updateAssignee`
   plus `jobs.enqueue("send-assignment-email")`, in the same transaction as the assignment
   write.
9. On any failure: `document.markFailed(errorCode)` with the *specific* code
   (`classifyProcessingError` narrows a `MistralRequestError` into the code it already
   carries, or `"processing_failed"` for anything else), then rethrows the classified
   `TransientJobError`/`PermanentJobError` so the job queue's own retry/backoff still
   applies. A transient failure that later retries successfully naturally overwrites the
   stale `failed` status the next time `markProcessing` runs - the document may briefly show
   `failed` for an attempt that is actually about to retry; this is accepted as a simpler
   model than tracking "failed-but-retry-pending" as a distinct state.

**Manual reassignment also notifies.** `reassign` (existing since P2a) gained an
`actingUserId` parameter and now runs inside its own transaction: if the new assignee
differs from the previous one, is non-null, and is not the person who performed the
reassignment, it enqueues `send-assignment-email` the same way auto-routing does -
architecture brief's requirement 8 ("manual reassignment to someone other than the acting
user" also notifies).

**"Erneut verarbeiten" (retry).** `retryProcessing` rejects with `retry_not_allowed` unless
the document is currently `failed`; otherwise it resets it to `processing` and re-enqueues
`process-document` in one transaction, then the calling Server Action kicks the runner.

### 3. `src/platform/mistral`: plain fetch, lenient parsing, error classification

Only holder of `MISTRAL_API_KEY` (`STRUCTURE.md`'s `env-access` rule). No SDK - a plain
`fetch` with an injectable implementation (tests never touch the network) and
`AbortSignal.timeout`. Error classification, never guessed from a message string: 401/403 ->
permanent `ai_auth_failed`; 429 -> transient `ai_rate_limited`; 5xx -> transient
`ai_unavailable`; a timeout/network failure -> transient `ai_timeout`/`ai_unavailable`; a
response that fails even the lenient Zod schema -> permanent `ai_invalid_response`. Never
logs the request or response body, or the API key - only HTTP status codes ever appear in an
error message.

- **OCR**: `POST /v1/ocr`, `model: MISTRAL_OCR_MODEL ?? "mistral-ocr-latest"`, the original
  PDF as a base64 `data:application/pdf` URL (R2/MinIO objects are private, so Mistral is
  never handed a URL it could fetch itself), `include_blocks: true`. The response is parsed
  with `core/schemas.ts`'s lenient Zod schema: `blocks`/`dimensions` may be `null` or
  missing entirely (both cases produce `null` on the mapped `OcrPage`, exercised by
  `src/platform/mistral/tests/mistral-ocr-engine.test.ts`'s fixtures for "present" / "null"
  / "missing").
- **Chat/analysis**: `POST /v1/chat/completions`, `model: MISTRAL_CHAT_MODEL ??
  "mistral-small-latest"`, `temperature: 0`, `response_format: { type: "json_object" }`. The
  German system prompt (`server/prompts.ts`) instructs the model that the document text
  between `<<<DOCUMENT_TEXT_START>>>`/`<<<DOCUMENT_TEXT_END>>>` is untrusted data to analyze,
  never an instruction to follow - a prompt-injection mitigation, not a guarantee (an LLM can
  still be manipulated by adversarial input; what IS guaranteed, and tested, is that the
  *output* always conforms to the expected shape regardless: see decision 4).
- **Env selection** (`server/get-ai-adapters.ts`, called by the composition root exactly
  like `getObjectStorage()`): `AI_PROVIDER=mistral` explicit with no key, or unset with no
  key in production, binds a "not configured" adapter that throws permanent
  `ai_not_configured` on first actual use (not at binding time - consistent with
  `serverEnv()`'s own lazy-validation style); `AI_PROVIDER=fake` explicit, or unset with no
  key outside production, binds the deterministic fakes; otherwise the real Mistral adapters.
  `isFakeAiProviderActive()` backs the UI's "Testmodus: KI-Simulation aktiv" hint.
  `docker/compose.test.yml` sets `AI_PROVIDER: fake` explicitly so no test environment's
  behavior depends on this fallback logic at all.

**Data protection note.** Mistral (mistral.ai) is an EU-based provider; sending a
customer's scanned mail's full text and content to it is a real data transfer to a
sub-processor and must be reflected in the product's data-processing documentation
(Auftragsverarbeitungsvertrag / DPA) before real customer data flows through this pipeline
in production - this ADR records the technical decision, not the legal one, which is
explicitly out of scope for this phase and flagged here as a follow-up.

### 4. Ports, fakes, and shared validation (`src/modules/documents/core/`)

`OcrEngine`/`DocumentAnalyzer` (`core/ports.ts`) are this module's own ports - the real
Mistral adapters and the deterministic fakes both implement them, and
`documents-use-cases.ts` depends only on the interface.

**`validateAnalysisResult`** (`core/analysis-validation.ts`) is the one function BOTH the
real analyzer (after parsing the chat completion's JSON content) and the fake analyzer call,
so every `AnalysisResult` this application ever produces, regardless of provider, obeys the
identical guarantees (architecture brief's product decision 8, requirement 5): `category`
must be one of `CATEGORY_KEYS` or falls back to `"other"`; `title`/`sender` are trimmed and
truncated to 120 characters; `documentDate` must be a plausible ISO `YYYY-MM-DD` (a
regex-and-`Date`-round-trip check, year 1900-2100) or becomes `null`; `summary` is truncated
to 300 characters. It never throws - a completely malformed or adversarial raw payload
degrades to `{ category: "other", title: null, sender: null, documentDate: null, summary:
null }`, never a processing failure. `src/modules/documents/tests/analysis-validation.test.ts`
proves this directly, including a prompt-injection-shaped string as a field value.

**Fakes** (`core/fake-ocr-engine.ts`, `core/fake-document-analyzer.ts`): deterministic in the
file name alone (no randomness, no clock, no network). A small ordered table of
keyword-to-template rules, most specific first (`"telekom"` before the generic `"rechnung"`,
so `rechnung-telekom.pdf` resolves to the Telekom-specific letter the architecture brief
names as its worked example: sender "Telekom Deutschland GmbH", "Rechnungsnummer 4711"), one
OCR block per generated line, falling back to a generic "Unbekannter Absender" letter for an
unrecognized file name. The fake analyzer runs a plain keyword search over the OCR text (not
just the file name, so it also does something reasonable against real OCR text of an
arbitrary document) and extracts a German `DD.MM.YYYY` date from the text if present,
converting it to ISO - then validates through the same `validateAnalysisResult` the real
adapter uses.

### 5. Searchable PDF (`src/modules/documents/core/searchable-pdf.ts`)

Pure (aside from `pdf-lib`'s own CPU work): loads the original PDF, embeds standard
Helvetica once, and for each page either (a) draws each OCR block's `content` as invisible
(`opacity: 0`) text positioned by mapping its pixel bounding box (`OcrPage.dimensions`'
pixel space) to PDF points - `mapBlockToPdfRect` scales by the ratio between the OCR page's
pixel size and the PDF page's point size and flips the y axis (pixel space grows downward
from the top-left; PDF space grows upward from the bottom-left), with a light adjustment for
a 90/270-degree page rotation (a 180-degree rotation needs none: the crop box orientation is
unchanged) - or (b) when blocks are missing/empty, distributes the markdown's own paragraphs
evenly down the page instead. Text is wrapped to the block's width (`font.widthOfTextAtSize`)
and font-sized to roughly fit the block's height (clamped 4-18pt).

**WinAnsi sanitization** (`core/winansi.ts`): pdf-lib's standard fonts are WinAnsi
(Windows-1252) encoded only - `sanitizeWinAnsi` keeps printable ASCII, Latin-1 (which
already covers ä/ö/ü/ß/Ä/Ö/Ü), and WinAnsi's own extra punctuation (smart quotes, en/em
dash, ellipsis, Euro sign, ...), replacing anything else (emoji, CJK, most other Unicode)
with `?` rather than letting `drawText` throw mid-page.

**Known limitation**: the invisible text layer uses `opacity: 0` on a normally-rendered text
object, not the PDF spec's dedicated invisible text-render mode (`Tr 3`) - pdf-lib's
high-level `drawText` API does not expose render mode directly, and reaching for raw content
stream operators was judged not worth the complexity for this phase. In every viewer this
was tested against (Chromium's PDF viewer, the pattern `src/modules/documents/tests/searchable-pdf.test.ts`
inspects), the practical effect is identical (invisible to the eye, present as real
text-showing operators) - a future phase could switch to `Tr 3` if a real-world viewer ever
demonstrates a difference. The application's own full-text search never depends on this
layer at all: it queries the separate `documents.ocr_text` Postgres column.

### 6. Routing rules (`category_routes`, owner `src/modules/workspaces`)

`src/persistence/schema/category-routes.ts`: `category_routes(id, workspace_id, category_id,
assignee_user_id)`, `unique (workspace_id, category_id)`. Kept in its own schema file
(rather than folded into `workspaces.ts` or `documents.ts`) purely to avoid a schema-file
import cycle: it references both `workspaces` and `categories`, and `schema/index.ts`'s
barrel exports it last, after both, so neither of those two files needs to import back from
it.

There is no nullable "no assignee" sentinel: the *absence* of a `(workspace_id,
category_id)` row means "Niemand" (architecture brief's product decision 7). `workspaces-use-cases.ts`
gained `listRoutingRules`/`setRoutingRule` (upsert or delete-the-row for "Niemand", validated
the same way as reassignment: the target must actually be a member of the workspace) and
`removeMember` now also calls `categoryRoute.deleteForUser` in the SAME transaction as the
member deletion and the existing `document.clearAssigneeForUser` call - a removed member
must not stay the invisible target of a routing rule either.

**UI**: `/dashboard/routing` ("Zuständigkeiten"), admin-only (`routing.manage`, already
present in `src/platform/access`'s permission bundle but unused before this phase) - a
row per category, each an independently-saved `<select>` (workspace members, or "Niemand").
Gated in the nav (`src/modules/dashboard-shell/core/nav-items.ts`'s `NavItem.permission`,
a new optional field this phase added) and 404s for a direct visit by a non-admin.

### 7. Notification e-mail (outbox)

`send-assignment-email` is a job, not a synchronous send, specifically so a slow or failing
SMTP call never blocks the upload response or the processing transaction (WEBAPP_TEMPLATE_SPEC.md's
mail recipe already treats mail as an outbox pattern elsewhere, e.g. the 80% quota warning
mail P3 will add). The handler (`job-handlers.ts`) re-reads the document at send time and
no-ops if it no longer exists, has no assignee e-mail, or its assignee has changed again
since the job was enqueued - the assignment might be stale by the time the job actually
runs. Template: `src/modules/documents/server/emails/assignment-email.tsx` (React Email,
German, "Neue Post für Sie: <title>"), `STRUCTURE.md`'s `vendor-sdk` rule extended to allow
`@react-email/` in `src/modules/documents/server/emails/`.

### 8. UI (German, "Sie"-form)

Document detail (`DocumentDetailClient`): a `ProcessingPoller` (mounted whenever status is
`uploaded`/`processing`) kicks the runner once and polls `router.refresh()` every 3 seconds
until done; the summary sentence; an "automatisch erkannt" badge next to the category select
when `category_source = "auto"`; a per-stable-error-code message with an "Erneut
verarbeiten" button when `status = "failed"`; a "Testmodus: KI-Simulation aktiv" banner when
the fake provider is bound. The Posteingang's inbox rows show a small spinner
(`lucide-react`'s `Loader2`, `animate-spin`) next to the status badge for
`uploaded`/`processing` rows, and the page itself mounts the same `ProcessingPoller`
whenever any of its currently-displayed rows are in one of those two statuses.

## Consequences

- Positive: the job queue is entirely reusable for a future job kind (P3's 80% quota warning
  e-mail is explicitly designed to land the same way, per `src/modules/billing/README.md`) -
  adding one means a new schema-owned repository call, a `JobHandler` function, and one line
  in `job-handlers.ts`'s map; `src/platform/jobs`/`jobs-use-cases.ts` need no change.
- Positive: `MistralRequestError`'s `transient` flag is the single source of truth for retry
  behavior - a future fourth trigger, or a change to the backoff formula, only ever touches
  `src/platform/jobs/core/backoff.ts` or `jobs-use-cases.ts`, never the Mistral adapters.
- Positive: both AI providers (real and fake) give every caller the exact same validated
  `AnalysisResult` shape, so a test written against the fake genuinely exercises the same
  downstream code path a real Mistral response would.
- Negative: the searchable PDF's invisible text layer is positionally approximate (font size
  is fitted heuristically, not measured against the actual rendered glyph metrics of the
  original scan) and uses `opacity: 0` rather than the PDF spec's dedicated invisible
  render mode - acceptable for "select and search text roughly where it visually is", not
  pixel-perfect OCR-overlay quality.
- Negative: Vercel Hobby's daily-only cron schedule means the cron sweep is a weak safety
  net in production on that tier; the two other triggers (`after()`, the UI kick) are what
  actually keep latency low, and a document a user never revisits, uploaded via an API path
  that somehow lost its `after()` invocation (a platform-level failure), could wait up to 24
  hours for the sweep. Vercel Pro or an external scheduler removes this ceiling.
- Negative: the data-protection documentation (DPA with Mistral, updating the privacy
  policy) that sending real customer document content to an EU AI provider requires is
  explicitly **not** part of this phase - a follow-up before any real (non-fake-provider)
  production traffic exists.
- Negative: two `process-document` jobs for the same document (e.g. a user clicking "Erneut
  verarbeiten" while an earlier attempt is still leased) can both run to completion, each
  writing the searchable PDF and marking the document done independently - the last write
  wins with no corruption, but it is wasted work and, if both happen to trigger auto-routing
  before either commits, could in principle enqueue two notification e-mails. Accepted as an
  unlikely, low-impact edge case for the MVP; a future phase could add an application-level
  guard (e.g. only allow retry when `status = 'failed'`, already true today, plus a short
  cooldown) if it proves to matter in practice.
- Implementation status: **implemented**. `src/platform/jobs`, `src/platform/mistral`, the
  `jobs`/`category_routes` schema and repositories, `documents-use-cases.ts`'s
  `processDocument`/`retryProcessing`/updated `reassign`, `workspaces-use-cases.ts`'s routing
  methods, the three triggers (`after()`, the cron route, the UI kick), the searchable PDF,
  the assignment e-mail, and the `/dashboard/routing` UI all land in this phase, with unit,
  `.db.test.ts`, integration, and e2e coverage. The billing 80% warning e-mail (P3) and the
  camera scanner (P2c, already landed independently) are unaffected by and do not depend on
  this phase beyond sharing the job queue's shape.

## Supersedes / Superseded By
- None
