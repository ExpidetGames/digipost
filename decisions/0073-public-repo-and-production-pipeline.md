# Public repository, GitHub-hosted CI, and a production-only release pipeline

Document type: decision
Lifecycle: active
Owner: .github/workflows, repository maintainer
Scope: Where CI runs for a public repository, which jobs it has and when each one runs, how a release
reaches production (migrate, stage, health check, promote, rollback), where the pipeline's secrets live,
and the repository's license
Canonical responsibility: Active source for why the self-hosted runner and the `CI_*` repository
variables are gone, why there is no staging environment, why the deployment secrets are read from
Infisical by a machine identity limited to one folder, and what the license says
Maintenance triggers:
- A job is added to or removed from `.github/workflows/ci.yml` or `deploy-production.yml`
- A second Vercel project, or a staging environment, is introduced
- The secret store, the machine identity's permissions or the GitHub environment `production` change
- The license changes, or the repository stops being public
Last verified: 2026-10-21, against `.github/workflows/*.yml`, `.github/actions/**`,
`scripts/deploy/check.mjs`, `vercel.json` and a local `actionlint` 1.7.12 run (no findings). The workflows
themselves have not run on GitHub yet; see "Verification".

## Status

Accepted and implemented. Supersedes decisions/0029-ci-on-a-small-self-hosted-runner.md and, in part,
decisions/0007-github-free-plan-ci-deviation.md (its points 3 and 4).

## Context

The repository is being published on GitHub as a public repository with a fresh history. That changes
three assumptions the earlier decisions rested on:

- **A self-hosted runner is unsafe.** decisions/0029 moved CI to a 4 GB self-hosted runner and switched the
  database, integration and end-to-end suites off, because GitHub-hosted minutes of a private Free-plan
  organization had run out. On a public repository a pull request from a fork runs workflow code chosen by the
  fork's author; on a machine of ours that is remote code execution on our infrastructure. GitHub-hosted
  runners for a public repository are free and ephemeral.
- **The Free-plan deviation no longer applies.** decisions/0007 compensated for a private repository without
  branch protection, required status checks or environment-scoped secrets. A public repository has all three,
  so `ci-passed` can be a real required check and the deployment secret can sit behind a GitHub environment
  restricted to `main`.
- **The deployment target is decided.** Production only, on Vercel Pro, Postgres at Neon (EU), files in
  Cloudflare R2, secrets in Infisical. The old `deploy.yml` described a staging plus production pair, switched
  off behind `DEPLOY_ENABLED`, with suffixed repository secrets, and was never run.

A second repository of the same owner already runs a pipeline of this shape in production (CI on
GitHub-hosted runners with a path filter, a release by pull request, a staged deployment promoted after a
health check, Infisical for secrets). This decision adopts it, adapted to a single Next.js project.

## Decision

1. **GitHub-hosted runners only (`ubuntu-24.04`).** The `CI_RUNNER` and `CI_DOCKER_SUITES` variables are
   removed. `actionlint` runs with an empty list of custom runner labels (`.github/actionlint.yaml`), so a
   workflow naming a self-hosted label fails CI.
2. **CI jobs** (`.github/workflows/ci.yml`): `changes` (`dorny/paths-filter`), `check` (typecheck, lint,
   structure check, unit tests, `pnpm build`, migration drift), `db` (`pnpm test:db` and `pnpm test:int`),
   `e2e` (Playwright against a production build), `actionlint` and `ci-passed`. Pull requests cancel their
   superseded run; pushes never do. Every job has a timeout, failure artifacts are uploaded only on failure,
   third-party actions are pinned by commit SHA, no job uses a secret.
   - A documentation-only pull request runs only the structure check (it validates governed Markdown); the
     other jobs skip. Pushes, manual runs and every pull request into `main` run everything.
   - Pull requests into `development` run the `@smoke` end-to-end set; everything else runs the full suite.
   - `ci-passed` (`if: always()`) fails on any failed or cancelled job and accepts skipped ones. It is the
     single required status check on `main` and `development`.
   - The nightly flake search of the old workflow is dropped (it was manual-only and switched off). A flaky
     test is found by re-running the e2e job.
