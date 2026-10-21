# digipost

Document type: reference
Lifecycle: active
Owner: template maintainer
Scope: Project purpose, local setup, commands, environment variables, CI, security
headers, and what remains before this product can go to production
Canonical responsibility: The entry point for anyone (human or agent) opening this
repository for the first time
Maintenance triggers:
- A `package.json` script is added, removed, or renamed
- An environment variable is added, removed, or its requirement changes
- A new top-level owner root (`src/modules/`, `src/persistence/`, ...) is populated for the first
  time
- `.github/workflows/ci.yml` changes what runs or when
Last verified: 2026-10-21, decisions/0073-public-repo-and-production-pipeline.md: rewrote "CI" (GitHub-hosted
runners, the Docker-backed suites back on), added "Deployment" and "License", rewrote the deploy-related
items of "Before going to production". 2026-09-20, F5 (hardening, decisions/0027-hardening-and-deletion.md): added
the "Workspace deletion and retention" feature bullet, the F5 summary at the end of "Current
build status", a "Local setup from zero" step for finance/workspace deletion, and the
`vercel.json` two-cron-route note under "Before going to production". 2026-09-20, F3b (payment matching wiring, decisions/0025-payment-matching-wiring.md):
added the "Payment matching" feature bullet below. 2026-09-20, F1b (universal intake wiring, decisions/0022-intake-wiring.md):
updated the "Documents" and "Universal intake recognizer" bullets below for the intake
confirmation flow and the upload route's new accepted file types. 2026-09-20, C2 (extraction direction and invoice fields,
decisions/0021-extraction-direction-and-invoice-fields.md): updated the "OCR/AI processing
pipeline" and "Contacts" bullets below to describe direction/invoice-field extraction and
contact linking. 2026-09-20, C1 (contacts data model and domain): added the "Contacts" feature
bullet below. 2026-09-19, P5c (repository identity and documentation): rewrote this
file to describe Digipost as a product rather than as an unstarted template

## Purpose

Digipost is a "digitaler Posteingang" (digital mailroom) SaaS for small and medium
German businesses (Germany/DACH market, UI German-only, `decisions/0013-german-ui-language.md`).
A team scans its incoming paper mail with a phone camera or uploads a PDF/image; Digipost
OCRs it (Mistral OCR), recognizes what kind of document it is and extracts key fields with a
small LLM (Mistral Small), files it under a generated name, matches it against the bank
account's own transactions, and makes it searchable. The core value proposition is not
storage, it is that a piece of paper mail explains itself and its payment without anyone
re-typing anything.

Digipost deliberately does NOT route or assign a document to a person
(decisions/0063-no-category-no-assignment-no-routing.md): every member sees the same inbox.
It also has no second "category" taxonomy beyond the document kind itself. Both existed and
were removed once real usage showed the category held one constant value and no routing rule
was ever created.

What exists today, as vertical slices:

- **Workspaces, team, and invitations** (`src/modules/workspaces`, `src/platform/access`,
  decisions/0014-workspaces-and-access.md): a signed-in user without a workspace creates
  one at `/onboarding` (name, company address, optional VAT id) and becomes its admin; the
  admin invites members by email (`/dashboard/team`), and members accept via a magic-link
  sign-in at `/invite/[token]`. A user may belong to several workspaces and switches between them in the
  sidebar (decisions/0070-several-workspaces-per-user.md); exactly one admin per workspace, no
  further roles - what an admin may do that a member cannot is expressed as permission
  bundles (`src/platform/access`), not role-string checks. The admin can also edit the
  company profile later at `/dashboard/settings/company` ("Firmendaten",
  decisions/0021-extraction-direction-and-invoice-fields.md).
- **Documents, with a camera scanner** (`src/modules/documents`, `src/modules/scanner`,
  decisions/0015-documents-and-quotas.md): upload a PDF/JPEG/PNG, a bank statement in the
  CAMT.053 XML or MT940 format, or a CSV/TSV bank/payout export (decisions/0020-universal-intake.md,
  decisions/0022-intake-wiring.md, decisions/0028-mt940-support.md), or scan pages with the
  rear camera (`/dashboard/scan`, live edge detection via scanic, multi-page, perspective
  correction). The file picker accepts any file - the server sniffs the real content by bytes
  and never trusts a file's extension or declared MIME type either way, so there is nothing
  for a picker-side extension filter to add beyond hiding a real export by accident
  (decisions/0028-mt940-support.md's own bug fix). Every upload is capped at 4 MB per request
  (Vercel's platform body limit) - a yearly CAMT.053/MT940/CSV export that exceeds this needs
  to be split by the user before upload, a known, accepted limitation (no chunked/streamed
  upload path exists yet). The exact same file uploaded twice is rejected
  outright ("Dieses Dokument ist bereits vorhanden"), before it ever touches storage or the
  quota. See the inbox (`/dashboard`, search/filter/pagination, a kind filter, a "Bestätigung
  nötig" chip for a tabular import awaiting confirmation), open a document's detail view (the
  searchable PDF plus its extracted metadata, or - for a tabular import - a confirmation
  panel), recategorize, reassign, delete, or retry a failed one.
- **OCR/AI processing pipeline, with jobs** (`src/platform/jobs`, `src/platform/mistral`,
  decisions/0016-processing-pipeline-and-ai.md,
  decisions/0021-extraction-direction-and-invoice-fields.md): every upload is queued
  (`uploaded -> processing -> done | failed`) and run through Mistral OCR, then
  categorized and field-extracted (title, sender, document date, one-sentence summary, up
  to 3 parties mentioned on the document, and invoice fields for an invoice/reminder/
  receipt-like one) by the same Mistral chat-completions call, then rebuilt as a searchable
  PDF (an invisible OCR text layer over the original pages), auto-routed to the assignee a
  per-category rule names (`/dashboard/routing`), and the assignee is emailed. Whether a
  document is `incoming` or `outgoing` is decided in code (never trusted from the model)
  by comparing every extracted party against the workspace's own company profile; every
  non-own party is linked into the contacts model below. Without `MISTRAL_API_KEY`,
  deterministic fake adapters stand in and the UI marks results "Testmodus: KI-Simulation" -
  see "Local setup from zero" below.
- **Billing tiers, with a test-mode payment adapter** (`src/modules/billing`,
  decisions/0017-billing-tiers-and-packages.md): `/dashboard/billing` ("Tarif & Nutzung")
  shows the workspace's tier, both quota limits (total documents stored, new documents
  this calendar month) as progress bars, and this period's one-off package purchases. No
  Stripe keys exist yet: tier changes and package purchases only work when
  `BILLING_TEST_MODE=true`, behind an unmissable "Testmodus" badge, through a
  `PaymentProvider` port a real Stripe adapter will implement later. A workspace crossing
  80% of either limit gets a warning email, at most once per limit per calendar month.
- **Contacts, wired into the processing pipeline** (`src/modules/contacts`,
  decisions/0019-contacts.md, decisions/0021-extraction-direction-and-invoice-fields.md): a
  workspace's "Firmenkontakte" extracted from its documents - matching (VAT id,
  Handelsregister entry, IBAN, customer number + name, or name + postal code, strongest
  first), and verification semantics that never let an extracted value silently overwrite an
  already-known one (a changed IBAN on a supplier invoice becomes a reviewable proposal, not
  a silent update - a classic invoice-fraud pattern this is designed to catch, not enable).
  Every document's extracted parties are now linked here after processing (C2); the
  workspace's own company profile is set at `/onboarding` and edited at
  `/dashboard/settings/company` ("Firmendaten") so the pipeline never files the workspace's
  own address as if it were a contact. The contacts list/detail/proposal-review UI itself
  (C3) is a separate, not-yet-landed phase.
