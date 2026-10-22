# AGENTS.md

Document type: reference
Lifecycle: active
Owner: template maintainer
Scope: Repository-wide agent safety, governance, workflow, and discovery
Canonical responsibility: Rules that apply to agents across every part of this repository
Maintenance triggers:
- Repository-wide safety or workflow rules change
- STRUCTURE.md or the structure checker lands and changes what is machine-enforced
- Documentation governance rules in DOC_RULES.md change
Last verified: 2026-10-22, decisions/0075-email-intake.md: added the `src/modules/mail-intake`
+ `src/platform/inbound-mail` owners, the webhook's workspace-scoping exception, and Resend to
the "Mistral and personal data" rule. Previously 2026-09-20, F5 (hardening): refreshed the owners list (added
`src/modules/{intake,contacts,accounts,payments}`, all missing since their own phases
landed) and the domain rules (finance admin-only, intake confirmation vs. correction,
workspace-deletion cascade, the one auto-deletion exception, the `requireWorkspaceAdmin`
reference that never existed) against STRUCTURE.md, decisions/0011, decisions/0014
through decisions/0027, and package.json

## Agent Role

Senior pragmatic engineer. Priorities: correctness, clarity, maintainability, security.
Expertise: modern web (TypeScript/React/Next.js), server-first patterns, Postgres,
multi-tenant SaaS authorization, and integrating a third-party OCR/LLM provider safely.

## What This Repository Is

Digipost, a "digitaler Posteingang" SaaS for small and medium German businesses
(Germany/DACH, UI German-only, decisions/0013-german-ui-language.md): a team scans or
uploads its incoming paper mail, Digipost OCRs it (Mistral OCR), recognizes what kind of
document it is and extracts key fields with a small LLM (Mistral Small), matches it against
the bank account's own transactions, and makes it searchable. It deliberately does NOT route
or assign a document to a person, and has no document category beyond the document kind
itself (decisions/0063-no-category-no-assignment-no-routing.md): both existed and were
removed once real usage showed the category held one constant value and no routing rule was
ever created. See `README.md`'s "Purpose" for the full product description and
the vertical slices that exist today.

This repository started from a generic Next.js starter template
(`WEBAPP_TEMPLATE_SPEC.md`, still the architecture reference for the scaffolding
underneath the product: tooling, docs conventions, the owner-model layout, persistence,
auth, the Docker test stack, CI) and is now a real product built on top of it, not a
template someone else will rename and restart from. Read `WEBAPP_TEMPLATE_SPEC.md` before
building anything not yet covered by this file or by an owner `README.md`; where the two
disagree, prefer whichever one is more current for the area you are touching (this file
and the owner `README.md`s win for anything Digipost has actually built), and say so in
your report if they conflict.

**Owners, and what they're responsible for** (each has its own `README.md` with the full
detail; `decisions/README.md` indexes the ADR behind each one):

- `src/modules/workspaces` + `src/platform/access` - tenancy (workspace, membership,
  invitations, admin-only workspace deletion and non-admin member self-removal) and
  authorization (permission bundles, not role-string checks),
  decisions/0014-workspaces-and-access.md, decisions/0027-hardening-and-deletion.md. A user
  may belong to SEVERAL workspaces (decisions/0070-several-workspaces-per-user.md): the active
  one is resolved in exactly one place, `resolveAccess`, where the active-workspace cookie only
  selects among the memberships that request read from the database. Never add a second place
  that decides the active workspace, and never trust that cookie for anything else.
- `src/modules/documents` - upload, storage, inbox (generated row names,
  decisions/0059-generated-document-names.md), detail view, quota enforcement, the universal intake recognizer's document-facing half (confirmation
  UI, deterministic camt.053/ZUGFeRD branches), the `purge-rejected-intake` retention cron,
  decisions/0015-documents-and-quotas.md, decisions/0020-universal-intake.md,
  decisions/0022-intake-wiring.md, decisions/0027-hardening-and-deletion.md,
  decisions/0063-no-category-no-assignment-no-routing.md.
- `src/modules/intake` - the universal intake recognizer's pure domain layer (taxonomy,
  tabular sampling/column-mapping validation, camt.053/ZUGFeRD parsing, idempotency keys),
  no persistence or UI of its own, decisions/0020-universal-intake.md.
- `src/modules/scanner` - the client-only camera capture UI feeding
  `src/modules/documents`' upload path; no server-side code of its own.
- `src/platform/jobs` + `src/platform/mistral` - the async processing pipeline (job queue,
  OCR/classification, searchable PDF),
  decisions/0016-processing-pipeline-and-ai.md.
