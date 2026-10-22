# STRUCTURE.md

Document type: reference
Lifecycle: active
Owner: template maintainer
Scope: This repository's structure policy (the target layout from
`WEBAPP_TEMPLATE_SPEC.md` §3/§4, adapted to this repository's actual roots and real
code) and the machine-readable ```structure blocks that `pnpm verify:structure`
(`scripts/structure/**`) interprets
Canonical responsibility: Active source for which top-level roots, owner
entrypoints, import directions, persistence layering, test placement, doc metadata,
env-variable confinement, and vendor-SDK confinement are allowed in this repository
Maintenance triggers:
- A root, owner category, entrypoint convention, or dependency direction changes
- A new vendor SDK or a new sensitive env var is introduced
- `scripts/structure/**` gains or loses a rule (keep the rule table and the
  ```structure block names in 1:1 correspondence, enforced by the checker itself)
Last verified: 2026-10-22, decisions/0075-email-intake.md added two owners under the
existing container rules, `src/modules/mail-intake` (the E-Mail-Eingang's domain, UI and
admin notification e-mail) and `src/platform/inbound-mail` (the Resend port and webhook
verification), plus the `env-access` rows for `RESEND_API_KEY`/`RESEND_WEBHOOK_SECRET`, the
`vendor-sdk` row confining `svix` to `src/platform/inbound-mail/`, and
`src/modules/mail-intake/server/emails/` on the `@react-email/` row. Previously, 2026-10-02, decisions/0066-abschluss-check-and-export.md added
`src/modules/closing` as a new owner under the existing `src/modules/<capability>/`
container rule - a capability slice with no table, no new root, no new sensitive env var,
and no new confinement row (its two new packages, `exceljs` and `archiver`, are
general-purpose file-format libraries, §11). Previously, F2 (accounts and transactions,
decisions/0024-accounts-and-transactions.md)
added `src/modules/accounts` as a new owner under the existing `src/modules/<capability>/`
container rule - a full vertical slice (schema/repositories/use-case/actions/UI) needing no new
`structure` block of its own (no new vendor SDK, sensitive env var, or root). Previously, F1a
(universal intake recognizer) added the `vendor-sdk` rows for
`fast-xml-parser`/`csv-parse`, both confined to `src/modules/intake/`
(decisions/0020-universal-intake.md). P3 (billing): extended the `vendor-sdk` `@react-email/` row for
`src/modules/billing/server/emails/` (decisions/0017-billing-tiers-and-packages.md). P2b
(processing pipeline) added the `env-access` row for `MISTRAL_API_KEY`
(`src/platform/mistral/`, `src/platform/env/`) and extended the `vendor-sdk`
`@react-email/` row for `src/modules/documents/server/emails/`
(decisions/0016-processing-pipeline-and-ai.md). P1 (tenancy) removed the `projects` example
module (`src/modules/workspaces`, `src/platform/access` took its place) and extended
`vendor-sdk`'s `@react-email/` row for `src/modules/workspaces/server/emails/`
(decisions/0014-workspaces-and-access.md), against the repository tree after the
`src/`/`tests/` move (`decisions/0011-src-and-tests-roots.md`), `WEBAPP_TEMPLATE_SPEC.md`
§2.7/§3/§4/§11.5/§12/§17 step 5, `AGENTS.md`, `DOC_RULES.md`

## 0. How this document works

This file is prose *and* data. Every fenced block tagged ```` ```structure <name> ````
is parsed by `scripts/structure/lib/doc-parser.ts` and consumed by exactly one rule
module under `scripts/structure/rules/*.ts`. `pnpm verify:structure`
(`scripts/structure/verify-structure.ts`) enforces a hard 1:1 correspondence between
the block names that appear here and the rules implemented in code: a block with no
implementing rule, or a rule with no block here, is itself a checker error. The
"Exceptions" block (§13) is the one deliberate exception to that correspondence - it
is data every rule consults, not a rule of its own, and it holds only the checker's
own fixture data (§13).

This is **not** a byte-for-byte copy of `WEBAPP_TEMPLATE_SPEC.md`'s worked examples;
it describes this repository's own real roots and conventions, verified against the
actual tree, not an aspirational restatement of the spec. Where this repository has
not diverged from the spec's vanilla layout, the vanilla rule applies unchanged.

`scripts/structure/**` has no pre-existing import-graph guard-test library to build
on (unlike a project that already had one, `WEBAPP_TEMPLATE_SPEC.md` §2.7/§11.5's
offered alternative), so its own resolver lives at
`scripts/structure/lib/module-graph.ts` and every rule that needs import resolution
imports it directly - see `decisions/0010-structure-checker-self-contained-resolver.md`.

## 1. Roots

```structure roots
src/
src/app/
src/modules/
src/shared/
src/platform/
src/persistence/
src/i18n/
src/proxy.ts
src/instrumentation.ts
src/instrumentation-client.ts
src/sentry.server.config.ts
src/sentry.edge.config.ts
tests/
tests/e2e/
tests/integration/
tests/config/
scripts/
docker/
decisions/
public/
.github/
AGENTS.md
CLAUDE.md
README.md
LICENSE
STRUCTURE.md
WEBAPP_TEMPLATE_SPEC.md
DOC_RULES.md
package.json
pnpm-lock.yaml
pnpm-workspace.yaml
tsconfig.json
next.config.ts
next-env.d.ts
eslint.config.mjs
postcss.config.mjs
components.json
drizzle.config.ts
vitest.config.ts
playwright.config.ts
vercel.json
.env.example
.gitignore
.dockerignore
.nvmrc
```

The repository root holds three kinds of things only: application code under `src/`,
cross-cutting test suites under `tests/`, and everything that tooling expects at the
root (configuration, `public/`, the governance documents). `docker/` holds the
Dockerfiles and both compose files, `scripts/` the repository's own tooling
(`decisions/0011-src-and-tests-roots.md`).

A declared entry with a `/` before its end (`src/app/`, `tests/e2e/`) makes its parent a
*governed* root: every direct child of `src/` and of `tests/` must be declared here as
well, exactly like a top-level entry. Nothing else may exist directly under the
repository root, under `src/`, or under `tests/`: no `components/`, no bare `lib/`,
`utils/`, `services/`, or `server/` at any of those three levels
(`WEBAPP_TEMPLATE_SPEC.md` §3's closing line). `tests/` is not a generic test dump
either: owner-level unit and DB tests stay beside their owner (§8), `tests/` only holds
suites that cross owners (`tests/e2e/`, `tests/integration/`) and unit tests for the
repository-root configuration files (`tests/config/`). `docs/` in particular must never be
created (`DOC_RULES.md` §1) and is checked twice over, once here and once by the
`documentation` rule (§9), so the two can never quietly disagree about whether it
exists.

The `roots` rule (`scripts/structure/rules/roots.ts`) scans what `git ls-files`
tracks at the repository root, not a raw filesystem listing: the latter also picks
up gitignored build/test artifacts (`.next/`, `test-results/`, `playwright-report/`,
a locally regenerated `tsconfig.tsbuildinfo`, a stray local `docs/`) and anything
merely uncommitted in a developer's working copy, none of which a fresh CI checkout,
what this rule is meant to police, would ever contain.

## 2. Owner categories and owner-internal structure

`src/modules/<capability>/`, `src/shared/<purpose>/`, `src/platform/<concern>/` are owner
containers; each immediate child directory is one owner. `src/persistence/` is a single
owner with internal layers (§4) rather than a container of many.
`WEBAPP_TEMPLATE_SPEC.md` §4.1's admission rules apply: a `src/shared/` owner needs 2+
real, named consumers (counted in its own README); a `src/platform/` owner is
application-wide infrastructure, not a renamed `lib/`; a `src/modules/` owner is a full
vertical capability slice, not one module per table and not an actor mega-module.

```structure owner-internals
allow core
allow ui
allow server
allow tests
forbid utils
forbid services
forbid data
forbid misc
forbid helpers
forbid common
forbid lib
forbid components
```

Every directory at any depth inside `src/modules/<owner>/`, `src/shared/<owner>/` or
`src/platform/<owner>/` whose name appears on a `forbid` line is a violation, regardless
of depth. Names on an `allow` line are always permitted at any depth. A directory
name on neither line (a precise name like `emails/`, `support/` -
`WEBAPP_TEMPLATE_SPEC.md` §4.2 explicitly encourages these) is allowed; only the
generic dumping-ground names above are actually forbidden. Empty directories are
forbidden everywhere under these three roots.

## 3. Public entrypoints

```structure entrypoints
index.ts neutral
client.ts use-client
server.ts server-only
actions.ts use-server
*-actions.ts use-server
```

- `neutral` (`index.ts`): must not start with `"use client"` or `"use server"`, and
  must not import `server-only` itself. This is a narrower, local check than the
  repository-wide client/privileged separation the `direction` rule's
  `client-reachable-reaches-privileged` invariant enforces (§5).
- `use-client` (`client.ts`): first non-comment, non-blank line is exactly
  `"use client";` or `'use client';`.
- `server-only` (`server.ts`): contains a top-level `import "server-only";`, **or**
  the literal substring `server-only` appears anywhere in the file (a documented,
  deliberate omission). This is a weak check on purpose (§14): it cannot tell a
  genuine, considered omission from an accidental one that happens to mention the
  word, but it does catch the case that matters mechanically - a `server.ts` that
  never considered the guard at all.
- `use-server` (`actions.ts`, `*-actions.ts`): first non-comment, non-blank line is
  exactly `"use server";` or `'use server';`, and the file exports only async
  functions and types (checked syntactically: `export type`, `export interface`,
  `export async function`, `export function`, or a re-export via `export { ... }` -
  see "Enforcement Limits" §14 for why a plain `export function`'s actual
  async-ness is not verified here).
- No entrypoint file may be empty (whitespace-only counts as empty; "exports
  nothing yet" does not).
- An owner file at the owner's root that is not one of the names above (e.g.
  `src/platform/auth/proxy-gate.ts`) is allowed only if the owner's own `README.md`
  names that file (`WEBAPP_TEMPLATE_SPEC.md` §4.2). The checker verifies the README
  mentions the filename somewhere; it does not evaluate whether the stated reason is
  *good* - see "Enforcement Limits". `.d.ts` ambient-declaration files are exempt:
  they are not runtime entrypoints.
- A README-justified extra entrypoint is also a legitimate owner-boundary crossing
  point for the `direction` rule (§5): `src/proxy.ts` importing
  `src/platform/auth/proxy-gate.ts` is the real example this repository has today.

## 4. Persistence layering

Ranks, lowest first; a file in one rank may import its own rank or lower, never
higher (`WEBAPP_TEMPLATE_SPEC.md` §5.1):

```structure persistence-layers
foundation
repositories
use-cases
composition
```

`src/persistence/schema/**`, `src/persistence/sql/**`, `src/persistence/migrations/**` and
`src/persistence/seed/**` are rank `foundation` (schema is what foundation's client is
built against); `src/persistence/tests/**` is exempt from ranking (it may import any
rank, like any other test).

**External door** - the only `src/persistence/**` paths a file outside `src/persistence/`
(under `src/app/`, `src/modules/`, `src/shared/`, `src/platform/`, root config, `tests/e2e/`,
`tests/integration/`, or an owner-local `tests/`) may import:

```structure persistence-entry
composition/request-services.ts
composition/create-request-services.ts
composition/public-services.ts
repositories/contracts/
use-cases/
```

This matches `WEBAPP_TEMPLATE_SPEC.md` §5.1's own worked `persistence-entry` example
(`composition/request-services.ts`, `composition/create-request-services.ts`,
`repositories/contracts/`, `use-cases/`) plus `composition/public-services.ts`, the
narrow public composition seam for unauthenticated request paths
(`WEBAPP_TEMPLATE_SPEC.md` §5.8, `src/persistence/foundation/client.ts`'s `getPublicDb()`).
Everything else (`foundation/`, `repositories/drizzle/`, `schema/`, `sql/`,
`migrations/`) is internal except for the narrow entry below. In practice this
mostly means: import *types* from `repositories/contracts/**`/`use-cases/**` freely,
and call `getRequestServices()`/`getPublicServices()` for the runtime door.

**Narrow entries** - a specific, single, reasoned exception to "internal", each with
an owner, an importer, and a reason (`WEBAPP_TEMPLATE_SPEC.md` §5.1):

```structure narrow-entry
target   src/persistence/composition/auth-database.ts
owner    persistence
importer src/platform/auth/server/auth.ts
reason   Better Auth's Drizzle adapter needs the Drizzle instance and the raw auth
         schema object directly for its own adapter; the rest of the persistence
         graph (use cases, the Unit of Work) does not belong in auth
         initialization (decisions/0005-better-auth-magic-link-drizzle-adapter.md).
```

`src/proxy.ts` is a stricter special case than ordinary root config: it must import
**nothing** under `src/persistence/`, not even the seam door (`src/persistence/README.md`).
The `direction` rule (§5) enforces this specifically for `src/proxy.ts`.

## 5. Dependency direction

```structure direction
may-import app                modules shared platform persistence-entry persistence-narrow i18n
may-import modules            modules shared platform persistence-entry persistence-narrow i18n
may-import shared             shared platform i18n
may-import platform           platform shared modules persistence-entry persistence-narrow i18n
may-import persistence        shared platform modules i18n
may-import i18n               i18n
may-import root-config         modules shared platform persistence-entry persistence-narrow i18n e2e-helpers
may-import tests                app modules shared platform persistence-entry persistence-narrow persistence-internal i18n root-config scripts
may-import integration-tests    app modules shared platform persistence-entry persistence-narrow persistence-internal i18n
may-import scripts              nothing
may-import e2e                  e2e-helpers
may-import e2e-helpers          e2e-helpers

forbid client-reachable-reaches-privileged
forbid proxy-imports-persistence
```

**Category tokens, and how a file gets one.** In this order: (1) `tests/e2e/helpers/**` is
category `e2e-helpers`; (2) the rest of `tests/e2e/**` (including `tests/e2e/serial/**`) is
category `e2e`; (3) `tests/integration/**` is its own category; (4) any remaining
path with a `tests` segment anywhere (`src/modules/*/tests/**`, `src/shared/*/tests/**`,
`src/platform/*/tests/**`, `src/persistence/tests/**`, `scripts/structure/tests/**` alike) is
category `tests`; (5) otherwise, the file's root (`src/app/`, `src/modules/`, `src/shared/`,
`src/platform/`, `src/i18n/`, `scripts/`) or, under `src/persistence/`, its fine-grained
sub-category (`persistence-entry`/`persistence-narrow`/`persistence-internal`, §4);
(6) a file with no `/` in its path at all (a repo-root config file) or a file directly
under `src/` (`src/proxy.ts`, `src/instrumentation*.ts`, the two Sentry configs: Next.js
convention files, not owner code) is `root-config`. `persistence-entry`/`persistence-narrow`/`persistence-internal` all
collapse to the single row `persistence` when they are the *source* of an edge
(internal persistence-to-persistence layering is §4's `persistence-layers` rule's
job, not this matrix's); they stay distinct on the *target* side.

**Owner public-entrypoint boundary.** Crossing into a `src/modules/`, `src/shared/` or
`src/platform/` owner from a different owner, or from outside those three roots entirely, must land
on that owner's public entrypoint (`index.ts`/`client.ts`/`server.ts`/`actions.ts`/
`*-actions.ts`, §3) or on an extra top-level file that owner's own `README.md`
names (§3's own last bullet) - checked by the `direction` rule as part of every
edge, not only inside the matrix above.

`e2e-helpers` (`tests/e2e/helpers/**`) connects to the hermetic test database directly via
`pg` (its own small `pg.Pool`, `tests/e2e/helpers/db.ts`) rather than through any
`src/persistence/**` seam - an e2e spec drives the running application over HTTP, and
its data factories talk to the same test database out-of-band, never through
application code (`WEBAPP_TEMPLATE_SPEC.md` §10.4). `playwright.config.ts` importing
`tests/e2e/helpers/env.ts` for its `baseURL` is the one `root-config -> e2e-helpers` edge
that exists today.

## 6. `request-services`

```structure request-services
pattern  cache(createRequestServices)
allowed  src/persistence/composition/request-services.ts
```

Exactly one file in the whole repository may contain the literal text
`cache(createRequestServices)` (`WEBAPP_TEMPLATE_SPEC.md` §5.5), and it must be the
`allowed` file above. Consumers call `getRequestServices()`, never
`createRequestServices()` directly - not separately checked (§14: a text search for
the call `createRequestServices()` is indistinguishable from its own zero-argument
declaration).

## 7. `src/app/**` seams

```structure app-seams
page.tsx
layout.tsx
template.tsx
default.tsx
loading.tsx
error.tsx
global-error.tsx
not-found.tsx
route.ts
route.test.ts
opengraph-image.tsx
twitter-image.tsx
icon.tsx
icon.svg
icon.png
apple-icon.png
apple-icon.tsx
favicon.ico
sitemap.ts
robots.ts
manifest.ts
globals.css
```

Every file directly under `src/app/` (at any depth) must have one of these exact
basenames, except inside a path segment starting with `_` (Next's own "private
folder" convention, excluded from routing). Route *segments* (`(marketing)`,
`(app)`, `(auth)`, `[id]`, `[...all]`) are unrestricted - this rule only checks
filenames, never directory names, which Next's own router already governs.

`route.test.ts` is this repository's one deliberate addition beyond the pure Next.js
convention list: a route handler's own access-step unit test, co-located directly
beside its `route.ts` (`WEBAPP_TEMPLATE_SPEC.md` §10.2's "Server Actions / Route
Handler" testing row; the `projects` example module's
`src/app/api/cron/purge-archived-projects/route.test.ts` was this rule's worked example
until P1 removed that module, see `src/modules/workspaces/README.md`'s "How the
`projects` example module was removed" - a later phase's cron route reintroduces one).
The `tests` rule (§8) grants this same file its one placement exemption, deferring to
this block rather than duplicating the basename.

Unlike `WEBAPP_TEMPLATE_SPEC.md` §3's vanilla layout (route handlers only under
`src/app/api/`), this rule allows `route.ts`/`route.test.ts` anywhere under `src/app/`,
matching actual Next.js convention (a route handler is legal anywhere in the `src/app/`
tree).

## 8. Tests

```structure tests
suffix .spec.ts tests/e2e
suffix .integration.test.ts tests/integration
suffix .test.ts *
exempt tests/e2e/helpers
exempt src/persistence/tests/support
exempt src/platform/mailer/tests/support
exempt src/platform/object-storage/tests/support
exempt scripts/structure/tests/helpers.ts
```

- Every `.ts`/`.tsx` file under `tests/e2e/` (excluding `tests/e2e/helpers/**`) must end in
  `.spec.ts` - this covers `tests/e2e/serial/**` too, not only the parallel default
  project.
- Every `.ts`/`.tsx` file under `tests/integration/` must end in
  `.integration.test.ts`.
- Every `.ts`/`.tsx` file whose path contains a `tests/` segment anywhere
  (owner-local `src/modules/*/tests/`, `src/shared/*/tests/`, `src/platform/*/tests/`,
  `src/persistence/tests/`, `scripts/structure/tests/`, or the root-config tests under
  `tests/config/`), other than an `exempt` path
  above, must end in `.test.ts` or `.test.tsx` - this also covers `*.db.test.ts`
  (`src/persistence/tests/*.db.test.ts` against real Postgres, `vitest.config.ts`'s `db`
  project), which is itself a `.test.ts`-suffixed name.
- A file ending in `.test.ts`/`.test.tsx`/`.spec.ts`/`.integration.test.ts` anywhere
  else in the repository is a misplacement, with one exemption: a `route.test.ts`
  file directly under `src/app/` (§7) - a name §7's own `app-seams` block already
  allows there, so this rule defers to it instead of re-stating the same basename.

This condenses `WEBAPP_TEMPLATE_SPEC.md` §11.5's vanilla `tests` rule to this
repository's actual convention: a single `.db.test.ts` suffix for repository-level DB
tests (not a further split), and one top-level `tests/` root whose children
`tests/e2e/` and `tests/integration/` hold the two cross-cutting suites
(`decisions/0011-src-and-tests-roots.md`, `WEBAPP_TEMPLATE_SPEC.md` §3 since revision 6).

## 9. Documentation

```structure documentation
require AGENTS.md
require DOC_RULES.md
require README.md
require STRUCTURE.md
require decisions/*.md
require src/persistence/README.md
require src/modules/*/README.md
require src/shared/*/README.md
require src/platform/*/README.md
require src/i18n/README.md
key Document type:
key Lifecycle:
key Owner:
key Scope:
key Canonical responsibility:
key Maintenance triggers:
key Last verified:
```

Every `require`d path (glob-expanded) must contain every `key` line in its metadata
block: an optional `# Title` line, then everything up to the document's first
heading line (`#` through `######`) - not a blank-line or fixed-line-count cutoff,
since neither is reliable in practice. `CLAUDE.md` (a pointer, `@AGENTS.md` plus the
block `next dev` manages) and `WEBAPP_TEMPLATE_SPEC.md` (the external spec this
template implements, not a document of this repository's own governance the way
`AGENTS.md`/`STRUCTURE.md`/`DOC_RULES.md` are, and not carrying the full header
itself) are deliberately **not** `require`d.