- **Universal intake recognizer, wired end to end** (`src/modules/intake`,
  `src/modules/documents`, decisions/0020-universal-intake.md,
  decisions/0022-intake-wiring.md): the file format only decides how content is read (OCR
  text, an XML parse, a tabular sample); what the content IS (a letter, an invoice, a bank
  statement, a Stripe payout report, an Apple/Google platform settlement report, ...) is
  decided by the same AI-assisted classifier for every format alike, except camt.053 bank
  statements and embedded ZUGFeRD/Factur-X/XRechnung invoice XML, which identify themselves
  unambiguously and are recognized deterministically instead (no model call, always
  auto-confirmed). A CSV/TSV export the classifier has not seen a matching column layout for
  before shows up in the inbox as "Bestätigung nötig": its detail page shows the recognized
  kind/platform and column mapping (editable) plus the first rows as the system understood
  them, and "Bestätigen und importieren" re-validates the mapping against the FULL file before
  importing anything. Once confirmed, the SAME source layout (by a fingerprint of its header/
  delimiter, not its content) imports automatically on every later file, without asking again
  - an admin can undo that at `/dashboard/settings/intake` ("Erkannte Quellen", "Zuordnung
  zurücksetzen"). An invoice that looks like a duplicate of an earlier one (same invoice
  number, sender, and amount, on a different file - a re-scan or a re-sent PDF) gets a
  "möglicherweise doppelt" hint linking to the earlier one; nothing is ever deleted
  automatically.
- **Accounts and transactions, admin-only** (`src/modules/accounts`,
  decisions/0024-accounts-and-transactions.md): the moment a bank statement (camt.053, or a
  confirmed CSV/TSV mapping) is confirmed, its transactions are imported into a workspace's
  own bank accounts - auto-resolved (or auto-created) by IBAN when the statement carries one,
  otherwise surfaced under "Finanzen" > "Konto zuordnen" for an admin to pick or create the
  account manually. Re-importing an overlapping period is idempotent (zero duplicate
  transactions, reported as such); `/dashboard/finance` shows every account's latest balance
  and statement-coverage gaps, `/dashboard/finance/[accountId]` a searchable/filterable
  transaction list and import history with balance-mismatch warnings. `finance.read`/
  `finance.manage` are admin-only with no member-level counterpart at all - the first such
  bundle in this template - because a bank statement exposes salaries and other private
  debits.
