# Structure checker with its own self-contained import resolver

Document type: decision
Lifecycle: active
Owner: template maintainer
Scope: How `pnpm verify:structure` (`scripts/structure/**`, task T6b) resolves
imports, and why it is a full, self-contained implementation of
`WEBAPP_TEMPLATE_SPEC.md` §11.5's checker rather than a thinner layer over an
existing import-graph guard-test library
Canonical responsibility: Active source for why `scripts/structure/lib/module-graph.ts`
exists as its own module instead of reusing a pre-existing one, and for how
`STRUCTURE.md`'s ```structure blocks relate to the rule modules that interpret them
Maintenance triggers:
- `scripts/structure/lib/module-graph.ts`'s exported shape changes in a way any rule
  module depends on (`walkGraph`, `resolveImport`, `repoSourceFiles`, `chain`,
  `isToolingFile`)
- A second import-graph guard-test suite is added elsewhere in this repository that
  duplicates, rather than reuses, this resolver
Last verified: 2026-09-15, T6b (structure checker delivered)

## Status
Accepted

## Context

`WEBAPP_TEMPLATE_SPEC.md` §2.7/§11.5/§17 step 5 describes a structure checker ported
from Tablepay's `scripts/structure/**`, interpreting `STRUCTURE.md`'s machine-readable
```structure blocks to enforce roots, entrypoints, dependency direction, persistence
layering, tests placement, documentation, env-variable confinement, and vendor-SDK
confinement. The spec itself estimates the vanilla port at roughly 1,600 lines and
offers an alternative for projects that already have their own import-graph
guard-test code: build the checker's rules on top of that existing resolver instead
of copying the whole thing (§2.7's exact wording, also cited in
`decisions/0001-single-app-owner-model.md`'s implementation list).

This template has no such pre-existing resolver. Its `tests/` root does not exist at
all in this repository's actual shape (`decisions/0001`'s owner-model layout uses
`e2e/` and `integration-tests/` as separate top-level roots plus owner-local
`modules/*/tests/`, `shared/*/tests/`, `platform/*/tests/`, `persistence/tests/`
directories instead of one shared `tests/` root), and no guard-test suite in this
repository has ever needed to walk the module import graph before this task. There is
therefore no existing "reuse instead of port" option available the way there would be
for a project descended from something like Deeplify's `tests/guards/lib/module-graph.ts`.

## Decision

`scripts/structure/lib/module-graph.ts` is a small, purpose-built static
module-graph walker (`walkGraph`, `resolveImport` with `@/`-alias support, `chain`
for readable import-chain error messages, `repoSourceFiles`, `isToolingFile`),
written specifically for this checker and owned by it. Every rule module that needs
import resolution (`direction`, `persistence`, `request-services`, `env-access`,
`vendor-sdk`, `e2e`) imports this one file rather than each rolling its own
resolution logic, so a future change to how imports resolve (a new path alias, a new
resolvable extension) only needs to be taught to one place.

Everything else in `scripts/structure/**` is new code, not a line-for-line port of
Tablepay's implementation, since this template's actual roots, owner conventions, and
dependency directions differ from the vanilla spec's worked examples in several
concrete, documented ways (`STRUCTURE.md` §0's "not a byte-for-byte copy" framing):
one `e2e/` root plus one `integration-tests/` root instead of a shared `tests/` root,
route handlers (and their co-located `route.test.ts` unit tests, §7/§8) allowed
anywhere under `app/`, `platform/env`'s actual centralization of `process.env` access
through `serverEnv()` rather than scattered direct reads, and a named exemption list
for the Sentry/Next.js instrumentation file family
(`decisions/0009-sentry-config-files-read-process-env-directly.md`) reflected
directly in the `env-access` rule's table.

`pnpm verify:structure` runs `scripts/structure/verify-structure.ts` via `tsx` (one
new devDependency), not plain `node` on a `.ts` file directly. Node's native
TypeScript execution requires every relative import to carry an explicit `.ts`
extension in the source, which conflicts with the root `tsconfig.json`'s
`moduleResolution: "bundler"` (`tsc --noEmit`, run by `pnpm typecheck`, rejects a
`.ts`-extension import with `TS5097` unless `allowImportingTsExtensions` is set);
`tsconfig.json` is a shared root config file this task does not own changing.
`tsx` resolves ordinary extensionless relative imports, matching every other
TypeScript file in this repository, without that conflict.

## Consequences

- Positive: `scripts/structure/**` has one resolver, used consistently by every rule
  that needs it; a bug fix or a new alias only needs to land once.
- Positive: no dependency on a second codebase's guard-test internals that this task
  does not own - `scripts/structure/**` is fully self-contained under the one root
  this task was assigned.
- Negative: this is a smaller, purpose-fit implementation rather than a byte-for-byte
  port of Tablepay's ~1,600-line checker; a future engineer comparing this
  implementation against Tablepay's or against a sibling project's (e.g. one that did
  have a pre-existing resolver to build on) will find a differently-shaped codebase,
  even though the `STRUCTURE.md` surface (fenced ```structure blocks, rule names,
  violation format) is deliberately kept recognizable across both approaches.
- Negative: one new devDependency (`tsx`), purely a consequence of `tsconfig.json`
  being outside this task's assigned files (see Decision above); every source file
  otherwise uses ordinary extensionless TypeScript imports, so this is confined to
  how the entry script is invoked.
