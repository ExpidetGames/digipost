# Sign-up by invitation only

Document type: decision
Lifecycle: active
Owner: src/platform/auth
Scope: Who may receive a magic link and who may get a new account
Canonical responsibility: Active source for the sign-up rule and its bootstrap exception
Maintenance triggers:
- A second way to create an account appears (another Better Auth plugin, an admin "create user")
- Invitations change shape (expiry, acceptance, normalization of the address)
- Self-service sign-up for external customers becomes a product goal
Last verified: 2026-10-21, against the local dev stack (a stranger's request returns the usual answer and no
mail; an existing account gets its link) and the unit tests named under "Verification"

## Status

Accepted. Narrows decisions/0005-better-auth-magic-link-drizzle-adapter.md, where any address that clicked its
magic link got an account.

## Context

Digipost goes into production for internal use, on a public domain. With magic-link sign-in as it was, anyone
could enter any address, receive a link and get an account, and from there create a workspace of their own. The
owner's rule: people who are already in may sign in and invite others; people who are not, may not.

## Decision

- **An existing account** receives its magic link and signs in as before.
- **A new account** is created only for an address with a pending, unexpired invitation from any workspace
  (`workspace_invitations` with `accepted_at` null and `expires_at` in the future), compared case-insensitively.
  An invited person signs in through the normal login form or the invitation page, which creates the account, and
  then accepts the invitation.
- **Bootstrap exception:** `AUTH_BOOTSTRAP_EMAILS`, a comma-separated list, may create an account without an
  invitation. It exists only for the first admin of a fresh database, whom nobody can invite. It should be empty
  once that admin exists.
- **Everyone else** gets exactly the same "check your inbox" answer, worded "Falls für ... ein Konto oder eine
  Einladung besteht", and no mail. The form does not reveal which addresses have an account.

Two checks enforce this (`src/platform/auth/server/auth.ts`, rules in `server/sign-up-gate.ts`, the read in
`src/persistence/composition/auth-database.ts`'s `findSignInEligibility`):

1. `sendMagicLink` returns without mailing when the address has no account, no invitation and is not a bootstrap
   address. This keeps strangers from receiving anything at all.
2. Better Auth's `databaseHooks.user.create.before` throws `SIGNUP_NOT_ALLOWED` for the same addresses. This is
   the hard guarantee: a link minted while an invitation was still pending, and revoked since, cannot create the
   account, and neither can any future path into user creation. The magic-link verify endpoint turns the error
   into `/login?error=SIGNUP_NOT_ALLOWED`, which the login form explains in German.

The eligibility read touches `workspace_invitations`, which `src/modules/workspaces` owns. It is a read, never a
write, and it lives in the auth-database seam because `src/platform/auth` may import nothing else from
persistence.

## Consequences

- An expired invitation no longer lets its address in: the inviter sends a new one.
- A person removed from every workspace keeps their account and can still sign in; they land on onboarding and
  could create a workspace of their own. Closing that is a separate decision (deleting the account, or limiting
  workspace creation).
- The rate limit still counts a stranger's request, so the form behaves the same under abuse.

## Verification

- `src/platform/auth/tests/sign-up-gate.test.ts`: the rule (account, invitation, bootstrap, stranger).
- `src/persistence/tests/sign-in-eligibility.db.test.ts`: case-insensitive account lookup, and only a pending,
  unexpired invitation counts.
- `tests/e2e/serial/auth.spec.ts`: an invited address signs up through the real magic link, an existing account
  signs in, and an unknown address gets the same answer and no mail.