- **Payment matching** (`src/modules/payments`, decisions/0023-payment-matching.md,
  decisions/0025-payment-matching-wiring.md): answers "Ist diese Rechnung bezahlt?" for every
  invoice-shaped document - deterministic rules (an exact or Skonto-tolerant amount plus an
  invoice number/IBAN/name signal auto-confirm), arithmetic (a partial payment, or several
  invoices settled by one collective transfer), and an AI arbiter for what remains ambiguous,
  run after every bank import and every processed invoice. A member sees only a document's
  payment status (offen/überfällig/bezahlt) and paid-on date; `/dashboard/finance` >
  "Zuordnung" (unmatched transactions and their suggestions, confirm/reject, bulk "kein Beleg
  nötig") and "Offene Posten" (open/overdue invoices by due date) are admin-only, same
  `finance.read`/`finance.manage` bundle as the accounts area above - confirming or rejecting a
  suggestion, or seeing an amount/counterparty at all, is finance information.
- **Platform settlements** (`src/modules/accounts`, `src/modules/payments`,
  decisions/0026-platform-settlements.md): a confirmed payout/settlement report (Stripe,
  Apple, Google, PayPal, Amazon) imports into that platform's OWN clearing account under
  "Finanzen" (revenue lines as credits, fees/refunds/the payout itself as debits); an outgoing
  invoice matches its revenue line by invoice number found in the report's own metadata (a
  weaker customer+amount+date match needs a human's confirmation instead); the monthly
  platform fee invoice settles automatically once its period's fee lines are known; the
  platform's payout pairs with the matching bank deposit, even when the bank statement is
  imported later. See "Stripe und andere Plattformen" below for the operator-facing how-to.
- **Marketing landing page** (`src/app/(marketing)/`): hero, problem, how it works,
  features, a comparison to a scan-service bureau, pricing (read from
  `src/modules/billing`'s tier constants, never duplicated), trust/privacy facts, FAQ, and
  placeholder legal pages (`/legal-notice`, `/privacy`) that are explicitly marked as
  drafts pending legal review (see "Before going to production" below).
- **Workspace deletion and retention** (`src/modules/workspaces`,
  decisions/0027-hardening-and-deletion.md): an admin can permanently delete the entire
  workspace from `/dashboard/settings/company`'s danger zone (typed confirmation of the
  workspace's exact name) - every document, contact, account, transaction, invitation,
  membership, and usage record it owns, plus every object under its own
  `workspaces/<id>/` prefix in object storage, fulfilling the DSGVO right to erasure at the
  workspace level (per-document deletion already existed). A non-admin member can leave
  their own workspace ("Arbeitsbereich verlassen", `/dashboard/team`); an admin cannot
  (delete the workspace instead, there is no admin-transfer flow). The only thing this
  product ever auto-deletes is a rejected intake proposal ("Ablehnen") more than 30 days
  old (`GET /api/cron/purge-rejected-intake`) - everything else stays until a human deletes
  it.

Digipost is built from a Next.js starter template: TypeScript strict, Tailwind 4, App
Router, pnpm, a documented owner-model layout (`src/modules/`, `src/shared/`,
`src/platform/`, `src/persistence/`), and machine-checkable conventions instead of tribal
knowledge. `WEBAPP_TEMPLATE_SPEC.md` is the full architecture reference the template
(and therefore Digipost) implements, kept as-is and never edited for this specific
product; `AGENTS.md` has the rules that apply to anyone, or any agent, working in this
repository, including the Digipost-specific domain rules the template did not have.

**Repository layout** (`STRUCTURE.md` §1 is the enforced version,
`decisions/0011-src-and-tests-roots.md` the reasoning):

```text
src/            application code
  app/          Next.js routes and seams only (pages, layouts, route handlers)
  modules/      vertical capabilities (sign-in, workspaces, documents, scanner, billing,
                intake, contacts, accounts, payments, dashboard-shell)
  shared/       neutral building blocks with 2+ consumers (ui-primitives, ...)
  platform/     app-wide infrastructure (auth, env, mailer, api-pipeline, observability,
                access, object-storage, jobs, mistral)
  persistence/  schema, migrations, repositories, use cases, composition root
  i18n/         locale config and messages
  proxy.ts, instrumentation*.ts, sentry.*.config.ts   Next.js/Sentry convention files
tests/          cross-cutting suites (owner unit/DB tests live in each owner's tests/)
  e2e/          Playwright specs (serial/, helpers/)
  integration/  route-handler and wiring tests against real Postgres
  config/       unit tests for root config files (next.config.ts)
docker/         Dockerfiles, compose.yml (local dev), compose.test.yml (hermetic tests)
scripts/        db, deploy, structure checker, test runner
decisions/      architecture decision records
public/         static assets served as-is
```

Everything else at the root is configuration that tooling expects there
(`package.json`, `next.config.ts`, `tsconfig.json`, `vitest.config.ts`, ...) or a
governance document (`AGENTS.md`, `STRUCTURE.md`, `DOC_RULES.md`).

**Current build status.** Digipost is being built in phases (see the architecture brief
this project tracks internally); this section says what exists and works today, not what
`WEBAPP_TEMPLATE_SPEC.md` describes in the abstract. P0a/P0b (infrastructure and locale)
added object storage (`src/platform/object-storage`, decisions/0012-object-storage.md) and
switched the UI to German-only (decisions/0013-german-ui-language.md). P1 (tenancy) removed
the template's generic `projects` example module (its schema, repository, use case, the
`/dashboard/projects` page, and its cron example
`src/app/api/cron/purge-archived-projects` plus its `vercel.json` entry) and replaced it
with `src/modules/workspaces` (onboarding, team membership, invitations) and
`src/platform/access` (permission-bundle authorization) as this repository's real vertical
slice - see decisions/0014-workspaces-and-access.md and `src/modules/workspaces/README.md`'s
"How the `projects` example module was removed". P2a (documents core + quota enforcement,
decisions/0015-documents-and-quotas.md) added `src/modules/documents` (upload, storage,
inbox search/filter/pagination, detail view, recategorize/reassign/delete) and
`src/modules/billing` (tier/package data, the pure `evaluateQuota` check): `POST
/api/documents` (`src/app/api/documents/route.ts`) is `src/platform/api-pipeline`'s first
real adopter and `src/platform/object-storage`'s first real consumer, and
`src/platform/access`'s `workspaceAccess`/`WorkspaceAccessError` gained their first real
consumer. P2c (camera scanner, `src/modules/scanner`) added client-only camera capture with
automatic edge detection (`scanic`); the "Kamera" tab on `/dashboard/scan` calls the same
`uploadDocument` helper the file-upload tab already used. P2b (processing pipeline,
decisions/0016-processing-pipeline-and-ai.md) added `src/platform/jobs` (the async job
queue: claim/lease/backoff, three triggers - `after()`, a cron sweeper at
`GET /api/cron/process-jobs`, and a workspace-scoped UI "kick") and `src/platform/mistral`
(Mistral OCR/chat, plain `fetch`, with deterministic fakes bound whenever no
`MISTRAL_API_KEY` is set outside production): every uploaded document is now OCR'd,
categorized, given a searchable-PDF text layer, auto-routed by a per-category rule
(`/dashboard/routing`, `src/modules/workspaces`), and its assignee notified by e-mail.
`requireCronSecret` gained its first real adopter. P3 (billing, quota packages, and
warnings, decisions/0017-billing-tiers-and-packages.md) added `/dashboard/billing` ("Tarif &
Nutzung": usage display, admin-only tier changes and one-off digitization-package
purchases), `src/modules/billing`'s `PaymentProvider` port with a test-mode adapter (gated
behind `BILLING_TEST_MODE`, since no Stripe keys exist), and the 80% quota-warning e-mail
(an outbox job, at most once per limit per calendar month). P4 (marketing) replaced the
template's placeholder homepage with Digipost's real landing page (`src/app/(marketing)/`:
hero, problem, how it works, features, a comparison to a scan-service bureau, pricing read
live from `src/modules/billing`'s tier constants, trust/privacy facts, FAQ) while keeping
its legal pages honest drafts pending legal review. P5c rewrote this file, `AGENTS.md`, and
`decisions/README.md` to describe Digipost rather than an unstarted template. (This
paragraph's phase-by-phase narrative was not kept current between P5c and F4 - the
"Purpose" section above it is the accurate, up-to-date description of every feature that
actually exists today, including everything F1a through F4 added; this note is here so a
future reader does not mistake the gap for those phases never having happened.) F5
(hardening, decisions/0027-hardening-and-deletion.md) added admin-only workspace deletion
and non-admin member self-removal (`src/modules/workspaces`), the `purge-rejected-intake`
retention cron (the only auto-deletion this product performs), `ObjectStorage`'s
`listObjects`/`deleteObjects`, a permissions review across every module F1b through F4
added (one defense-in-depth fix: `document_contacts` reads now enforce `workspaceId` at the
query level, not only via caller discipline), and an adversarial review pass closing
several F2/F4-review findings (an IBAN can no longer be changed on an account with
import history, a bank statement can no longer be assigned to a platform's clearing
account, a mixed-currency account's fallback balance no longer silently sums across
currencies, a partial unique index now prevents two clearing accounts for the same
platform) and root-causing the persistent `billing.spec.ts` upload flake.

**Template foundation underneath the product above.** Digipost is built on a generic
Next.js starter template, and most of that scaffolding is still exactly what it was:
the Next.js app and its tooling (`typecheck`/`lint`/`test`/`verify`), `.env.example`,
local Postgres/Mailpit/MinIO infrastructure (`docker/compose.yml`), UI primitives
(`src/shared/ui-primitives/`), single-locale i18n (`src/i18n/`, now German instead of the
template's default English, decisions/0013), the persistence layer (Drizzle + `pg`, the
three DB roles' grants and bootstrap script, migrations, use cases, and the composition
root), the hermetic Docker test stack (`docker/compose.test.yml`, `docker/`,
`pnpm test:docker`/`test:e2e:docker`), Better Auth (magic-link sign-in, session lookup,
`src/proxy.ts`'s cookie gate, the mailer, sign-out), the authenticated dashboard shell
(`src/modules/dashboard-shell`: sidebar/mobile navigation, header with the signed-in user's
email and sign-out), the JSON API route-handler pipeline (`src/platform/api-pipeline`: the
`access -> parse -> execute -> respond` step machine, Zod validation, the `{ errorCode }`
envelope, a cron bearer-secret access step and a session access step), `GET /api/health`
(liveness + DB readiness), observability (`src/platform/observability` + Sentry, fully
inert unless `SENTRY_DSN`/`NEXT_PUBLIC_SENTRY_DSN` is set), CI
(`.github/workflows/ci.yml`: check, db, e2e-pr, e2e-full, and nightly jobs against the
hermetic Docker test stack, see "CI" below), the structure checker (`STRUCTURE.md`,
`pnpm verify:structure`, `scripts/structure/**`, `WEBAPP_TEMPLATE_SPEC.md` §11.1/§11.5,
wired into `pnpm verify` and the `check` CI job), and a safer `Strict-Transport-Security`
default (see "Security headers" below) all exist and work exactly as the template
designed them to. Deploy automation (`WEBAPP_TEMPLATE_SPEC.md` §13,
`.github/workflows/deploy-production.yml`, see `scripts/deploy/README.md` and
decisions/0073-public-repo-and-production-pipeline.md) deploys every push to `main` once the
accounts and secrets it needs exist (see "Before going to production" below).

## Local setup from zero

```sh
cp .env.example .env.local   # fill in values, or keep the defaults that match docker/compose.yml
pnpm install
pnpm infra:up                # starts local Postgres + Mailpit + MinIO (docker/compose.yml)
pnpm db:bootstrap            # creates the app_runtime/app_public DB roles (once per DB)
pnpm db:migrate              # applies src/persistence/migrations/ (drizzle-kit generated)
pnpm dev                     # http://localhost:3000
pnpm verify                  # typecheck, lint, structure check, unit tests, before you open a PR
```

`pnpm infra:down` stops the local infrastructure. See `.env.example` for what each
variable is for and where it's read; see `src/persistence/README.md` for the full persistence
layer (schema, roles/grants, migration workflow) and `decisions/0004-three-database-roles.md`
for why there are three DB roles.

1. **Fill in `.env.local`.** `BETTER_AUTH_SECRET` and `CRON_SECRET` need real values
   (`openssl rand -base64 32` each, at least 32 characters); every other variable already
   matches `docker/compose.yml`'s local Postgres/Mailpit/MinIO. `MISTRAL_API_KEY` and
   `BILLING_TEST_MODE` are optional, see steps 4 and 5 below.
2. **Sign in.** There are no passwords: `/login` emails a sign-in link. Locally that mail
   goes to the Mailpit container `pnpm infra:up` started - open its web UI at
   `http://localhost:54344`, click the link in the mail, and you land on `/dashboard`
   signed in. See `src/platform/auth/README.md` for the Better Auth config and
   `src/modules/sign-in/README.md` for the login form/Server Action.
3. **Create a workspace and scan or upload your first document.** A user with no
   workspace is redirected to `/onboarding`; name a company and you become its admin
   (`src/modules/workspaces/README.md`). Then `/dashboard/scan` has two tabs: "Kamera"
   (camera capture with live edge detection, `src/modules/scanner`; needs a device camera
   and HTTPS or `localhost`) and "Datei hochladen" (a PDF/JPEG/PNG, a CAMT.053 or MT940
   bank-statement export, or a CSV/TSV bank/payout export file input,
   decisions/0022-intake-wiring.md, decisions/0028-mt940-support.md). Either
   path lands the new document in the inbox (`/dashboard`) as `uploaded`, then
   `processing`, then `done`; a CSV/TSV whose column layout has not been confirmed before
   also needs "Bestätigen und importieren" on its detail page before its rows count as
   imported.
4. **AI simulation mode.** With `MISTRAL_API_KEY` left empty, `AI_PROVIDER` defaults to
   `fake` outside production: OCR and categorization run through deterministic fake
   adapters instead of a real Mistral call, and the UI marks the result "Testmodus:
   KI-Simulation aktiv" wherever it appears. To use real Mistral OCR/categorization
   instead, add a real key to `MISTRAL_API_KEY` in `.env.local` (leave `AI_PROVIDER` unset
   or set it to `mistral`) and restart `pnpm dev` - see
   `decisions/0016-processing-pipeline-and-ai.md`'s "Data protection note" before pointing
   this at any real customer document.
5. **Try billing.** `.env.example` sets `BILLING_TEST_MODE=true` for local development, so
   `/dashboard/billing`'s admin-only tier-change and package-purchase controls work
   end-to-end (behind a "Testmodus" badge) even though no Stripe keys exist -
   decisions/0017-billing-tiers-and-packages.md.
6. **Try finance (admin-only).** Upload a CAMT.053 or MT940 bank-statement export, or a
   bank/payout CSV export (step 3 above) to see `/dashboard/finance` ("Finanzen") populate an account and
   its transactions - visible and manageable only for the workspace's admin
   (`finance.read`/`finance.manage`, decisions/0024-accounts-and-transactions.md); a plain
   member never even sees the nav entry. The 4 MB upload cap applies to a structured file
   too, so export a large statement monthly rather than for a whole year
   (decisions/0027-hardening-and-deletion.md); a Stripe/Apple/Google/PayPal payout or
   settlement report works the same way (`platform`, decisions/0026-platform-settlements.md,
   "Stripe and other platforms" below).
7. **Inspect what the app stored.** Mailpit's web UI (`http://localhost:54344`) shows
   every e-mail the app sent (invitations, assignment notifications, quota warnings).
   MinIO's console (`http://localhost:54347`, sign in with `.env.example`'s
   `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY`, both `minioadmin` locally) shows the
   uploaded `original.pdf`/`searchable.pdf` objects (or `original.xml`/`original.csv`/
   `original.tsv`/`original.mt940` for a structured intake file, stored as-is,
   decisions/0022-intake-wiring.md, decisions/0028-mt940-support.md)
   under `workspaces/<workspaceId>/documents/<documentId>/` in the `digipost-documents`
   bucket.
8. **Workspace deletion is real and irreversible, even locally.** `/dashboard/settings/company`'s
   danger zone (admin-only, `PERMISSIONS.workspaceManage`) permanently deletes the
   workspace and everything in it, including its object-storage prefix
   (decisions/0027-hardening-and-deletion.md) - use a disposable local workspace to try it,
   not one you want to keep testing against.

## Commands

| Command | What it does |
|---|---|
| `pnpm dev` | Start the Next.js dev server (Turbopack). |
| `pnpm build` | Production build. |
| `pnpm start` | Run the production build. |
| `pnpm typecheck` | `next typegen` (generates `PageProps`/`LayoutProps`/`RouteContext` types) then `tsc --noEmit`. |
| `pnpm lint` | ESLint (flat config, `next/core-web-vitals` + `next/typescript`). |
| `pnpm verify:structure` | Mechanically enforces `STRUCTURE.md`'s placement and dependency rules (see below). No database, no network. |
| `pnpm test` | Vitest, `unit` project only: no database, no network (`scripts/test/unit-guard.ts` enforces this). |
| `pnpm test:db` | Vitest, `db` project: `*.db.test.ts` against a real Postgres (`DATABASE_URL`/`DATABASE_URL_PUBLIC`/`DATABASE_URL_MIGRATE`, local-host allowlisted). Refuses to run unless `DIGIPOST_TEST_STACK=1` is set (`docker/compose.test.yml` sets it) - run `pnpm test:docker` instead of invoking this directly on the host, which would otherwise run against your local dev database (`docker/compose.yml`). |
| `pnpm test:int` | Vitest, `integration` project: `tests/integration/**/*.integration.test.ts` against real Postgres. Same `DIGIPOST_TEST_STACK=1` guard as `pnpm test:db` above - run `pnpm test:docker`. |
| `pnpm test:e2e` | Playwright against a running or freshly built app (`E2E_PORT`/`E2E_BASE_URL` overridable). |
| `pnpm test:docker` | The reference run of `test:db` + `test:int`, inside the hermetic Docker test stack (`docker/compose.test.yml`, `decisions/0006-docker-test-stack-as-reference.md`). |
| `pnpm test:e2e:docker` | The reference e2e run, inside the same hermetic Docker test stack. |
| `pnpm verify` | `typecheck` + `lint` + `verify:structure` + `test`. Run this before every PR (`AGENTS.md`, `decisions/0002-no-git-hooks.md`); there are no git hooks, only CI and this command enforce it. Run `test:db`/`test:int`/`test:docker`/`test:e2e` too whenever the change touches schema, database access, or a UI flow (`AGENTS.md`'s Workflow section). |
| `pnpm infra:up` | Start local Postgres + Mailpit + MinIO (`docker/compose.yml`), waiting until healthy, then create the local MinIO bucket (`minio-init`). |
| `pnpm infra:down` | Stop local infrastructure. |
| `pnpm db:bootstrap` | Create the `app_runtime`/`app_public` DB roles (idempotent; `scripts/db/bootstrap-roles.mjs`). |
| `pnpm db:generate` | Generate a migration from a `src/persistence/schema/**` change (`drizzle-kit generate`). |
| `pnpm db:generate:custom <name>` | Generate an empty custom-SQL migration from `src/persistence/sql/<name>/<name>.sql`. |
| `pnpm db:migrate` | Apply pending migrations (`--status` to list without applying; refuses a non-local host without `--remote`). |
| `pnpm db:seed` | Apply `src/persistence/seed.sql` if it exists (local/test-stack only). |
| `pnpm db:reset` | Local only: drop and recreate the database's schemas, then migrate and seed. |
| `pnpm db:studio` | Open Drizzle Studio against `DATABASE_URL_MIGRATE`. |
| `pnpm deploy:check` | Post-deploy smoke check against a live URL (`scripts/deploy/check.mjs`); called by `.github/workflows/deploy-production.yml` (`DEPLOY_CHECK_BYPASS_SECRET` carries the Vercel Protection Bypass secret), not part of local `pnpm verify`. |

**`pnpm verify:structure`.** Interprets `STRUCTURE.md`'s machine-readable `structure`
code blocks (`scripts/structure/verify-structure.ts`, run via `tsx`,
`WEBAPP_TEMPLATE_SPEC.md` §11.1/§11.5) and mechanically enforces the placement and
dependency rules `AGENTS.md`'s "Structure" section and
`decisions/0001-single-app-owner-model.md` otherwise only document as review rules:
top-level roots, owner-internal directory names, public entrypoints
(`index.ts`/`client.ts`/`server.ts`/`actions.ts`), the dependency direction matrix
(including the client-never-reaches-privileged invariant), persistence layering and
its seam-only external door, the single `cache(createRequestServices)` declaration,
`src/app/**` seam filenames, test file placement and suffixes, documentation metadata and
link integrity, confinement of sensitive env variables and vendor SDKs to their
owning files, and e2e specs never importing product code. Twelve rules in total, one
per `scripts/structure/rules/*.ts` module; a code block with no implementing rule, or
a rule with no block, is itself a checker error. Wired into `pnpm verify` and the
`check` CI job.

## CI

`.github/workflows/ci.yml` (`WEBAPP_TEMPLATE_SPEC.md` §11.3,
`decisions/0073-public-repo-and-production-pipeline.md`). The repository is public, so CI runs on
GitHub-hosted runners only (`ubuntu-24.04`), uses no repository secret, and gives a pull request from a fork
nothing but a read-only token.

| Job | Runs when | What it does |
|---|---|---|
| `changes` | always | `dorny/paths-filter` on pull requests: code, Markdown, workflow files. |
| `check` | pushes, manual runs, PRs into `main`; other PRs when code or docs changed | Install, typecheck, lint, structure check (`pnpm verify:structure`), unit tests, build (dummy `NEXT_PUBLIC_APP_URL`/`APP_URL`, no DB/secrets needed), migration drift check (`pnpm db:generate` then `git diff --exit-code src/persistence/migrations`). A docs-only PR runs only the structure check. |
| `db` | like `check`, when code changed | `pnpm test:db` and `pnpm test:int` against `postgres:18`, Mailpit and MinIO (service containers plus `.github/actions/test-stack`; the same stack as `docker/compose.test.yml`, without Docker Compose). |
| `e2e` | like `db` | Playwright against a production build. PRs into `development`: the `@smoke` set. PRs into `main`, pushes and manual runs: the full suite. Report uploaded only on failure. |
| `actionlint` | pushes, manual runs, PRs into `main`; other PRs when `.github/**` or `scripts/vercel/**` changed | Lints the workflow files. |
| `ci-passed` | always (`if: always()`) | The single required status check: fails if any job failed or was cancelled, passes if the rest succeeded or were skipped. |

Pull requests cancel their superseded run; pushes never cancel. Make `ci-passed` a required status check on
`main` and `development` (`scripts/deploy/README.md`, section 3).

```sh
pnpm verify          # what the `check` job runs (minus the build)
pnpm test:docker     # what `db` runs, in the local Docker test stack (the reference run, decisions/0006)
pnpm test:e2e:docker # what `e2e` runs, in the local Docker test stack
```

Every job that needs a database or SMTP runs against throwaway containers, never a hosted database, so none of
them need a repository or environment secret.

### Deployment

A release is a pull request from `development` into `main`. A push to `main` starts
`.github/workflows/deploy-production.yml`: migrate, stage a domain-less production deployment on Vercel, check
its health through Deployment Protection (`scripts/deploy/check.mjs`), then promote it.
`.github/workflows/rollback-production.yml` restores an earlier deployment by hand. Secrets are read from
Infisical (`prod:/ci`) by a least-privilege machine identity; the only GitHub secrets are the four Infisical
sign-in values of the environment `production`. There is no staging environment. The whole setup (GitHub,
Infisical, Vercel, Neon, R2, mail, Mistral, Sentry), the first deployment, rollback and secret rotation are in
`scripts/deploy/README.md`.

### License

All rights reserved (`LICENSE`, `"license": "UNLICENSED"` in `package.json`). The source is public for
transparency only; viewing and forking it on GitHub is permitted by GitHub's Terms of Service, and nothing else
is granted without written permission.

## Environment variables

See `.env.example` for the authoritative, commented list; summarized here:

| Variable | Required | Read by |
|---|---|---|
| `APP_URL` | yes | `src/platform/env` (server) |
| `NEXT_PUBLIC_APP_URL` | yes | `src/platform/env` (public, inlined at build time) |
| `DATABASE_URL` | yes | `src/persistence/foundation/client.ts` (via `src/platform/env`) |
| `DATABASE_URL_PUBLIC` | only if an unauthenticated public path needs it | `src/persistence/foundation/**` only |
| `DATABASE_URL_MIGRATE` | yes | `scripts/db/*`, `drizzle.config.ts` only, never at request time |
| `BETTER_AUTH_SECRET` | yes | `src/platform/auth` (via `src/platform/env`) |
| `AUTH_BOOTSTRAP_EMAILS` | optional (first admin of a fresh database only; sign-up is otherwise by invitation, decisions/0074) | `src/platform/auth` (via `src/platform/env`) |
| `SMTP_URL`, `MAIL_FROM` | yes | `src/platform/mailer` (via `src/platform/env`) |
| `CRON_SECRET` | yes | `src/platform/api-pipeline/server/cron-auth.ts` (via `src/platform/env`) |
| `S3_ENDPOINT` | optional | `src/platform/object-storage` (via `src/platform/env`) |
| `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | yes | `src/platform/object-storage` (via `src/platform/env`) |
| `S3_FORCE_PATH_STYLE` | optional | `src/platform/object-storage` (via `src/platform/env`) |
| `MISTRAL_API_KEY` | optional (real AI needs it; unset outside production binds deterministic fakes) | `src/platform/mistral` (via `src/platform/env`) |
| `AI_PROVIDER` | optional (`mistral` \| `fake`) | `src/platform/mistral` (via `src/platform/env`) |
| `MISTRAL_OCR_MODEL`, `MISTRAL_CHAT_MODEL` | optional | `src/platform/mistral` (via `src/platform/env`) |
| `BILLING_TEST_MODE` | optional (default false; only `true` in local dev and the hermetic test stack, never production - no Stripe keys exist) | `src/modules/billing` (via `src/platform/env`) |
| `SENTRY_DSN` | optional | `src/platform/observability`, `next.config.ts` |
| `SENTRY_AUTH_TOKEN` | optional | build only (source map upload), `next.config.ts` |
| `APP_COMMIT_SHA` | optional, never set locally | `GET /api/health`, `scripts/deploy/check.mjs`; set only per deployment by `.github/workflows/deploy-production.yml` |

Never create `.env.production` or `.env.production.local`: Next.js loads them on every
local `next build`/`next start`, which would point a local build at production. Production
values live only in the hosting provider's dashboard.

**Local ports.** `docker/compose.yml`'s defaults, overridable via `DEV_POSTGRES_PORT`/
`DEV_MAILPIT_WEB_PORT`/`DEV_MAILPIT_SMTP_PORT`/`DEV_MINIO_API_PORT`/`DEV_MINIO_CONSOLE_PORT`
if you run more than one project's local stack side by side: Postgres `54339`, Mailpit web
UI `54344`, Mailpit SMTP `54345`, MinIO S3 API `54346`, MinIO console `54347`. All bound to
`127.0.0.1` only.

## Security headers

`next.config.ts`'s `headers()` sends the same set on every route (`WEBAPP_TEMPLATE_SPEC.md`
§8): `Content-Security-Policy`, `X-Content-Type-Options`, `Referrer-Policy`,
`Permissions-Policy`, and `Strict-Transport-Security`. `tests/config/next.config.test.ts` pins the exact
values; `tests/e2e/marketing.spec.ts` proves a real response carries them.

**HSTS default.** This repository ships `Strict-Transport-Security: max-age=63072000`
(two years), with neither `includeSubDomains` nor `preload`. Both are opt-in, not
default, because they are hard to undo:

- `includeSubDomains` applies the HSTS policy to every subdomain of the domain that sends
  the header, including ones that do not exist yet or were never meant to run HTTPS. An
  apex domain sending this header with `includeSubDomains` commits its entire subdomain
  space to HTTPS-only, sight unseen.
- `preload` submits the domain to browsers' built-in HSTS preload list
  (https://hstspreload.org). Once accepted, removal is not a header change: it is a
  request to the list maintainers, and it can take months for the removal to reach
  already-shipped browsers.

**When and how to opt in.** Once every subdomain of your production domain is confirmed to
run HTTPS only (or does not exist), add `includeSubDomains` to the header value in
`next.config.ts`. Add `preload` only after that, once the site meets
https://hstspreload.org's submission requirements (HTTPS by default, `includeSubDomains`,
`max-age` of at least one year), and only if you accept the multi-month delay a future
reversal would need. Change the literal value in `next.config.ts`'s `headers()` and update
the pinned value in `tests/config/next.config.test.ts` alongside it.

**Camera permission.** `Permissions-Policy`'s `camera` directive is `camera=(self)`, not the
template's original `camera=()`: `src/modules/scanner` (P2c, the "Kamera" tab on
`/dashboard/scan`) is this repository's first feature that calls `getUserMedia`, and
`camera=()` unconditionally blocks that for every origin, including this app's own.
`camera=(self)` allows only this exact origin, never a third-party iframe, to request the
camera; every other `Permissions-Policy` directive is unchanged. A project that removes the
scanner module entirely could revert this to `camera=()` again. The same change also added
`'wasm-unsafe-eval'` to `Content-Security-Policy`'s `script-src` (required by scanic, the
library the scanner uses for edge detection, to instantiate its WebAssembly module under a
CSP Level 3-enforcing browser) - see `src/modules/scanner/README.md`'s "CSP changes and why"
for the full reasoning.

## Stripe and other platforms

(AGENTS.md: documentation stays English even where the product's own UI copy, quoted below in
its exact German wording, is German-only.)

Digipost recognizes a Stripe payout report or an Apple/Google/PayPal/Amazon settlement report
automatically the moment it is uploaded like any other document - no separate import, no extra
configuration (decisions/0026-platform-settlements.md, `src/modules/accounts`,
`src/modules/payments`).

**Put the invoice number into Stripe's payment metadata.** For an outgoing invoice to match
exactly the revenue line that paid it, put the invoice number into the Stripe payment's own
metadata or description (e.g. an `invoice_number` field in the `payment_intent` metadata, or
plainly in the description/statement descriptor). Without an invoice number, Digipost falls
back to a weaker customer-name + amount + date match, which an admin must confirm under
"Zuordnung" rather than it applying automatically.

**Exporting the Stripe payout reconciliation report.** In the Stripe Dashboard: Reports ->
Payout reconciliation report, exported as CSV for the desired period. Upload that file
directly like any other document - Digipost recognizes it by its own columns
(`balance_transaction_id`, `automatic_payout_id`, ...) as a payout report ("Auszahlungsbericht").

**Exporting the Apple financial report.** In App Store Connect: Payments and Financial
Reports -> download the financial report for the desired period (a tab-separated file). Also
upload it directly; Digipost recognizes it by its own columns (`Vendor Identifier`,
`Partner Share`, ...) as a platform settlement ("Plattformabrechnung").

**The first time a new report template is uploaded**, Digipost shows the recognized kind and
platform plus the column mapping for confirmation ("Bestätigung nötig") - the same flow every
other tabular import already uses. Once confirmed, the identical template is recognized
automatically on every later report, without asking again.

**The monthly platform fee invoice.** An incoming invoice from the platform itself (e.g.
Stripe's own monthly fee invoice) is marked settled automatically ("Erledigt", never "Offen")
once the sum of that period's fee lines (the month of the invoice's own document date) matches
the invoice amount within 3% - no bank payment needed, since the platform already netted the
fee out of the payout. Digipost recognizes the platform from the invoice sender contact's own
name (e.g. "Stripe" appearing in the company name); an unusually named sender is not recognized
automatically.

**The payout itself** shows up as a booking on the bank account and is automatically linked to
the matching booking on the platform's own clearing account (by payout id in the remittance
text, otherwise by amount and date) - regardless of whether the payout report or the bank
statement is imported first. When no payout report exists yet, "Zuordnung" shows a hint about
the missing platform report instead of "kein Vorschlag" (no suggestion).

## Before going to production

Digipost has never taken real customer traffic yet: `BILLING_TEST_MODE=true` and the
Mistral fake-adapter fallback are both currently load-bearing, and the legal pages are
explicit drafts. This is what still needs to happen, in no particular order except where
noted, before that changes.

1. **Real secrets, in Infisical, never in a local file.** Generate `BETTER_AUTH_SECRET` and `CRON_SECRET`
   (`openssl rand -base64 32`, at least 32 characters each) and get a real SMTP endpoint (`SMTP_URL`,
   `MAIL_FROM`, with SPF, DKIM and DMARC on the sending domain) from a mail provider. The runtime variables live
   in Infisical `prod:/app` and reach Vercel Production by Secret Sync; the pipeline's own credentials live in
   `prod:/ci` (`scripts/deploy/README.md`, sections 2 and 4). Never create a local `.env.production*` file
   (Next.js would load it for every local `next build`/`next start`, pointing a local build at production - see
   "Environment variables" above).
2. **DB roles on Neon.** `pnpm db:bootstrap` (`scripts/db/bootstrap-roles.mjs`) creates
   `app_runtime`/`app_public` idempotently, already done for local (`docker/compose.yml`) and the test stack.
   Production needs the same run once against the Neon project (EU region), before the first migration, with the
   owner role's **direct** URL as `DATABASE_URL_MIGRATE` and the **pooled** URLs for the other two, per
   `decisions/0004-three-database-roles.md` and `scripts/deploy/README.md`, section 6. The pipeline's `migrate`
   job then applies every pending migration on each release.
3. **Cloudflare R2 instead of MinIO.** `src/platform/object-storage` already targets any S3-compatible provider
   through `S3_*` environment variables only (decisions/0012-object-storage.md); production needs an R2 bucket in
   the EU jurisdiction and a token scoped to it (`S3_ENDPOINT=https://<account-id>.eu.r2.cloudflarestorage.com`,
   `S3_REGION=auto`, real `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE=false`), no code
   change.
4. **A real Mistral key, and a DPA before real documents flow through it.** Set a real
   `MISTRAL_API_KEY` (`AI_PROVIDER` can then stay unset; production ignores the `fake`
   fallback by design - `src/platform/mistral/README.md`). Mistral is an EU-based
   sub-processor: sending a customer's scanned mail's full text and content to it needs a
   signed Auftragsverarbeitungsvertrag (DPA) and an updated privacy policy *before* any
   real (non-fake-provider) production traffic exists -
   `decisions/0016-processing-pipeline-and-ai.md`'s "Data protection note" and
   "Consequences" record this explicitly as an unfinished follow-up, not an oversight.
5. **Stripe is still missing.** `src/modules/billing`'s `PaymentProvider` port has only a
   test-mode adapter; tier changes and package purchases work today solely because
   `BILLING_TEST_MODE=true` in local/test environments. `BILLING_TEST_MODE` must stay
   `false` in production until a real Stripe adapter implementing that port exists -
   `decisions/0017-billing-tiers-and-packages.md`'s "What a future Stripe adapter needs to
   implement".
6. **Legal pages need a lawyer.** `/legal-notice` and `/privacy` render real German
   headings and structure but every fact (company name, address, register entry, VAT ID,
   supervisory authority, the privacy policy's own body) is an explicit TODO placeholder,
   visually marked as a draft (`LegalDraftBanner`) - see `src/i18n/messages/de.json`'s
   `Legal.draftBanner` copy. Replace every placeholder with real, lawyer-reviewed text
   before launch, and remove the draft banner once that review is done.
7. **Sentry.** `@sentry/nextjs` is installed but unconfigured (fully inert without
   `SENTRY_DSN`). On the first real deploy, run the Sentry setup wizard
   (`npx @sentry/wizard@latest -i nextjs`) or set `SENTRY_DSN` (and, for source map
   upload, `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT`) by hand in the hosting
   provider's environment variables; see `src/platform/observability/README.md`'s "When you
   first deploy a project built from this template".
8. **Cron on Vercel Pro.** `vercel.json` has two cron entries: `GET /api/cron/process-jobs` every two hours
   (`"0 */2 * * *"`) and `GET /api/cron/purge-rejected-intake` daily (`"0 3 * * *"`,
   decisions/0027-hardening-and-deletion.md's retention cron). Vercel sends `Authorization: Bearer $CRON_SECRET`
   when the project has a `CRON_SECRET` variable, which `requireCronSecret` checks. Document processing starts
   right after an upload (`after()`) and while a user watches (the workspace-scoped UI "kick"); the sweep is only
   a safety net for a job both missed (`decisions/0016-processing-pipeline-and-ai.md`). Cron jobs need the Pro
   plan for anything more frequent than daily.
9. **The deploy pipeline.** `.github/workflows/deploy-production.yml` deploys on every push to `main`
   (`vercel.json` ships `"git": { "deploymentEnabled": false }`, so Vercel's own Git integration never
   deploys). It needs the GitHub environment `production` (restricted to `main`) with its four Infisical secrets,
   the Infisical project with the machine identity, the Vercel project with Deployment Protection and a bypass
   secret, and the Neon and R2 resources above. `scripts/deploy/README.md` lists every step, in order, with the
   first deployment, rollback and secret rotation.
10. **`ci-passed` as a required check.** The repository is public, so branch protection is available:
    require the status check `ci-passed` on `main` and `development`, and set the Actions option "Require
    approval for all outside collaborators" (`scripts/deploy/README.md`, section 3). Deployment does not wait
    for CI, so it relies on this.
11. **Backups are a documented requirement, not yet automated.** Set Neon's point-in-time-restore retention to
    the longest window the plan offers, add a scheduled logical dump to storage under a different account, and
    test a restore; decide the same for the R2 bucket (`scripts/deploy/README.md`, section 6). A business keeps
    its incoming mail here, so this blocks real customers.
12. **Verify everything, once, before calling any of the above done.**
    `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm test:docker &&
    pnpm test:e2e:docker` - "CI" above lists what each command corresponds to. CI runs the same suites on every
    pull request.
## Documentation map

`AGENTS.md` (agent rules) → `STRUCTURE.md` → the nearest owner
`README.md` → `decisions/` (start at `decisions/README.md`) for anything touching a
documented decision. `scripts/deploy/README.md` covers the CI and deploy pipeline, the one-time setup of every
provider, rollback, secret rotation and the expand/contract rule for migrations. `DOC_RULES.md` defines how all of this documentation
is governed.
`WEBAPP_TEMPLATE_SPEC.md` is the full architecture reference this template implements.
