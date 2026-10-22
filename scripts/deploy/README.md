# Deployment

Document type: reference
Lifecycle: active
Owner: repository maintainer
Scope: The CI and production release pipeline (`.github/workflows/ci.yml`, `deploy-production.yml`,
`rollback-production.yml`, `.github/actions/**`), `scripts/deploy/check.mjs`, `scripts/vercel/`, `vercel.json`,
and the one-time setup of GitHub, Infisical, Vercel, Neon, Cloudflare R2, the mail provider, Mistral and Sentry
that the pipeline and the application need
Canonical responsibility: The setup and operations guide for getting this repository from a fresh clone to a
running production deployment, and for releasing, rolling back and rotating secrets afterwards
Maintenance triggers:
- A job or a trigger of `ci.yml`, `deploy-production.yml` or `rollback-production.yml` changes
- An environment variable is added, removed or changes where it is read (`src/platform/env/server/env.ts`,
  `.env.example`)
- The set of keys the workflows read from Infisical `/ci` changes
- The Vercel CLI pin in `scripts/vercel/package.json` is raised
- A provider (Neon, R2, Vercel, Infisical, the mail provider) is replaced
Last verified: 2026-10-22, decisions/0075-email-intake.md added the four E-Mail-Eingang variables and "Resend
receiving" in section 7 (the production receiving domain is the account's own `<id>.resend.app`, kept in Infisical,
not in this public repository). Previously 2026-10-21, against the workflow files and `src/platform/env/server/env.ts`. The pipeline has not
run on GitHub yet; section 12 lists what that leaves unverified.

This file is the guide behind decisions/0073-public-repo-and-production-pipeline.md. The repository is public: no
value, id or address of a real account is written into it. Names between `<` and `>` are yours.

## Contents

1. What runs when
2. Environment variables
3. One-time setup: GitHub
4. One-time setup: Infisical
5. One-time setup: Vercel
6. One-time setup: Neon
7. One-time setup: Cloudflare R2, mail, Mistral, Resend receiving, Sentry
8. First deployment, step by step
9. Releasing
10. Rolling back
11. Operations: cron, secret rotation, backups
12. Known limits and what is not verified

## 1. What runs when

```
feature branch --PR--> development                      ci.yml: smoke e2e (see below)
development    --PR--> main   (the release PR)           ci.yml: everything, full e2e
merge to main                                            deploy-production.yml
```

### CI (`.github/workflows/ci.yml`)

GitHub-hosted runners only (`ubuntu-24.04`); no job uses a repository secret. `ci-passed` is the single required
status check.

| Job | Runs when | What it does |
|---|---|---|
| `changes` | always | `dorny/paths-filter` on pull requests: `code` (anything but Markdown and `LICENSE`), `docs` (Markdown), `workflows` (`.github/**`, `scripts/vercel/**`). |
| `check` | pushes, manual runs, PRs into `main`; other PRs when code or docs changed | Install, typecheck, lint, `pnpm verify:structure`, unit tests, `pnpm build` (dummy public env), migration drift check (`pnpm db:generate` then `git diff --exit-code src/persistence/migrations`). A docs-only PR runs only the structure check, because it validates governed Markdown. |
| `db` | like `check`, but only when code changed | `postgres:18` and `axllent/mailpit` as service containers, MinIO via `docker run`, then `pnpm test:db` and `pnpm test:int`. |
| `e2e` | like `db` | Playwright against `pnpm build && pnpm start`. PRs into `development`: `--grep @smoke`. Everything else: the full suite. Report and traces are uploaded only on failure. |
| `actionlint` | pushes, manual runs, PRs into `main`; other PRs when `.github/**` or `scripts/vercel/**` changed | `actionlint` (with shellcheck) over the workflow files. |
| `ci-passed` | always (`if: always()`) | Fails if any job failed or was cancelled; skipped jobs are fine. |

Pull requests cancel their superseded run; pushes never cancel. Every job has a `timeout-minutes`. Third-party
actions are pinned by commit SHA (the tag is in a comment): to raise one, resolve the new SHA with
`gh api repos/<owner>/<repo>/git/ref/tags/<tag>` (for an annotated tag, follow the tag object to its commit) and
change every occurrence in one pull request.

The `db` and `e2e` jobs assemble the same stack as `docker/compose.test.yml` without Docker Compose: the
`.github/actions/test-stack` composite action runs `docker/test-db-init/00_roles.sql`, starts MinIO, exports the
dummy test environment (including `DIGIPOST_TEST_STACK=1`, which `scripts/test/test-stack-guard.ts` requires) and
runs `scripts/db/bootstrap-roles.mjs`, `migrate.mjs` and `seed.mjs`. `pnpm test:docker` and
`pnpm test:e2e:docker` stay the local reference run (decisions/0006); if you change the Compose stack's
environment or services, change the composite action too.

