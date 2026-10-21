# CI on a small self-hosted runner: Docker suites off by default

Document type: decision
Lifecycle: active
Owner: .github/workflows, repository maintainer
Scope: Which CI jobs run on every push and pull request after the repository moved from
GitHub-hosted runners to a small self-hosted runner, how the runner is selected, and where
the database, integration and end-to-end suites are verified instead
Canonical responsibility: Active source for why `db`, `e2e-pr`, `e2e-full` and `nightly` are
switched off by default, which repository variables switch them and the runner back, and what
that means for the safety net in front of a merge
Maintenance triggers:
- The self-hosted runner's hardware changes, or the repository moves back to GitHub-hosted
  runners
- A job is added to `.github/workflows/ci.yml`
- The `CI_RUNNER` or `CI_DOCKER_SUITES` repository variables are renamed or removed
Last verified: 2026-09-21, when the org's GitHub-hosted minutes ran out

## Status
Superseded by decisions/0073-public-repo-and-production-pipeline.md: the self-hosted runner is
retired (a public repository must never run fork pull requests on it), `CI_RUNNER` and
`CI_DOCKER_SUITES` are removed, and the database, integration and end-to-end suites run in CI again
on GitHub-hosted runners.

## Context

The organization is on GitHub's Free plan with a private repository, so every workflow minute
is billed against a monthly allowance shared with the org's other repositories, including their
deployment workflows. That allowance ran out: GitHub stopped starting jobs with "The job was not
started because recent account payments have failed or your spending limit needs to be
increased", and every pull request went red for a reason that had nothing to do with the code.

Measured cost per run before that happened: `check` about 2 minutes, `db` about 2 minutes,
`e2e-full` about 6 minutes, so roughly 6 to 10 minutes per push or pull request. That is cheap
per run and still adds up across an org.

A self-hosted runner removes the billing problem entirely (GitHub bills only its own runners),
and one is available on an existing small server. That server has **4 GB of RAM and 100 GB of
disk**, which is the constraint this decision is really about:

- `check` (install, typecheck, lint, structure check, 1494 unit tests, a production `next build`,
  migration drift) fits, with `next build` as the memory peak.
- `db` and the three e2e jobs do not. `pnpm test:docker` starts Postgres, MinIO and Mailpit;
  `pnpm test:e2e:docker` additionally builds and runs a production Next.js server plus a
  Playwright browser image of about 5 GB. On a 4 GB machine that is not a tuning problem, it is
  the wrong machine.

## Decision

1. **Runner selection is a repository variable.** Every job uses
   `runs-on: ${{ vars.CI_RUNNER || 'ubuntu-latest' }}`. Unset, the workflow behaves exactly as
   before; set to the self-hosted runner's label, everything moves there. `deploy.yml` uses the
   same variable, so both workflows follow one switch.
2. **The four Docker-based jobs are gated behind `CI_DOCKER_SUITES`** and skip unless it is
   `true`. `ci-passed` already treats a skipped job as acceptable, so it stays meaningful as the
   single job to look at.
3. **`check` is tuned for the small machine**: `NODE_OPTIONS=--max-old-space-size=2560` keeps
   `next build`'s V8 heap out of swap, and its timeout goes from 15 to 40 minutes because an
   ephemeral self-hosted runner installs dependencies from scratch on every run and the machine
   is slower than a GitHub-hosted VM.
4. **`actions/setup-node` runs before `pnpm/action-setup` in every job.** A self-hosted
   runner image ships its own system Node, and that runner image's is old enough that
   pnpm's self-installer dies with `Cannot find module 'node:path'`. Installing `.nvmrc`'s
   Node 24 first fixes it. The `cache: pnpm` option is dropped for the same ordering reason:
   it resolves the pnpm store path and therefore needs pnpm, which is not installed yet at
   that point. GitHub-hosted runners were unaffected, which is why this only surfaced now.
5. **The database, integration and e2e suites move to the developer's machine before a pull
   request.** `AGENTS.md`'s workflow step 6 already requires exactly that; from now on it is the
   only place those suites run, not a second opinion after CI.

## Consequences

- Positive: CI runs again, at no per-minute cost, and the fast feedback that catches most
  regressions (types, lint, structure, 1494 unit tests, a real production build, migration
  drift) still runs on every push and pull request.
- Positive: switching back is two repository variables, not a code change. A larger runner only
  needs `CI_DOCKER_SUITES=true`.
- **Negative, and the point of this document: the automated safety net in front of a merge is
  now thinner.** Nothing in CI proves any more that the schema matches real Postgres, that a
  migration applies, that the intake and accounts paths work against MinIO, or that a user flow
  still works in a browser. A regression that only those suites catch can reach `main`. The
  mitigation is discipline, not tooling: run `pnpm test:docker` and `pnpm test:e2e:docker`
  locally before opening a pull request, exactly as `AGENTS.md` requires.
- Negative: a self-hosted runner executes repository code on the owner's own server. This is
  acceptable here because the repository is private and every committer is trusted; it would not
  be acceptable for a public repository, where a fork's pull request could run arbitrary code.
  Workflow changes should therefore stay as scrutinized as application code.
- Neutral: with one runner, jobs that used to run in parallel now queue. With `check` as the only
  enabled job this is not noticeable today.

## Supersedes / Superseded By
- Complements `decisions/0007-github-free-plan-ci-deviation.md` (no branch protection, no
  required status checks on this plan tier). Neither supersedes the other: 0007 explains why
  `ci-passed` is not enforced, this one explains why it now covers less.