3. **The database and integration suites run without Docker Compose.** `postgres:18` and
   `axllent/mailpit` are `services:` containers; MinIO (`pgsty/minio`, which needs `server /data` as its
   command, impossible in `services:`) is a `docker run` step. The composite action
   `.github/actions/test-stack` reproduces docker/compose.test.yml: the roles SQL of
   `docker/test-db-init/00_roles.sql`, `scripts/db/bootstrap-roles.mjs`, `migrate.mjs` and `seed.mjs`, the same
   dummy environment, and `DIGIPOST_TEST_STACK=1`, which the Vitest guard (`scripts/test/test-stack-guard.ts`)
   requires. decisions/0006 keeps `pnpm test:docker` as the local reference run; CI is a second, equivalent
   assembly of the same stack, not a replacement of it.
4. **A release is a pull request from `development` into `main`.** Merging it is the whole release. A push to
   `main` starts `.github/workflows/deploy-production.yml` (also startable by hand on `main`):
   `fresh` -> `migrate` -> `stage` -> `health` -> `promote` -> `record`.
   - Concurrency group `deploy-production`, never cancelled: a migration in progress runs to its end.
   - Every job is guarded by `github.repository == 'ExpidetGames/digipost' && github.ref == 'refs/heads/main'`.
     The guard only protects against accidents; the security boundary is the GitHub environment `production`,
     whose deployment branches are restricted to `main` (a setting no workflow can verify, so the setup guide
     says how to check it).
   - `fresh` and the start of `promote` refuse a commit that is no longer the head of `main`, so a re-run of an
     old run cannot put an older version over a newer one.
   - `migrate` runs `pnpm db:migrate --remote --expect-host=...` with the owner role's direct URL.
     `MIGRATE_EXPECTED_HOST` is a second, separately entered key in Infisical: deriving the expected host from
     the URL itself would compare the value with itself and guard nothing.
   - `stage` builds and uploads a production deployment without assigning the production domain
     (`vercel pull`, `env -u VERCEL_TOKEN vercel build --prod`, `vercel deploy --prebuilt --prod
     --skip-domain`). Dependencies are installed before the Vercel token is loaded, and the build runs without
     the token. The commit is passed to the deployment as the run-time variable `APP_COMMIT_SHA`
     (`vercel deploy --env`), because a variable set only in the build step does not reach a prebuilt
     deployment's run time; `/api/health` reports it as `version`.
   - `health` runs `scripts/deploy/check.mjs` against the staged address with the project's Protection Bypass
     for Automation secret. It fails at once on a version mismatch or a Deployment Protection rejection, and
     retries a cold start for about five minutes.
   - `promote` runs `vercel promote`. Production is untouched until then: a failure in any earlier job leaves
     the live deployment as it was.
   - The stage is **inline in the workflow, not a reusable workflow.** The reference repository has two
     Vercel projects and so reuses one staging workflow; here there is one project, and a reusable workflow
     would only add the need to pass the four Infisical secrets across the call boundary.
5. **Rollback is a manual workflow** (`rollback-production.yml`, own concurrency group). It checks with the
   Vercel API that the given deployment is a ready production deployment of this project and team, then runs
   `vercel rollback`. It does not undo a migration; migrations are additive (expand first, contract in a later
   release, `scripts/deploy/README.md`).
6. **Secrets: Infisical, one least-privilege machine identity, four GitHub environment secrets.** The only
   GitHub secrets are `INFISICAL_CLIENT_ID`, `INFISICAL_CLIENT_SECRET`, `INFISICAL_DOMAIN` and
   `INFISICAL_PROJECT_SLUG`, secrets of the environment `production` and not variables (a public repository's
   variables are world-readable). The composite action `infisical-ci-secrets` reads named keys from
   `prod:/ci` one by one, masks them and fails on an empty value; the identity can read nothing else. `/ci`
   holds `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_APP_PROJECT_ID`, `VERCEL_APP_AUTOMATION_BYPASS_SECRET`,
   `DATABASE_URL_MIGRATE` and `MIGRATE_EXPECTED_HOST`. `prod:/app` holds the runtime variables and reaches
   Vercel Production by Infisical Secret Sync, so `vercel pull` brings them to the build. No workflow uses
   `secrets: inherit`.
7. **The Vercel CLI is pinned with its dependency tree** in `scripts/vercel/` (`package.json` and an npm
   lockfile, `npm ci --ignore-scripts`). It lives under `scripts/` and not a new top-level `tools/` because
   STRUCTURE.md declares `scripts/` as the repository's tooling root. The root `pnpm-lock.yaml` is untouched.
8. **Cron runs on Vercel Pro.** `GET /api/cron/process-jobs` runs every two hours (`0 */2 * * *`) and
   `GET /api/cron/purge-rejected-intake` stays daily (`0 3 * * *`). Vercel sends `Authorization: Bearer
   $CRON_SECRET` when `CRON_SECRET` is set, which is exactly what `requireCronSecret` checks. The functions
   run in `fra1`, next to the EU database.