### Production (`.github/workflows/deploy-production.yml`)

```
fresh -> migrate -> stage -> health -> promote -> record        (record always runs, last)
```

| Job | What it does | If it fails |
|---|---|---|
| `fresh` | The commit of the run is still the head of `main`. An older run (a re-run) is refused, unless a manual run was started with `allow_stale`. | Nothing is deployed |
| `migrate` | Loads `DATABASE_URL_MIGRATE` and `MIGRATE_EXPECTED_HOST` from Infisical, then `pnpm db:migrate --remote --expect-host=...` (advisory lock, one transaction). | Nothing is deployed |
| `stage` | Records a GitHub deployment, installs dependencies, installs the pinned Vercel CLI, loads the Vercel credentials, `vercel pull --environment=production`, `env -u VERCEL_TOKEN vercel build --prod`, `vercel deploy --prebuilt --prod --skip-domain --json --env APP_COMMIT_SHA=...`. Checks the answer: a `*.vercel.app` address, a `dpl_` id, target `production`, state `READY`. | Nothing is promoted |
| `health` | `node scripts/deploy/check.mjs <staged url> --expect-version=<short sha>` with the project's bypass secret (section 8, "The health check"). | Nothing is promoted |
| `promote` | Checks again that the commit is still the head of `main`, then `vercel promote <staged url> --yes --timeout 5m`. | Production keeps its previous deployment |
| `record` | Closes the GitHub deployment record `app-production`: `success` only if `promote` succeeded. | |

Production stays on its previous deployment until `promote`. Runs queue one behind the other (concurrency group
`deploy-production`) and are never cancelled: a migration or a promotion in progress runs to its end. GitHub keeps
only the newest waiting run: a run that is waiting when a newer push arrives is cancelled, and the newer run
deploys the newer commit.

Every job runs only for `ExpidetGames/digipost` on `refs/heads/main`. That condition guards against accidents; the
security boundary is the GitHub environment `production` (section 3). A job that needs a secret runs in that
environment. Secrets are passed explicitly to composite actions, and nothing uses `secrets: inherit`.

