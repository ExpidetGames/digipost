# Several workspaces per user, and the cookie that never grants anything

Document type: decision
Lifecycle: active
Owner: src/platform/access
Scope: Membership cardinality, how the active workspace is resolved, and the switcher
Canonical responsibility: Active source for how a request decides which workspace it is in
Maintenance triggers:
- A second place starts resolving the active workspace (there must not be one)
- The fallback order changes
- Workspaces gain anything shared across them (today nothing is)
Last verified: 2026-10-03, measured on a development workspace

## Status

Accepted. Replaces the one-workspace-per-user rule of
decisions/0014-workspaces-and-access.md.

## Context

A user may run more than one company and wants one login, strictly separated data. The
product enforced one workspace per user in four places, one of them a database constraint
(`workspace_members.userId` unique, commented "A user belongs to exactly one workspace
(PRD)"), the others `resolveAccess`, the `/onboarding` bounce, and invitation acceptance.

Everything else was already multi-tenant: documents, accounts, payments, contacts, billing and
jobs all carry `workspace_id` and filter on it. Only the membership cardinality and the
resolution were single-tenant, which is why this is a change at four seams rather than a
rewrite.

## Decision

**A user may hold any number of memberships**, at most one per workspace (migration 0021: the
unique on `user_id` dropped, a composite unique on `(workspace_id, user_id)` added, plus a
plain `user_id` index because the dropped constraint was also the index every by-user lookup
used and `resolveAccess` now runs one on every request). The one-admin-per-workspace rule is
untouched.

**The active workspace is decided in exactly one place**, `resolveAccess`. Everything else
(the page guard, the Server Action guard, the api-pipeline access step) already built on it.

**The cookie selects, it never grants.** `digipost.active_workspace` is httpOnly, sameSite
lax, secure in production. On every request `resolveAccess` reads the caller's memberships
from the database and uses the cookie's id ONLY if it appears among them; otherwise it falls
back to the oldest membership. A forged, stale or foreign cookie is therefore
indistinguishable from no cookie at all, and never reveals whether the workspace it names
exists. A value that is not a syntactically valid uuid is dropped before any query, because
comparing a malformed uuid against a `uuid` column is a Postgres error, and an error is an
oracle.

This is the rule AGENTS.md already states, applied to a new kind of input: the workspace comes
from the resolved session membership, never from client input. The cookie is client input; the
membership lookup is the gate.

**Writing the cookie is a Server Action** (`cookies().set()` cannot run while rendering) and
verifies the membership before writing, storing the id the database returned rather than the
one the client sent. "Not a member" and "does not exist" both answer `not_found`.

**The fallback is the oldest membership**, ordered by `joined_at` then `id`, a total order, so
it cannot flip between two requests. This is also why the owner's existing workspace stays
active with no cookie present.

**Nothing is shared between workspaces.** Tier and quota already live on the workspace, so a
second company starts free with its own quota.

## Consequences

- Leaving or deleting the active workspace lands on another of the caller's workspaces, or on
  `/onboarding` when none is left; the cookie is rewritten or cleared accordingly.
- A member removed from a workspace keeps a cookie naming it until their next request, where
  it degrades to their fallback. There is no server-side session invalidation in this codebase
  to push it sooner, and none is needed: the cookie grants nothing.
- **Submitting `/onboarding` twice can now create two workspaces.** The dropped unique on
  `user_id` used to make the second one fail. Nothing replaces it, because a brand-new
  workspace cannot collide with anything. Accepted for now: the cost is a stray empty
  workspace the owner can delete, and any guard (name-based, time-window) would be a new rule
  invented to patch a double click.
- `decisions/0014` and `decisions/0015` still describe the single-workspace model in prose.
  This ADR supersedes them on that point.

## Verification

Measured against a real development workspace rather than only in tests: creating a second workspace
for the same user yields a free-tier workspace with 0 documents and 0 accounts while the first
keeps its existing ones; asking the second workspace for a document id belonging to the first
returns null; the membership list comes back oldest first, so the existing workspace
remains the fallback and stays active.

## Alternatives considered

- **An active workspace column on the user.** Rejected: it makes a per-browser choice global
  to the account, so two tabs or two devices fight over it, and it turns a display preference
  into persisted state that has to be migrated and cleaned up.
- **The workspace id in the URL** (`/w/<id>/dashboard`). Honest and shareable, and rejected for
  now: it rewrites every route and every link in the product, and it puts the tenant in a
  place where forgetting one scope check becomes a cross-tenant read rather than a 404.