- `src/modules/billing` - tiers, one-off packages, the quota-warning email, the
  `PaymentProvider` port and its test-mode adapter, decisions/0017-billing-tiers-and-packages.md.
- `src/modules/contacts` - the workspace's own "Firmenkontakte" (matching, verification
  semantics, the no-silent-overwrite fraud rule), decisions/0019-contacts.md. Merge/delete
  stay member-level (`documents.write`) by explicit product decision,
  decisions/0027-hardening-and-deletion.md.
- `src/modules/accounts` - bank/clearing accounts, idempotent transaction import,
  the pending-account flow, platform settlement clearing accounts, admin-only end to end
  (`finance.read`/`finance.manage`, no member-level counterpart at all - a bank statement
  exposes salaries), decisions/0024-accounts-and-transactions.md,
  decisions/0026-platform-settlements.md.
- `src/modules/payments` - payment matching (deterministic rules, arithmetic, an AI
  arbiter), platform settlement/fee-invoice matching, same admin-only
  `finance.read`/`finance.manage` bundle as `src/modules/accounts` for anything beyond a
  document's own payment status (which every member sees), decisions/0023-payment-matching.md,
  decisions/0025-payment-matching-wiring.md.
- `src/platform/object-storage` - the only holder of `S3_*` credentials,
  decisions/0012-object-storage.md.
- `src/modules/mail-intake` + `src/platform/inbound-mail` - the E-Mail-Eingang: a secret
  `post-<token>@<INBOUND_EMAIL_DOMAIN>` address per workspace, Resend's `email.received`
  webhook (`POST /api/webhooks/resend`), the sender policy and its authentication check, and
  every attachment turned into a document through `createFromUpload`;
  `src/platform/inbound-mail` is the only holder of `RESEND_API_KEY`/`RESEND_WEBHOOK_SECRET`,
  decisions/0075-email-intake.md.
- `src/modules/dashboard-shell`, `src/modules/sign-in`, `src/platform/auth`,
  `src/platform/mailer`, `src/platform/api-pipeline`, `src/platform/observability`,
  `src/platform/env`, `src/persistence`, `src/shared/ui-primitives`, `src/i18n` - the
  template foundation the product above is built on; still exactly what
  `WEBAPP_TEMPLATE_SPEC.md` describes, each with its own `README.md`.

## Domain Rules

Digipost-specific invariants a change must not silently break:

- **Workspace scoping.** Every document (and every other workspace-owned row) query is
  scoped by `workspace_id` taken from the caller's resolved session membership
  (`requireWorkspaceMember` for a page/layout, `requirePermission`/`getWorkspaceAccess` for a
  Server Action, `src/platform/access`), never from client input (a route param, a hidden
  form field, a query string). There is no `requireWorkspaceAdmin` helper - an admin-only
  page checks `access.permissions.includes(PERMISSIONS.xxx)` then calls `notFound()`, the
  same pattern `/dashboard/settings/intake` and every
  `/dashboard/finance/**` page use (decisions/0027-hardening-and-deletion.md documents why
  this returns an HTTP 200 status for that case rather than a 404, a known, accepted Next.js
  streaming limitation, not a data-exposure bug). A missing or cross-workspace scope check
  on a new query or action is a security bug, not a style issue. The retention cron
  (`GET /api/cron/purge-rejected-intake`) is a deliberate, narrow exception: it queries
  across every workspace by design, the same way the job queue's own cron sweep already
  does, since it is unattended background maintenance work with no caller session to scope
  to at all. `POST /api/webhooks/resend` is the second such exception
  (decisions/0075-email-intake.md): a signature-verified webhook with no session, where the
  secret token in the recipient address is what selects the workspace. Resend forwards EVERY
  mail the whole account receives there, so a recipient counts only when it is exactly
  `post-<token>@<INBOUND_EMAIL_DOMAIN>` with an existing, enabled token; anything else is
  answered 200 and never stored (no row, no job, no download, no PII in logs). Never loosen
  that match.
- **Quota semantics.** The total-document limit counts documents currently stored
  (deleting one frees capacity); the monthly limit counts documents created in the
  current calendar month UTC (deleting does not refund it); a one-off package raises the
  effective monthly limit for its purchase month only, never the total limit. The quota
  check runs twice: an early pre-check for a fast rejection, and an authoritative
  in-transaction re-check immediately before the row is written
  (decisions/0015-documents-and-quotas.md). Changing either limit's meaning without
  updating both checks and the ADR is a product-breaking change, not a small tweak.