Why the stage is inline and not a reusable workflow: there is one Vercel project, so a reusable workflow would
only add the need to pass the four Infisical secrets across the call boundary (a called workflow does not see an
environment's secrets on its own, and an unpassed one is an empty string without any error).

## 2. Environment variables

Three groups. The runtime ones are validated lazily by `serverEnv()` (`src/platform/env/server/env.ts`), so
`next build` needs none of them; the build needs only the public ones below.

### Runtime variables (Infisical `prod:/app`, synced to Vercel Production)

| Variable | Required | Value in production | Notes |
|---|---|---|---|
| `APP_URL` | yes | `https://<your domain>` | No trailing slash. Absolute links, auth callbacks, e-mails. |
| `NEXT_PUBLIC_APP_URL` | yes, also at build time | Same value as `APP_URL` | Inlined into the client bundle by `next build`. Must not be a Sensitive variable (section 5). |
| `DATABASE_URL` | yes | Neon **pooled** host, role `app_runtime` | `sslmode=require`. |
| `DATABASE_URL_PUBLIC` | no, leave unset | | For role `app_public`, which no code path uses yet (`getPublicDb()` has no caller). Set it only once an unauthenticated public path reads the database. |
| `BETTER_AUTH_SECRET` | yes | `openssl rand -base64 32` | At least 32 characters. Changing it signs everybody out. |
| `AUTH_BOOTSTRAP_EMAILS` | first deploy only | Your own address | Sign-up is by invitation only (decisions/0074). This list may sign up without one, for the first admin. Empty it once that admin exists. |
| `SMTP_URL` | yes | `smtps://<user>:<password>@<host>:465` | Provider-neutral (nodemailer). |
| `MAIL_FROM` | yes | `Digipost <no-reply@<your domain>>` | The domain needs SPF, DKIM and DMARC (section 7). |
| `CRON_SECRET` | yes | `openssl rand -base64 32` | Vercel sends it as `Authorization: Bearer ...` to the cron routes. At least 32 characters. |
| `S3_ENDPOINT` | yes for R2 | `https://<account id>.eu.r2.cloudflarestorage.com` | The EU jurisdiction endpoint. |
| `S3_REGION` | yes | `auto` | |
| `S3_BUCKET` | yes | `<bucket name>` | |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | yes | The scoped R2 token | |
| `S3_FORCE_PATH_STYLE` | optional | `false` | `true` is for MinIO only. |
| `MISTRAL_API_KEY` | see section 7 | Set for internal use (own company mail only, decisions/0073); unset for any external customer until the DPA is signed | Unset in production makes document processing fail with `ai_not_configured`, on purpose. |
| `AI_PROVIDER` | optional | Leave unset | Never `fake` in production. |
| `MISTRAL_OCR_MODEL`, `MISTRAL_CHAT_MODEL` | optional | Leave unset | Defaults to Mistral's own model names. |
| `INBOUND_EMAIL_DOMAIN` | for the E-Mail-Eingang | `<id>.resend.app` | The Resend-managed receiving subdomain (section 7, "Resend receiving"). Every workspace's address is `post-<token>@` this domain; changing it later changes every address. Unset: the feature is off. |
| `RESEND_WEBHOOK_SECRET` | for the E-Mail-Eingang | The webhook's signing secret (`whsec_...`) | Sensitive. Unset: `POST /api/webhooks/resend` answers 503. |
| `RESEND_API_KEY` | for the E-Mail-Eingang | A Resend API key with access to received emails | Sensitive. Unset in production makes processing a received mail fail (`inbound_mail_not_configured`), on purpose. |
| `INBOUND_MAIL_PROVIDER` | optional | Leave unset | Never `fake` in production. |
| `BILLING_TEST_MODE` | optional | **Unset or `false`** | `true` fakes payments (decisions/0017); no payment provider exists yet. |
| `SENTRY_DSN` | optional | The project's DSN | Read at run time and, mirrored into `NEXT_PUBLIC_SENTRY_DSN`, at build time: must not be Sensitive. |
| `APP_COMMIT_SHA` | never set here | | Set per deployment by `deploy-production.yml` (`vercel deploy --env`); `/api/health` reports its first seven characters as `version`. |

`DATABASE_URL_MIGRATE` (the owner role) is **never** a runtime variable and never in `/app` or in Vercel: the
owner role migrates, the runtime role never does (decisions/0004). It lives only in `prod:/ci`.

### Build-time variables (from `vercel pull`, i.e. also from `/app`)

`NEXT_PUBLIC_APP_URL` and `SENTRY_DSN` (above), and, only if you want source maps uploaded to Sentry,
`SENTRY_AUTH_TOKEN`, `SENTRY_ORG` and `SENTRY_PROJECT`. `next.config.ts` wraps the config with the Sentry build
plugin only when `SENTRY_AUTH_TOKEN` is set. `vercel build` runs without the Vercel token but does see every
non-Sensitive production variable the pull returned: treat the build code and the lockfile as trusted with them.

### CI-only values

| Where | Name | Meaning |
|---|---|---|
| GitHub environment `production`, **secrets** | `INFISICAL_CLIENT_ID`, `INFISICAL_CLIENT_SECRET`, `INFISICAL_DOMAIN`, `INFISICAL_PROJECT_SLUG` | The sign-in to Infisical (section 4). Secrets and not variables, because the variables of a public repository are world-readable. |
| Infisical `prod:/ci` | `VERCEL_TOKEN` | A Vercel access token. |
| | `VERCEL_TEAM_ID` | The id of the Vercel team (`team_...`); the workflows export it as `VERCEL_ORG_ID`. |
| | `VERCEL_APP_PROJECT_ID` | The project id (`prj_...`). |
| | `VERCEL_APP_AUTOMATION_BYPASS_SECRET` | The project's Protection Bypass for Automation secret; opens the staged address for the health check. |
| | `DATABASE_URL_MIGRATE` | The owner role's **direct** (unpooled) Neon URL. |
| | `MIGRATE_EXPECTED_HOST` | The host name of that URL, typed in again by hand: `--expect-host` refuses to migrate when the URL's host is any other. |

The CI test jobs use no secret at all; their database, mail and storage values are the dummy ones written in
`.github/actions/test-stack/action.yml` (and in `docker/compose.test.yml`).

## 3. One-time setup: GitHub

Repository `ExpidetGames/digipost` (if the owner or name is different, change the guard condition in the three
workflow files and `check-current-commit`'s callers: search for `ExpidetGames/digipost`).

1. **Environment `production`** (Settings, Environments). Deployment branches and tags: *Selected branches and
   tags*, only the branch `main`. **This rule is the security boundary.** Every job that signs in to Infisical
   runs in this environment, so a run on any other branch is refused before it can read a secret. The jobs' own
   condition guards against accidents only: anyone who can push a branch can push a workflow file without it, and
   only the environment's rule stops that run from reading the four secrets. No workflow can verify this setting,
   so check it yourself after setting it and after any change:

   ```sh
   gh api repos/<owner>/<repo>/environments/production --jq '.deployment_branch_policy'
   gh api repos/<owner>/<repo>/environments/production/deployment-branch-policies --jq '.branch_policies[].name'
   ```

   The first must show `custom_branch_policies: true`, the second must list exactly `main`. Do not add required
   reviewers: every job of the pipeline would wait for the approval, a rollback included.
2. **The four environment secrets** of `production` (section 2), set without typing a value into a command line:

   ```sh
   read -rs -p 'value: ' V; printf '%s' "$V" | gh secret set INFISICAL_CLIENT_SECRET --env production; unset V
   ```

   No repository variable is needed. The old `CI_RUNNER`, `CI_DOCKER_SUITES` and `DEPLOY_ENABLED` variables and
   the `STAGING_*` and `PRODUCTION_*` secrets are not used anymore: delete them if they exist.
3. **Branch protection** (Settings, Branches, or a ruleset) on `main` and `development`: require a pull request,
   require the status check `ci-passed` (its job name is "All checks passed?"; select it after one run has
   reported it), block force pushes and deletion. Deployment relies on this: `deploy-production.yml` starts on the
   push to `main` and does not wait for CI, because the release PR was already green.
4. **Actions settings** (Settings, Actions, General): *Fork pull request workflows from outside collaborators*:
   **Require approval for all outside collaborators**. Workflow permissions: read repository contents by default.
   Do not enable "Send secrets to workflows from pull requests".
5. Releases are PRs from `development` into `main`. Create `development` from `main` once.

## 4. One-time setup: Infisical

One project; the workflows use the environment slug **`prod`** and nothing else.

- Two folders in `prod`:

  | Folder | Holds | Read by |
  |---|---|---|
  | `/ci` | Only what the workflows need (section 2) | GitHub Actions, through the machine identity |
  | `/app` | The runtime and build variables (section 2) | Vercel, by Secret Sync |

- **Machine identity**: one identity, **Universal Auth**. Create a custom project role with exactly this and
  nothing more:

  | Permission | Environment | Secret path | Why |
  |---|---|---|---|
  | Secrets: describe and read value | `prod` | `/ci` | The jobs load the keys of `/ci` |

  No read of `/app`, no other environment, no write, no delete, no folder, project or identity administration;
  the secret path condition is `$eq` `/ci`. The pipeline never writes to Infisical. Set the identity's *Access
  Token TTL* low (minutes: a job lasts at most half an hour and signs in again for every key it loads) and, if
  your version offers it, a small *Number of Uses Limit*. Create a Client Secret, put the Client ID and the
  Client Secret into the two GitHub environment secrets, and rotate the Client Secret on a schedule (section 11).
- **Secret Sync**: one sync, destination *Vercel*, source `prod` `/app`, to the project's **Production**
  environment, auto-sync on. `vercel pull` in the pipeline reads the result. Do not set a variable of the project
  by hand in Vercel: the next sync would overwrite it. A change in Infisical takes effect with the **next
  deployment**: wait until the sync shows *synced*, then run *Deploy production*.
- **Keep the `/app` variables ordinary (not Sensitive) where the build needs them.** `vercel pull` does not
  return a Sensitive variable, so a Sensitive `NEXT_PUBLIC_APP_URL` or `SENTRY_DSN` would be missing at build
  time. The secrets the build does not need may be Sensitive; they still reach the deployment at run time.
- Generate every secret with `openssl rand -base64 32` (or longer) and never put one in a chat, an issue or a
  log.

## 5. One-time setup: Vercel

Plan: **Pro** (a Hobby plan allows only daily crons and fewer deployment features).

1. Create the project **without connecting the Git repository** (`vercel project add <name>` or the dashboard).
   `vercel.json` carries `"git": { "deploymentEnabled": false }`, so a connected repository would not auto-deploy
   either, but the pipeline is the only thing that should deploy.
2. Settings, General: Framework Preset *Next.js*, **Root Directory** the repository root (empty), **Node.js
   Version** 24.x. Copy the **Project ID** into `/ci` (`VERCEL_APP_PROJECT_ID`); the team id is in the team's
   settings (`VERCEL_TEAM_ID`).
3. **Function region `fra1`**: `vercel.json` says `"regions": ["fra1"]` (the file wins). Set the dashboard
   setting to `fra1` too so they do not disagree, and keep it equal to the database's region (Neon
   `aws-eu-central-1`, Frankfurt).
4. Settings, Deployment Protection: leave *Standard Protection* on (it protects every address except the
   production domains) and switch on **Protection Bypass for Automation**. Copy its secret into `/ci`
   (`VERCEL_APP_AUTOMATION_BYPASS_SECRET`). The production domain must stay reachable without a login.
5. Settings, Domains: add the production domain and set the DNS records Vercel shows. Set `APP_URL` and
   `NEXT_PUBLIC_APP_URL` in Infisical to that domain.
6. Settings, Environment Variables: leave them to the Secret Sync.
7. Account settings, Tokens: create the access token for `/ci` `VERCEL_TOKEN`. **A Vercel access token acts for
   its owner in the whole team, not for one project**, whatever the project id says. Create it from a dedicated
   account with the lowest team role that can deploy and promote, give it an expiry if the dashboard offers one
   (and a calendar reminder to rotate it before that day), and use a project-limited token if one is offered. It
   is the most valuable key in `/ci`: it can deploy to production, which is why the environment `production` is
   restricted to `main`.
8. **Crons** (`vercel.json`, run on the production deployment only): `GET /api/cron/process-jobs` every two hours
   (`0 */2 * * *`), `GET /api/cron/purge-rejected-intake` daily at 03:00 UTC. Vercel sends
   `Authorization: Bearer $CRON_SECRET` when the project has a `CRON_SECRET` variable, which is what
   `requireCronSecret` checks (`src/platform/api-pipeline/server/cron-auth.ts`). The two-hourly sweep is a safety
   net: processing normally starts right after an upload and while a user watches
   (decisions/0016-processing-pipeline-and-ai.md).
9. The CLI that deploys is pinned in `scripts/vercel/` (`vercel@64.5.0`, whole tree from `package-lock.json`,
   `npm ci --ignore-scripts`). Raise it deliberately, in one pull request that changes both files, after reading
   the CLI's release notes. Do not run `npm install` in the repository root and never touch the root
   `pnpm-lock.yaml` for it.

## 6. One-time setup: Neon

1. Create a project in an **EU region** (`aws-eu-central-1`, Frankfurt), Postgres 18 if offered, otherwise the
   newest. Neon's default collation is `C`, which is what the test stack matches.
2. **Two hosts per endpoint**: the *direct* host (`ep-...`) and the *pooled* host (`ep-...-pooler`). The
   application (`DATABASE_URL`) uses the pooled host with `sslmode=require`. The migration
   (`DATABASE_URL_MIGRATE`) must use the **direct** host: `scripts/db/migrate.mjs` holds a session advisory lock
   for the whole run, which a transaction-mode pooler does not keep.
3. **The three roles** (decisions/0004-three-database-roles.md, `scripts/db/bootstrap-roles.mjs`):
   - the **owner**: Neon's default owner role of the database (its name does not matter, `grants.sql` applies to
     whichever role runs it). Its direct URL is `DATABASE_URL_MIGRATE`.
   - `app_runtime` (DML only): created once, before the first migration, by `pnpm db:bootstrap` from your own
     machine. Invent a password, build the two URLs, and pass them as shell variables, not a file. `app_public`
     is not needed (no code path uses it); `db:bootstrap` skips it while `DATABASE_URL_PUBLIC` is unset:

     ```sh
     read -rs -p 'owner direct URL: ' DATABASE_URL_MIGRATE; export DATABASE_URL_MIGRATE; echo
     read -rs -p 'runtime pooled URL: ' DATABASE_URL; export DATABASE_URL; echo
     pnpm db:bootstrap --remote --expect-host=<the direct host>
     unset DATABASE_URL_MIGRATE DATABASE_URL
     ```

     It is idempotent and never overwrites an existing role's password. Do not create a `.env.local` with
     production values for this (AGENTS.md, "Database Rules").