9. **License: all rights reserved.** `LICENSE` is a proprietary notice ("published for transparency only");
   `package.json` says `"license": "UNLICENSED"` and stays `"private": true`. Viewing and forking on GitHub is
   permitted by GitHub's Terms of Service and nothing more. The copyright holder is named "the Digipost
   authors" until the legal entity is put in.
10. **Repository settings that are not code** (documented in `scripts/deploy/README.md`, not enforceable from
    a workflow): branch protection on `main` and `development` requiring `ci-passed`; the Actions setting
    "Require approval for all outside collaborators"; the environment `production` limited to `main`.

### Mistral for internal use

decisions/0016 blocks real (non-fake) production traffic to Mistral until a DPA is signed. For the internal
deployment this pipeline serves, the owner decided to set `MISTRAL_API_KEY` anyway: only the company's own
incoming mail is processed, and the risk is accepted knowingly. The block stays in force for every external
customer: no other company's documents are processed through Mistral before the DPA is signed and the privacy
policy is reviewed.

## Consequences

- Positive: the database, integration and end-to-end suites run in CI again, so CI no longer rests on a
  contributor remembering to run `pnpm test:docker`. A fork pull request runs only on ephemeral GitHub-hosted
  machines with a read-only token and no secret. A bad deployment is caught while it is still domain-less.
- Positive: nothing in the repository is a secret or an identifier; the four environment secrets only let a run
  on `main` ask Infisical for the `/ci` folder.
- Negative: the CI minutes of a public repository are free but not unlimited in time; a run is aimed at under
  fifteen minutes per pull request, which the path filter and the smoke-only end-to-end set are there for.
- Negative: the end-to-end job uses Playwright's default of one worker (`playwright.config.ts` divides the CPU
  count by four). If the full suite on `main` becomes the slowest path, raise the worker count deliberately; do
  not raise retries.
- Negative: the staged check cannot detect "the migration did not reach this database" by itself. The `migrate`
  job runs first and fails the run if it fails, which covers the normal case; a `SCHEMA_BEHIND` signal in
  `/api/health` (comparing the newest applied migration with the newest bundled one, as the reference does) is
  a follow-up, because the runtime role has no privileges on the migration table today.
- Negative: no automatic rollback when `promote` succeeded but production misbehaves afterwards; the rollback
  workflow is manual by design.
- Two copies of the test stack's setup exist (docker/compose.test.yml and the composite action). A change to
  one needs the other; both say so.

## Alternatives considered

- **Keep the self-hosted runner for private jobs and use hosted ones for forks.** Rejected: a workflow cannot
  reliably keep fork code off a self-hosted runner, and the only safe rule is not to have one.
- **Keep Docker Compose in CI (`pnpm test:docker`).** Rejected: it builds three images and a Playwright image
  of about 5 GB per run, which is slow and cache-hostile on a fresh runner; service containers start in
  seconds.
- **A staging environment.** Rejected by the owner: the staged, domain-less production deployment plus the
  health check covers "does this build start against the real configuration" without a second set of
  databases, buckets and secrets.
- **Vercel's Git integration.** Rejected: it would deploy before the migration and before CI, and it cannot
  gate a promotion on a health check. `vercel.json` keeps `"git": { "deploymentEnabled": false }`.
- **GitHub secrets for every deployment value.** Rejected: rotating a Vercel token or the migrate URL would
  mean editing GitHub; with Infisical a rotation is one write, and the application's runtime variables are
  already synced from the same place.

## Verification

- `actionlint` 1.7.12 over every workflow and local action: no findings (run without shellcheck, which CI's
  `actionlint` job adds).
- `scripts/deploy/tests/check.test.ts` (unit): argument parsing, the rule that the bypass secret only goes to
  an https `*.vercel.app` address, the health verdict, retrying a cold start, failing at once on a
  Deployment Protection rejection or a version mismatch, the German sign-in heading, the dashboard redirect.
- Not verified: no workflow has run on GitHub. In particular unverified are the `test-stack` composite action
  against the hosted runner image (the `psql` client, MinIO's `mc` inside the container), the Infisical and
  Vercel steps (they need the accounts), `vercel deploy --env` carrying `APP_COMMIT_SHA` to run time, and the
  Vercel API response of the rollback check. The first release run is the test; the setup guide lists the
  order in which to bring the pieces up so that each can be checked alone.