- **Finance is admin-only, end to end.** `finance.read`/`finance.manage`
  (`src/platform/access`) are the only bundles in this codebase with no member-level
  counterpart at all - a bank statement exposes salaries and other private debits.
  `src/modules/accounts` and `src/modules/payments` gate every mutation behind
  `finance.manage` and every read (`/dashboard/finance/**`) behind `finance.read`; the one
  exception is a document's own payment status (offen/überfällig/bezahlt) and paid-on date,
  which every member sees on `/dashboard/documents/[id]` - an amount, counterparty, or
  suggestion is finance information and stays redacted for a member even there
  (decisions/0024-accounts-and-transactions.md, decisions/0025-payment-matching-wiring.md).
- **Intake confirmation is member-level, its correction is admin-only.** Confirming or
  rejecting a new tabular-import proposal ("Bestätigung nötig") is ordinary document work,
  gated behind `documents.write` like any other document action every member already does.
  Only *correcting* an already-confirmed source's mapping ("Zuordnung zurücksetzen",
  `/dashboard/settings/intake`) needs `intake.manage` (admin-only) - a workspace-wide policy
  change, not a one-document decision (decisions/0020-universal-intake.md,
  decisions/0022-intake-wiring.md).
- **Only the owning module writes its own tables** (see "Database Rules" below) applies
  as much to `documents` (owner: `src/modules/documents`),
  `workspaces`/`workspace_members`/`workspace_invitations` (owner:
  `src/modules/workspaces`), the billing usage tables (owner: `src/modules/billing`),
  `contacts`/`document_contacts`/`contact_change_proposals` (owner: `src/modules/contacts`),
  `accounts`/`transactions`/`import_batches`/`settlement_lines` (owner:
  `src/modules/accounts`), and `document_transactions`/`payment_aliases`/
  `payment_rejections`/`payment_no_document_rules`/`payment_arbiter_answers` (owner: `src/modules/payments`) as to any
  other table.
- **Nothing is auto-deleted except one thing.** A rejected intake proposal ("Ablehnen" -
  nothing was ever imported from it) older than 30 days is the ONLY row this product ever
  deletes without a human acting on it directly (`GET /api/cron/purge-rejected-intake`,
  decisions/0027-hardening-and-deletion.md). Every confirmed document, contact, account,
  transaction, and proposal is retained until a human deletes it (or deletes the whole
  workspace) - a new automatic-deletion path for anything else is a product decision, not a
  small addition, and needs its own ADR the way this one needed decisions/0027.