4. Put the same two URLs into Infisical (`/app` `DATABASE_URL`, `/ci` `DATABASE_URL_MIGRATE`), and the direct host name into `/ci` `MIGRATE_EXPECTED_HOST`.
5. **Backups are a requirement, not yet implemented as automation.** A business that keeps its incoming mail
   here must be able to restore it. Before real customers: set Neon's point-in-time-restore history retention to
   the longest window your plan offers (at least seven days), and add a scheduled logical dump (`pg_dump` with the
   owner role) to storage in a different account or provider, with a tested restore. Neon's restore window is
   not a long-term archive. Object storage needs the same thought (R2 has no built-in versioning of deleted
   objects; decide whether you want a second bucket or replication).

## 7. One-time setup: Cloudflare R2, mail, Mistral, Resend receiving, Sentry

**Cloudflare R2** (decisions/0012-object-storage.md, `src/platform/object-storage` is the only reader of the
`S3_*` variables):

- Create a bucket with the **EU jurisdiction** (it cannot be changed afterwards). It stays **private**: there are
  no public URLs; uploads go through a route handler and downloads through an authorized route.
- Create an **API token** scoped to that one bucket with *Object Read & Write*. Put its access key id and secret
  into `/app` (`S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`), with `S3_ENDPOINT=https://<account
  id>.eu.r2.cloudflarestorage.com`, `S3_REGION=auto`, `S3_BUCKET`, `S3_FORCE_PATH_STYLE=false`.
