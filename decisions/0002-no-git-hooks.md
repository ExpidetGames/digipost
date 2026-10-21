# No git hooks; the CI is the only gate

Document type: decision
Lifecycle: active
Owner: template maintainer
Scope: Whether local git hooks (husky, lefthook, lint-staged) run checks before commit/push
Canonical responsibility: Active source for why this repository has no git hooks
Maintenance triggers:
- A git hook or a hook-management tool is added to the repository
Last verified: 2026-09-14 against package.json (no husky/lefthook/lint-staged dependency)

## Status
Accepted

## Context

Multiple agents may work in this repository concurrently, in the same working directory
or in sibling worktrees (`AGENTS.md`, "Parallel-Agent Git Rules"). A pre-commit or
pre-push hook runs against the whole working tree, including another agent's
half-finished, unstaged changes, producing false red or false green results that have
nothing to do with the commit actually being made. Tools like lint-staged additionally use
`git stash` internally to set aside unstaged changes before running, which risks
displacing a concurrent agent's uncommitted work.

## Decision

No git hooks are installed (no husky, lefthook, or lint-staged), and none should be added.
Running `pnpm verify` (typecheck, lint, structure check once it exists, unit tests, per
WEBAPP_TEMPLATE_SPEC.md §11.1) before every PR is a documented rule in `AGENTS.md`,
enforced only by CI, never by a local hook. Protection against accidentally committed
secrets is `.gitignore` (`.env*` except `.env.example`), not a hook.

## Consequences

- Positive: no tool in this repository ever touches another agent's unstaged changes; a
  slow or misconfigured hook can never block or corrupt a commit made by a concurrent
  agent.
- Negative: nothing stops a local commit with failing checks; the only backstop is CI and
  a documented `AGENTS.md` rule that an agent or contributor must follow deliberately.
- Implementation status: **already true today**. `package.json`'s `verify` script
  (`pnpm typecheck && pnpm lint && pnpm test`, extended with a structure check and
  `verify:structure` once that lands) is in place as of this step (T1); no hook-management
  tool is a dependency and no `core.hooksPath` override exists.
