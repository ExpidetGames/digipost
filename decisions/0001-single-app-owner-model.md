# Single Next.js app with an owner-model layout (modules/shared/platform/persistence)

Document type: decision
Lifecycle: active
Owner: template maintainer
Scope: Repository shape: one deployable app versus a workspace, and the top-level owner
categories that organize code inside it
Canonical responsibility: Active source for why this repository is a single Next.js app
with `modules/`, `shared/`, `platform/`, and `persistence/` as its owner categories
Maintenance triggers:
- A second deployable (a separate marketing site, a mobile API) is proposed
- A new top-level owner category is proposed
Last verified: 2026-09-14 against WEBAPP_TEMPLATE_SPEC.md §3, §4, §16

## Status
Accepted

## Context

A new project could start as a pnpm workspace (`apps/web`, `apps/marketing`, ...) or as a
single Next.js app with marketing pages as a route group. A workspace adds real value once
a piece of the product has its own release cycle, its own deploy target, or its own
dependency set that would otherwise bloat the main app; none of that is true on day one of
a template.

Within a single app, code still needs boundaries. Four owner categories cover every kind
of code a typical product needs: a feature capability, code shared by more than one
capability, framework/provider infrastructure, and the database layer.

## Decision

1. The template is one deployable Next.js app. Marketing pages live under
   `app/(marketing)/` as a route group in the same app as the authenticated dashboard, not
   as a separate deployable. A second deployable is added later, only once a concrete need
   for an independent release cycle or dependency set exists.
2. All non-Next-seam code lives under one of four owner categories:
   - `modules/<capability>/`: one fachliche capability (UI, Server Actions, read models,
     core vocabulary, tests, README). Split a module when a part gets its own vocabulary,
     its own permissions, or its own reasons to change.
   - `shared/<purpose>/`: neutral code with at least two real, independently existing
     consumers, counted in that owner's README. Never imports `modules/` or `app/`.
   - `platform/<concern>/`: app-wide framework/provider infrastructure with a named
     responsibility. Not a renamed `lib/`; capability-specific provider logic stays in its
     module.
   - `persistence/`: schema, migrations, repositories, use cases, and the composition
     root, in strict internal layers (see the persistence ADRs once they land).
3. `app/` holds only Next.js seams (`page`, `layout`, `route`, `loading`, `error`, ...)
   that delegate to an owner; it is never itself an owner of business logic.
4. No `components/`, `lib/`, `server/`, `utils/`, `services/`, or `docs/` folder, and no
   generic `tests/` folder at the repository root. A structure checker (planned, see
   WEBAPP_TEMPLATE_SPEC.md §11.5) will enforce this mechanically; until it lands, this is
   a documented rule in `AGENTS.md`.

## Consequences

- Positive: placement has one small decision tree (WEBAPP_TEMPLATE_SPEC.md §4.4) instead
  of an ad hoc `lib/`/`utils/` catch-all; a reader can find any piece of business logic by
  asking which capability, shared concern, or platform concern owns it.
- Negative: a single app means a slow build in one area (e.g. a large marketing content
  set) affects the whole app's build time; splitting into a workspace later requires
  moving code across a new package boundary.
- Implementation status: `shared/ui-primitives/` (T1), `persistence/` (T2: schema,
  foundation, repositories, use-cases, composition, per its own README), and, as of T3,
  `platform/auth`, `platform/mailer`, and the first `modules/` owner (`modules/sign-in`) are
  populated. The structure checker that would enforce owner boundaries mechanically is still
  **planned**, not built.