- **CORS is not needed**: the browser never talks to R2 (no presigned uploads; `presignDownload` has no caller).
  Add a CORS rule only if that changes.
- The upload cap is 4 MB per file (decisions/0027), below Vercel's request body limit of 4.5 MB.

**Mail**: any SMTP provider that sends from your domain. Put the account's SMTP URL into `/app` `SMTP_URL`.
On the sending domain set **SPF** (include the provider), **DKIM** (the provider's CNAME or TXT records) and
**DMARC** (start with `p=none` and a `rua` address, move to `quarantine` once reports are clean). Without these,
the magic-link sign-in mail lands in spam and nobody can log in. Send a real sign-in mail to an address at
each of the large mailbox providers before launch.

**Mistral and the DPA** (decisions/0016-processing-pipeline-and-ai.md, "Data protection note"): the pipeline
sends a document's full OCR text, which can contain personal data, to Mistral. Mistral is an EU-based
sub-processor, but **no Auftragsverarbeitungsvertrag exists yet and the privacy policy is a placeholder**.

For the current **internal** deployment the owner decided to set `MISTRAL_API_KEY` anyway (decisions/0073,
"Mistral for internal use"): only the company's own incoming mail is processed, and the owner accepts that
risk knowingly. This does not extend to any external customer: before another company's documents flow, the
DPA must be signed and the privacy policy lawyer-reviewed. Without the key, production still runs, uploads
work, and processing fails with `ai_not_configured`. The legal pages (`/legal-notice`, `/privacy`) are still
marked drafts.

**Resend receiving, the E-Mail-Eingang** (decisions/0075-email-intake.md, `src/platform/inbound-mail` is the
only reader of the Resend variables):

- Receiving uses the Resend-managed subdomain `<id>.resend.app`; no MX record is needed on a domain of your
  own. With a custom receiving domain instead you would add Resend's MX record to it and set
  `INBOUND_EMAIL_DOMAIN` to it, which changes every workspace's address.
- In the Resend dashboard create a **webhook**: endpoint `https://<your domain>/api/webhooks/resend`, event
  **`email.received`** only. Copy its signing secret into `/app` `RESEND_WEBHOOK_SECRET`.
- Create an **API key** that can read received emails and put it into `/app` `RESEND_API_KEY`; set
  `INBOUND_EMAIL_DOMAIN=<id>.resend.app`. Wait for the sync, then run *Deploy production*.
- The webhook receives **every** mail the whole Resend account receives. The route keeps only exactly
  `post-<token>@<id>.resend.app` with an existing, enabled token and answers everything else 200 without
  storing it, so the endpoint is never disabled for "failing". The production domain must be reachable without
  Vercel Deployment Protection (it is: protection only covers the staged `*.vercel.app` address).
- Check: open "E-Mail-Eingang" as admin, send a mail with a PDF from a team member's own mailbox to the address,
  and see the document in the inbox and the mail in the page's log. A sender on the allowlist must pass DMARC
  (or SPF and DKIM) or the mail is rejected as possibly forged.
- **Free tier**: 100 mails per day, shared by magic links and the E-Mail-Eingang's admin notices (at most one per
  workspace and reason per day). Enough for internal use; move to a paid plan before customers.