- **Workspace deletion is a single cascading `DELETE`, not a per-table sequence.** Every
  workspace-owned table's foreign key to `workspaces.id` is `onDelete: "cascade"`
  (`WorkspaceRepository.delete`, decisions/0027-hardening-and-deletion.md's "Cascade
  verification" section lists every one of them). A new workspace-owned table MUST cascade
  from `workspaces.id` the same way, or workspace deletion silently leaves its rows behind -
  verify this explicitly (and extend that ADR's table list) whenever a new such table lands,
  and never add a nullable `workspace_id` with no foreign key at all unless it is
  deliberately a "global, not workspace-owned" marker.
- **German UI, English everything else.** UI copy is German (`src/i18n/messages/de.json`,
  single locale, formal "Sie" register, decisions/0013-german-ui-language.md); code,
  identifiers, comments, commit messages, and documentation stay English regardless (see
  "Code" below).
- **No `.env*` file other than `.env.example`** (see "Database Rules" and "Security"
  below) - this applies with no exception to Mistral credentials too:
  `MISTRAL_API_KEY` only ever lives in a real environment's secret store or a
  developer's own untracked `.env.local`, never read, opened, or created by an agent.
- **Mistral and personal data.** `src/platform/mistral` sends a document's full OCR text
  (potentially including personal data: names, addresses, account numbers, anything a
  piece of incoming mail might contain) to Mistral's API for categorization. Mistral is an
  EU-based sub-processor, but no Auftragsverarbeitungsvertrag (DPA) exists yet and the
  privacy policy is still a placeholder - real (non-fake-provider) production traffic
  through this pipeline is explicitly blocked on that paperwork landing first
  (decisions/0016-processing-pipeline-and-ai.md's "Data protection note", README.md's
  "Before going to production"). Do not treat "the fake adapter works in tests" as
  evidence the real integration is compliance-ready. The same applies to Resend as the
  receiver of the E-Mail-Eingang (`src/platform/inbound-mail`, decisions/0075-email-intake.md):
  incoming mail (sender, subject, body, attachments) passes through and is stored by Resend,
  no DPA with Resend exists yet and its data residency is unclear, so real customer mail
  through that path is blocked on the same paperwork. `RESEND_API_KEY`/`RESEND_WEBHOOK_SECRET`
  fall under the same "never read, opened, or created by an agent" rule as `MISTRAL_API_KEY`.

## Workflow

1. Read `README.md`, then this file, then `STRUCTURE.md`, then the nearest owner
   `README.md`.
2. Get current documentation for any library or Next.js API before using it: context7,
   or `node_modules/next/dist/docs/` for Next.js itself (Next 16 has breaking changes
   versus older training data, see "Next.js notes" below).
3. Review the affected code before proposing changes; reference files directly, not by
   memory of what this file or a README says they should contain.
4. Check architecture impact; for non-trivial work, propose a brief plan and get it
   confirmed before implementing.
5. Implement. Update the nearest owner documentation and tests for what changed.
6. Before reporting "done": run `pnpm verify` (typecheck, lint, structure check, unit
   tests) at minimum; run `pnpm test:db`/`pnpm test:int`/`pnpm test:docker`
   when the change touches schema, database access, route handlers, or webhooks; run the
   affected `pnpm test:e2e <spec>` when the change touches a UI flow. Report which of
   these ran and which did not, and why.
7. Summarize what changed and which checks ran (or did not) in the final response.

## Tests and CI

- There are no git hooks (see "Parallel-agent git rules" below and
  `decisions/0002-no-git-hooks.md`); CI is the only gate. Never weaken, skip, or disable
  a test to make CI green; never raise retries to hide flakiness.
- `pnpm verify` before every PR is a rule enforced by CI, never by a local hook: `ci-passed`
  is the single required status check on `main` and `development`
  (`decisions/0073-public-repo-and-production-pipeline.md`). Treat it going red as a block.
- CI runs on GitHub-hosted runners only, including the database, integration and end-to-end
  suites (`decisions/0073-public-repo-and-production-pipeline.md`; the self-hosted runner and
  the `CI_*` variables of the older decisions/0029 are gone). Running `pnpm test:docker` and
  `pnpm test:e2e:docker` locally before a pull request (workflow step 6 above) is still the
  reference run and the faster way to find a failure. Report honestly which checks you ran.
- `.github/workflows/ci.yml` (README.md "CI"): `check`, `db`, `e2e`, `actionlint` and the
  `ci-passed` aggregate; a path filter skips the heavy jobs for documentation-only pull
  requests, pull requests into `development` run only the `@smoke` end-to-end set, and
  everything else runs everything. Every job that needs a database runs against throwaway
  service containers, never a hosted one, and no job uses a secret. Deployment is
  `.github/workflows/deploy-production.yml` on a push to `main` (`scripts/deploy/README.md`).
- Flaky tests: report them, do not silently retry past them or delete them.

## Parallel-Agent Git Rules

Multiple agents may work in this repository concurrently, often in the same working
directory or in sibling worktrees.

- Touch only the files you were assigned. If a change to a file outside your assignment
  turns out to be necessary, say so in your final report instead of making it.
- Never run `git stash` (bare), `git reset`, `git checkout <ref> -- …`, `git restore`, or
  `git clean`. These move or delete another agent's unsaved work. If you must set work
  aside, use a WIP commit, or, if you must use the stash,
  `git stash push -u -m "<unique-tag>"` and restore with `git stash apply <sha>` (never
  bare `pop`), immediately re-finding your entry by tag.
- Do not commit unless the orchestrator/user explicitly asked you to create a commit for
  this task.
- No concurrent writes to `pnpm-lock.yaml`: add a new dependency only when the task
  explicitly calls for it.
- Do not start a `next build` or a second `next dev` while another may be running in this
  working tree; `next dev` writes a lockfile under `.next/dev` specifically to prevent
  concurrent instances, but parallel `next build`s are not similarly guarded.

## Database Rules

- Never read, open, edit, or create an `.env*` file other than `.env.example`.
- Never run a migration, seed, or DDL statement against anything other than the local
  Docker stack (`docker/compose.yml`) or the hermetic test stack (`docker/compose.test.yml`) without
  explicit approval in the chat for that specific action. Any shared, staging, or
  production database is off-limits by default, every time, regardless of how small or
  "obviously correct" the change looks.
- Migrations are generated by drizzle-kit from `src/persistence/schema/`, never hand-written
  or AI-generated. Change the schema, then run `pnpm db:generate`.
- Only a table's owning module writes to it (inserts/updates/deletes). Other code reads
  via a join or via that owner's own use case/read model. This is a review rule, not
  something enforced by tooling.
- `pnpm db:seed` refuses to run against anything but a local/dev target; do not try to
  work around that refusal.

## Structure

`WEBAPP_TEMPLATE_SPEC.md` §3 defines the target repository layout; §4 defines its
dependency rules. The hard stops, to keep in mind for new code even before a structure
checker exists:

- Application code lives under `src/`, cross-cutting test suites under `tests/`
  (`tests/e2e/`, `tests/integration/`, `tests/config/`); owner-level tests stay in the
  owner's own `tests/` directory. No top-level `docs/` folder; no generic `lib/`,
  `components/`, `server/`, or `utils/` folder at the repository root, under `src/`, or
  under `tests/` (`STRUCTURE.md` §1).
- Prefer `src/modules/<capability>/`, `src/shared/<purpose>/` (only with 2+ real consumers),
  `src/platform/<concern>/`, or `src/persistence/` for new capability code.
- Similar names, apparent duplication, or an apparently unused file are never
  justification by themselves for deleting, moving, or consolidating something.
  Rediscover every actual consumer (grep the import, not the filename) before touching
  placement; when something looks wrong, report it rather than act on the appearance.
- Preserve observable behavior and external contracts across any refactor; a structural
  change that would require a semantic change stops for explicit approval first.

## Security

- Mandatory review for anything touching auth, authorization, user input, webhooks,
  payments, or privileged database/provider code.
- No secrets in code. `.env*` files other than `.env.example` are off-limits (see
  "Database Rules").

## Code

- TypeScript strict; no `any` without a comment explaining why it is necessary.
- Early returns over nested conditionals.
- Stable error codes (`as const` sets), never raw text, for anything a caller branches
  on; the UI translates codes to copy, not the reverse.
- English identifiers, comments, commit messages, and documentation everywhere in code
  and docs. UI copy is German (served through next-intl, single locale `de`, formal
  "Sie" register, `decisions/0013-german-ui-language.md`); everything else (code,
  identifiers, comments, docs, commit messages, stable error codes) stays English.
- No em dash character ("—") in documentation or product copy; an en dash ("–") is also
  avoided in both. Use a comma, a colon, parentheses, or a plain hyphen instead.

## Next.js Notes (Next 16.3.5)

- `src/proxy.ts`, not `middleware.ts` (removed). `export function proxy(req)`, always runs in
  Node.js; `export const runtime` in `src/proxy.ts` throws. `matcher` values must be static
  constants; a `has`/`missing` clause referencing an env value is not guaranteed to be
  statically evaluated, so a runtime guard in code is mandatory wherever that matters.
- Rewrite/route order: `headers` -> `redirects` -> Proxy -> `beforeFiles` rewrites ->
  filesystem -> `afterFiles` -> dynamic routes -> `fallback`. The proxy's matcher sees the
  original path, before any `beforeFiles` rewrite. `beforeFiles` rewrites chain against
  the already-rewritten path with no filesystem check in between.
- `has`/`missing` with `type: 'host'` compares a regex as `^value$` against the lowercase,
  port-stripped `Host` header; escape dots. Rewrites are evaluated at build time from the
  routes manifest, so any env value they depend on must be set at build time; changing it
  needs a rebuild.
- Async request APIs (`cookies()`, `headers()`, `draftMode()`, `params`, `searchParams`)
  are async-only; `cookies().set()` only works in Server Functions/Route Handlers, never
  while rendering a Server Component.
- `next typegen` (part of `pnpm typecheck`) generates `PageProps<'/path'>`,
  `LayoutProps<'/'>`, `RouteContext<'/api/…'>`.
- Turbopack is the default for `dev` and `build`. `next lint` is gone; `pnpm lint` is
  ESLint's own Flat Config.
- `next dev` writes to `.next/dev` and guards against a second concurrent `next dev` or
  `next build` in the same project with a lock file; do not start builds concurrently
  across agents in this working tree regardless (see "Parallel-Agent Git Rules").
- The block below this file's own content is managed by `next dev` itself (it re-adds the
  block if missing); do not remove it, and commit it if it appears in your diff.

## Discovery

`README.md` first, then this file, then `STRUCTURE.md`, then the nearest owner
`README.md`, then `decisions/` (start at `decisions/README.md`'s status table) for
anything touching a specific documented decision.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
