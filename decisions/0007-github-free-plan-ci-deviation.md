# GitHub Free-plan deviation: no branch protection, no environment-scoped secrets

Document type: decision
Lifecycle: active
Owner: template maintainer
Scope: CI/CD enforcement given a private repository on GitHub's Free plan
Canonical responsibility: Active source for how this template's CI compensates for a lack
of branch protection, required status checks, and GitHub Environments on the Free plan
Maintenance triggers:
- The GitHub plan hosting a project built from this template changes tier and gains branch
  protection / environments
- The CI workflow structure changes
Last verified: 2026-09-14 against .github/workflows/ci.yml (T6a)

## Status
Superseded in part by decisions/0073-public-repo-and-production-pipeline.md: the repository is
public, so branch protection, required status checks and GitHub Environments are available and are
used; points 1 and 2 (the `ci-passed` aggregate, no secret in the test jobs) still hold, points 3
and 4 no longer apply.

## Context

WEBAPP_TEMPLATE_SPEC.md's CI and deployment design (§11.3, §13.3) assumes GitHub
Environments with per-environment secrets and a required `ci-passed` status check gating
merges. A private repository on GitHub's Free plan has none of that: no branch protection
rules, no required status checks, and no environment-scoped secrets. Without those,
nothing on GitHub's side stops a merge on red CI, and there is no environment boundary to
scope deployment secrets to a branch. A project built from this template on a paid plan or
a public repository does not have this constraint and can use the spec's design directly.

## Decision

1. A single aggregate job (`ci-passed`, `needs: [...], if: always()`) still exists once CI
   is built, exactly as WEBAPP_TEMPLATE_SPEC.md §11.3 rule 1 describes, so there is one
   job a human (or a required-check setup on a plan that supports it) can look at.
2. Every CI job that needs a database or SMTP runs entirely against the hermetic Docker
   test stack (`decisions/0006-docker-test-stack-as-reference.md`), never against a hosted
   database, so it needs no repository- or environment-scoped secret to run correctly on
   any plan tier.
3. When deployment automation (WEBAPP_TEMPLATE_SPEC.md §13) is built on a Free-plan
   project, its equivalent of per-environment secrets uses suffixed repository secrets
   (for example, a staging and a production variant of the same secret name) plus an
   explicit branch check inside the workflow, and `--expect-host` as the hard guard
   against a migration running against the wrong database.
4. Without required status checks, "run `pnpm verify` before every PR" (`AGENTS.md`,
   `decisions/0002-no-git-hooks.md`) is enforced socially, by the contributor and by
   review, not mechanically by GitHub. A project that moves to a plan with branch
   protection should wire `ci-passed` into it immediately.

## Consequences

- Positive: the test suite's correctness does not depend on the plan tier at all; nothing
  in this pipeline needs a hosted database credential, so there is nothing to leak through
  it.
- Negative: nothing currently stops a merge with failing CI on the Free plan; that
  discipline is social/manual rather than mechanical until a project either upgrades plan
  tier or builds the suffixed-secrets workaround for deployment.
- Implementation status: **partially implemented**. `.github/workflows/ci.yml`
  exists with the `ci-passed` aggregate job (point 1) and every DB/SMTP-needing job
  running against the hermetic Docker test stack with zero repository secrets (point 2),
  per README.md "CI". Point 3 (suffixed per-environment secrets) is implemented by
  `.github/workflows/deploy.yml` (`STAGING_*`/`PRODUCTION_*` repository secrets and
  variables, see `scripts/deploy/README.md`); the workflow ships switched off behind the
  repository variable `DEPLOY_ENABLED`. Point 4 (branch protection once available)
  remains **planned**: this repository has not moved to a plan tier with branch
  protection.