- **Data protection**: like Mistral, Resend stores incoming mail (body and attachments included) as a
  sub-processor with no DPA yet. Internal use with the company's own mail only, until the DPA is signed.

**Sentry** (optional): create a project, put its DSN into `/app` `SENTRY_DSN`. For source maps add
`SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT` (build-time only; an auth token is a secret). See
`src/platform/observability/README.md`. Remember that Sentry is a sub-processor too.

## 8. First deployment, step by step

Bring the pieces up in this order, so each can be checked alone.

1. **Local sanity**: on `development`, `pnpm verify` and `pnpm test:docker` pass.
2. **Neon**: create the project, the runtime role and the two URLs (section 6). Do not migrate by hand; the pipeline
   does it.
3. **Infisical**: create the project, folders `/ci` and `/app`, all keys of section 2, the machine identity and
   its role, and the Secret Sync (section 4). Check in the dashboard that the sync shows *synced*, and in the
   Vercel project that the variables arrived.
4. **Vercel**: project, region, Deployment Protection with the bypass secret, the domain, the token
   (section 5). Fill `/ci`.
5. **GitHub**: the environment `production` and its four secrets, branch protection, Actions settings
   (section 3). Verify the environment's branch policy with the two `gh api` commands.
6. **Dry-run the secrets**: run *Deploy production* by hand on `main` (Actions, *Run workflow*) only after steps
   1 to 5. If a key is missing or empty, the job that needs it stops with its name and the consequence
   (nothing is migrated or deployed). Fix and run again.