Additionally, every relative Markdown link (square-bracket link text followed by a
parenthesized target, excluding `http(s)://` and `mailto:` targets) found in a
`require`d document must resolve to a real file, resolved relative to the linking
document's own directory and with any `#fragment` stripped before the existence
check.

`docs/` must never exist anywhere in the repository (redundant with, and
cross-checked against, §1's `roots` rule).

## 10. `env-access`

Which files may reference `process.env.<NAME>` for the sensitive, credential- or
identity-like variables below. `src/platform/env` is the intended single owner of
`process.env` at request time (`WEBAPP_TEMPLATE_SPEC.md` §3/§9): every one of these
variables is validated once, by `src/platform/env/server/env.ts`'s `ServerEnv` Zod
schema, and read everywhere else in application code through `serverEnv()` - never
as a second, independent `process.env.<NAME>` literal. This rule is the mechanical
half of that claim: it catches a literal, direct `process.env.<NAME>` read for one
of these names appearing outside its declared location, which is exactly the
regression `src/platform/env`'s own `README.md` and
`decisions/0009-sentry-config-files-read-process-env-directly.md` describe as the
thing to avoid. It cannot verify that every *other* reader goes through
`serverEnv()` correctly (see "Enforcement Limits" §14).

```structure env-access
DATABASE_URL             src/persistence/foundation/, src/platform/env/, scripts/db/, drizzle.config.ts
DATABASE_URL_PUBLIC      src/persistence/foundation/, src/platform/env/, scripts/db/, drizzle.config.ts
DATABASE_URL_MIGRATE     scripts/db/, drizzle.config.ts
BETTER_AUTH_SECRET       src/platform/auth/, src/platform/env/
CRON_SECRET              src/platform/api-pipeline/, src/platform/env/
SMTP_URL                 src/platform/mailer/, src/platform/env/
MAIL_FROM                src/platform/mailer/, src/platform/env/
SENTRY_DSN               src/platform/observability/, next.config.ts, src/instrumentation.ts, src/instrumentation-client.ts, src/sentry.server.config.ts, src/sentry.edge.config.ts
SENTRY_AUTH_TOKEN        next.config.ts
S3_ENDPOINT              src/platform/object-storage/, src/platform/env/
S3_REGION                src/platform/object-storage/, src/platform/env/
S3_BUCKET                src/platform/object-storage/, src/platform/env/
S3_ACCESS_KEY_ID         src/platform/object-storage/, src/platform/env/
S3_SECRET_ACCESS_KEY     src/platform/object-storage/, src/platform/env/
S3_FORCE_PATH_STYLE      src/platform/object-storage/, src/platform/env/
MISTRAL_API_KEY          src/platform/mistral/, src/platform/env/
RESEND_API_KEY           src/platform/inbound-mail/, src/platform/env/
RESEND_WEBHOOK_SECRET    src/platform/inbound-mail/, src/platform/env/
```

A named variable above is allowed in the listed file(s)/prefix(es) and in any
tooling file (`scripts/structure/lib/module-graph.ts`'s `isToolingFile`:
`scripts/**`, any path with a `tests/` segment (the whole top-level `tests/` root and
every owner-local `tests/` directory), `*.test.ts`/`*.spec.ts`, `vitest.config.ts`,
`playwright.config.ts`, `drizzle.config.ts`, `.env*`).

`SENTRY_DSN`'s exemption list beyond `src/platform/observability/` is
`decisions/0009-sentry-config-files-read-process-env-directly.md` made mechanical:
`next.config.ts` (mirrors it into `NEXT_PUBLIC_SENTRY_DSN`), `src/instrumentation.ts`
(reads it directly for `onRequestError`), and the three files Next.js/`@sentry/nextjs`
file convention requires directly under `src/`
(`src/instrumentation-client.ts`, `src/sentry.server.config.ts`, `src/sentry.edge.config.ts`).
`SENTRY_AUTH_TOKEN` gates whether `next.config.ts` wraps the Next config with
`withSentryConfig` at all - a build-time-only concern with no `src/platform/env` field.

Variables not named above (`NODE_ENV`, `CI`, `NEXT_PUBLIC_*`, `APP_URL`,
`APP_COMMIT_SHA`, `E2E_PORT`, `E2E_BASE_URL`, ...) are unrestricted by this rule -
either public by design (inlined into client bundles, so confining them serves no
purpose) or non-sensitive test/build plumbing.

## 11. `vendor-sdk`

```structure vendor-sdk
drizzle-orm       src/persistence/
pg                src/persistence/foundation/, scripts/db/, tests/e2e/helpers/
better-auth       src/platform/auth/
@sentry/          src/instrumentation.ts, src/instrumentation-client.ts, src/sentry.server.config.ts, src/sentry.edge.config.ts, next.config.ts, src/platform/observability/
nodemailer        src/platform/mailer/
@react-email/     src/platform/auth/server/emails/, src/platform/mailer/, src/modules/workspaces/server/emails/, src/modules/documents/server/emails/, src/modules/billing/server/emails/, src/modules/mail-intake/server/emails/
@vercel/functions src/persistence/foundation/
@aws-sdk/         src/platform/object-storage/
fast-xml-parser   src/modules/intake/
csv-parse         src/modules/intake/
svix              src/platform/inbound-mail/
```

A package specifier that starts with the left column (prefix match - `@react-email/`
matches `@react-email/components` and `@react-email/render`; `drizzle-orm` matches
`drizzle-orm/node-postgres`, etc.) may only be imported (static `import`, dynamic
`import()`, or `require()`) from a file whose repo-relative path starts with one of
the right-hand prefixes. Tooling files (`isToolingFile`, same definition as §10) are
exempt - tests and `scripts/db/**`/`tests/e2e/helpers/**` legitimately import
`drizzle-orm`/`pg` too. Every other package in `package.json` (`@base-ui/react`,
`class-variance-authority`, `clsx`, `lucide-react`, `next-intl`, `next-themes`,
`server-only`, `tailwind-merge`, `tw-animate-css`, `zod`, `next`, `react`,
`react-dom`, `pdf-lib`, `scanic`, `exceljs`, `archiver`) is a general-purpose library, not
an architecturally sensitive vendor SDK, and is unrestricted by this rule. `exceljs` and
`archiver` are the Abschluss export's workbook and ZIP writers
(decisions/0066-abschluss-check-and-export.md): used only in
`src/modules/closing/server/`, but file-format libraries like `pdf-lib`, not a provider
SDK holding credentials or owning a table, so they are listed here rather than given a
confinement row above. `eslint.config.mjs`'s own
`no-restricted-imports` forward-guard for `@supabase/*`/`@neondatabase/*`
(`decisions/0003-provider-independent-postgres-with-drizzle.md`) is a separate,
editor-facing check for packages not currently installed at all; this rule is the
authority for resolved paths once a vendor SDK actually is a dependency.

## 12. `e2e`

```structure e2e
forbid src/app/
forbid src/modules/
forbid src/shared/
forbid src/platform/
forbid src/persistence/
```

No file under `tests/e2e/` whose name matches `*.spec.ts` (excluding `tests/e2e/helpers/**`,
which is never itself a spec) may resolve an import, directly or transitively,
following only repo-relative/`@/`-alias imports, into any of the forbidden roots -
an e2e spec drives the running application over HTTP (Playwright) and its own test
database directly (`tests/e2e/helpers/**`, §5), never by importing product code. This
repository's e2e specs today import only `@playwright/test` and `tests/e2e/helpers/**`, so
this rule is deliberately stricter than `WEBAPP_TEMPLATE_SPEC.md` §4.3's narrower
"imports no app code" wording taken literally as "no `src/app/` only": nothing in
`src/modules/`, `src/shared/`, `src/platform/`, or `src/persistence/` is needed either, so all five
are forbidden roots here (see "Enforcement Limits" §14 for when this would need
loosening).

## 13. Exceptions

```structure exceptions
scripts/structure/tests/fixtures/** | Synthetic fixture trees for the structure checker's own fixture tests (scripts/structure/tests/*.test.ts): a tiny, self-contained structure.md plus good/bad directories per rule, the bad/ ones deliberately violating whatever that rule checks. Not real repository code; excepted so a whole-repo run (including this task's own verify-structure.test.ts, which runs the checker against the real STRUCTURE.md and the real repo root) never evaluates this fixture data against the real rules. | remove by: never (this is not migration debt; every checker needs somewhere to keep its own test fixtures)
```

Format: `<path or glob>` (a bare directory ending in `/**` or `/*`, or an exact file
path) `|` `<reason>` `|` `<remove-by note>`. A violation from any rule whose primary
file matches one of these paths is suppressed (not printed, does not fail the run).
The checker separately verifies every exception here still matches at least one real
file in the repository - an exception matching nothing is itself a hard error
("stale exception"). This list holds only the checker's own fixture data; this
repository has no in-progress migration debt to except.

## 14. Enforcement Limits

Deliberately not machine-checked, and why:

- **Quality of a stated reason.** §3's "extra top-level entrypoint file must be
  named in the owner README" - the checker verifies the filename is *mentioned* in
  the README, never whether the stated reason is actually good, and does not check
  the file's own header comment at all. A human reviews the substance; the checker
  only catches the "nobody wrote anything down" case.
- **`async`-ness of `actions.ts` exports.** §3 checks the syntactic shape but does
  not resolve whether a plain `export function` genuinely returns a `Promise` -
  TypeScript's own checker (`pnpm typecheck`) already enforces Server Functions must
  be async at the language level.
- **`process.env` centralization beyond the named table.** §10 enforces confinement
  only for named, credential- or identity-like variables, not a blanket
  "`process.env` only in `src/platform/env`" rule: a broader static analysis would need
  to also verify every *other* file's `process.env` access goes through
  `serverEnv()`/`publicEnv`, which this rule does not attempt.
- **`createRequestServices()` call-site confinement.** §6 describes the intent
  (only `getRequestServices()` should be called by consumers) but the checker does
  not enforce it: a text search for the call `createRequestServices()` is
  indistinguishable from its own declaration.
- **e2e "imports no product code".** §12 forbids five specific roots rather than
  asserting "imports nothing outside `tests/e2e/helpers/**`" in the abstract - if a future
  e2e spec needs a small shared constant from product code for an exact-value
  assertion (a cache-control string, a contact email), this rule would need an
  explicit, reasoned loosening (following the same narrow-entry pattern as §4),
  not a silent one.
- **ADR immutability** (`DOC_RULES.md` §6, "ADRs are immutable once accepted") is not
  checked - it would need git history, not a snapshot of the working tree.
- **Repository-owner-only-writes-its-tables** (`WEBAPP_TEMPLATE_SPEC.md` §5.3,
  `AGENTS.md`'s "Database Rules") is a review rule, not something enforced by
  tooling here.
- **Whether a `src/shared/` owner genuinely has 2+ consumers**, and whether they are
  "real" ones, is a semantic judgment left to review, not a countable structural
  fact this checker re-derives from import counts alone.

## 15. Relation to the checker's own resolver

`scripts/structure/lib/module-graph.ts` is a small, self-contained static
module-graph walker (`walkGraph`, `resolveImport` with `@/`-alias support, `chain`
for readable error paths, `repoSourceFiles`, `isToolingFile`) built specifically for
this checker - this repository has no pre-existing import-graph guard-test library
to build on instead (`decisions/0010-structure-checker-self-contained-resolver.md`
records why). Every rule that needs import resolution (`direction`, `persistence`,
`request-services`, `env-access`, `vendor-sdk`, `e2e`) imports this one module
rather than a second copy, so a future change to how imports resolve (a new path
alias, say) only needs to be taught to one resolver.

`pnpm verify:structure` (`scripts/structure/verify-structure.ts`, run via `tsx`, its
own fixture tests under `scripts/structure/tests/`) is a separate command from
`pnpm test`, which runs every other unit test in the repository; nothing here
changes what `pnpm test` covers on its own. Both are required by CI's `check` job.