7. **Read the first run**: `fresh`, `migrate` (it should print the number of migrations it applied), `stage`
   (the summary shows the staged address), `health`, `promote`. If `health` fails, open the staged address in a
   browser with the bypass header (or temporarily view it in the Vercel dashboard) and read the runtime logs.
8. **Smoke test production by hand**: sign in with the address you put into `AUTH_BOOTSTRAP_EMAILS` (sign-up is
   by invitation only, decisions/0074), create a workspace, invite everyone else from the settings, then empty
   `AUTH_BOOTSTRAP_EMAILS` in Infisical. Then upload a PDF, check
   it is processed (with `MISTRAL_API_KEY` set, decisions/0073; without it processing fails with `ai_not_configured`).
   Confirm `/api/health` on the production domain answers `{ ok: true, version: "<short sha>" }`.
9. **Cron**: in the Vercel dashboard (Settings, Cron Jobs) check both jobs are listed, and after two hours that
   `process-jobs` ran with status 200. A 401 means `CRON_SECRET` is missing from the project's variables.

### The health check

`scripts/deploy/check.mjs` runs against the staged, domain-less address. It needs only Node (no `pnpm install`),
sends the bypass secret from the environment variable `DEPLOY_CHECK_BYPASS_SECRET` as the header
`x-vercel-protection-bypass` (only to an https `*.vercel.app` address, no redirect followed), and prints status
codes only. In order:

1. `GET /api/health` returns 200, `{ ok: true }` and `version` equal to the first seven characters of the commit
   being deployed. It retries a cold start or a waking database for about five minutes; it fails at once on a
   version mismatch (the staged build is not this commit) and on 401, 403 or a redirect (Deployment Protection
   did not accept the secret: check `VERCEL_APP_AUTOMATION_BYPASS_SECRET`).
2. `GET /` returns 200 and contains the landing page's brand name.
3. `GET /login` returns 200 and contains the German heading "Anmelden" (the UI is German-only,
   decisions/0013-german-ui-language.md; the earlier English "Sign in" check could never pass).
4. `GET /dashboard` without a cookie redirects to `/login`, proving the proxy guard and the layout's real session
   check are live.

It is read-only and never logs in, so it is safe against production too. It is unit-tested with an injected
`fetch` (`scripts/deploy/tests/check.test.ts`). It does not replace the Playwright suite, which runs in CI
against a throwaway database; the end-to-end specs sign in through a real mail inbox and write data, so they
cannot be pointed at a live deployment.

Why `APP_COMMIT_SHA` is passed with `vercel deploy --env` and not only set for the build: the application reads
it at run time (`serverEnv()`), and the build step's environment does not reach the run time of a prebuilt
deployment. The build step sets it too, harmlessly.

## 9. Releasing

1. Work on a branch off `development`; open a PR into `development`. CI runs the structure check, lint,
   typecheck, unit tests, build, database and integration tests, and the `@smoke` end-to-end set.
2. When `development` should ship, open a PR from `development` into `main`. CI runs everything, with the full
   end-to-end suite, on the merge result.
3. Merging it is the release. `deploy-production.yml` starts on the push to `main` (section 1). Watch the run;
   the `stage` job's summary shows the staged address, `record` closes the GitHub deployment `app-production`.
4. A migration always runs before the new code is staged, against the still-running previous version. That is
   safe only because migrations are **additive** (expand/contract):
   - **Expand** (add a table, a nullable column, a column with a default) ships first; the old code ignores it.
   - **Contract** (drop or rename a column) ships in a **later** release, once no deployed code reads the old
     shape. A rename is: add the new column, ship code that writes both and reads the new one, backfill, and
     drop the old column in a later release.
   - There are no down-migrations (`src/persistence/migrations/` is drizzle-kit generated). A bad migration is
     fixed forward with a new migration, never by editing an applied one.

   Nothing enforces "additive only"; review enforces it. A removal that the live version still uses, followed by
   a failed health check, leaves the live app on a schema it cannot use.

| Situation | What happens | What you do |
|---|---|---|
| `migrate` fails | The transaction rolls back, nothing is staged, production is unchanged | Fix forward with a new migration |
| `stage` or `health` fails | Production is unchanged, the migration stays applied (additive, harmless) | Fix and push, or re-run the failed jobs |
| `promote` fails | The staged deployment is not live | Re-run the failed job; if the cause is Vercel, promote the staged deployment from the dashboard |
| Production misbehaves after `promote` | Live | Roll back (section 10), then fix forward |

## 10. Rolling back

Actions, *Rollback production*, *Run workflow* on `main`, with `deployment` set to the deployment to restore: its
id (`dpl_...`) or its address (`https://....vercel.app`), from the Vercel dashboard or from the summary of an
earlier *Deploy production* run. The workflow first asks the Vercel API that the deployment is a **ready
production** deployment of **this project and team**, then runs `vercel rollback` with the pinned CLI.

- A rollback does not undo a migration. It is safe while the migrations since were additive (the previous version
  runs on a database that is ahead of it). A migration that has run is never undone.
- After a rollback Vercel stops assigning the production domain automatically to new deployments of the project;
  the `vercel promote` of the next *Deploy production* run assigns it again.
- The rollback workflow has a queue of its own (`rollback-production`), so an emergency rollback does not wait
  behind a deployment. It needs no approval: whoever can run a workflow on `main` can roll production back. The
  environment is restricted to `main`, which keeps other branches out.
- Rolling back does not stop a deployment that is running: if one is, both finish in whichever order, and the
  later one wins.
- On Pro every earlier production deployment can be restored, not only the previous one.

## 11. Operations

**Cron.** Both routes are `GET` with `Authorization: Bearer $CRON_SECRET`; a wrong or missing secret is a 401.
To run one by hand: `curl -H "Authorization: Bearer $CRON_SECRET" https://<domain>/api/cron/process-jobs`, with
the secret read from your own secret store. Only the production deployment gets crons. Logs: Vercel dashboard,
Logs, filter by the path.

**Rotating secrets.** Any secret that was ever in a log, a chat or an issue is rotated at once, the same way.

| Secret | How |
|---|---|
| `INFISICAL_CLIENT_SECRET` | Create a new Client Secret for the identity, update the GitHub environment secret, run *Deploy production* on an unchanged commit (a manual run with `allow_stale`) as a check, then revoke the old one. |
| `VERCEL_TOKEN` | Create a new token, update `/ci`, run a harmless check as above, revoke the old one. |
| `VERCEL_APP_AUTOMATION_BYPASS_SECRET` | Regenerate it in the project's Deployment Protection settings, update `/ci`, run *Deploy production*. It is used by the health check only. |
| `CRON_SECRET` | Change it in `/app`, wait for the sync, run *Deploy production*. Until the new deployment is live, cron calls are refused (401) and one sweep is lost; the next one, two hours later, covers it. |
| `DATABASE_URL_MIGRATE`, `MIGRATE_EXPECTED_HOST` | Change the owner role's password in Neon, update `/ci`. Nothing needs a redeploy. |
| `DATABASE_URL` (`app_runtime`) | Change the role's password in Neon (`alter role app_runtime password ...` as the owner), update `/app`, wait for the sync, run *Deploy production*. |
| `S3_*` | Create a new R2 token, update `/app`, deploy, revoke the old token. |
| `BETTER_AUTH_SECRET` | Not rotatable without a cost: it signs everybody out. Rotate only after a leak. |

**Backups.** See section 6, step 5: a documented requirement, not yet automated.

**Pausing deployments.** Disable the workflow `Deploy production` in Actions, or remove the environment's
secrets. There is no `DEPLOY_ENABLED` switch anymore.

## 12. Known limits and what is not verified

- **No workflow has run on GitHub yet.** `actionlint` finds nothing and `scripts/deploy/check.mjs` is unit
  tested, but unverified are: the `test-stack` composite action on the hosted runner (the `psql` client, `mc`
  inside the MinIO container), the Infisical and Vercel steps (they need the accounts), `vercel deploy --env`
  carrying `APP_COMMIT_SHA` to run time, the Vercel API answer the rollback check parses, and `vercel promote`
  for a project's very first production deployment (if it is refused, assign the domain from the dashboard once).
- **No `SCHEMA_BEHIND` signal.** The reference pipeline's `/api/health` also reports a database that lacks a
  migration of the deployed code. Here `migrate` runs first and fails the run, which covers the normal case, but
  an instance ahead of its database would only show up as failing requests. Adding the signal needs a read of
  `drizzle.__drizzle_migrations` (the runtime role has no privilege on it, `grants.sql`) and the bundled journal
  at run time. It is a follow-up.
- **No automatic rollback** after a successful `promote`. The rollback is a manual workflow.
- **No post-promotion check** of the production domain; the health check covers the staged deployment, which is
  the same build.
- **A single worker for Playwright** (`playwright.config.ts` divides the CPU count by four). The full suite on
  `main` is the slowest path of CI; raise the worker count deliberately if it matters.
- **No staging environment and no per-PR preview** (decisions/0073). The staged, domain-less production
  deployment is the only pre-production check.
- **The test stack is assembled twice** (`docker/compose.test.yml` and `.github/actions/test-stack`). A change to
  one needs the other.
- **Neon cold starts**: a suspended compute adds latency to the first request; the health check's retries cover
  it, a user's first request may feel it.
