// decisions/0074-sign-up-by-invitation-only.md: who may get a magic link, and who may get a new
// account. Pure functions over what `findSignInEligibility` reads, so the rule is unit-tested
// without a database.
/** What `findSignInEligibility` (`src/persistence/composition/auth-database.ts`) reports for an
 * address. Declared here too, structurally identical, because only `auth.ts` may import that seam. */
export type SignInEligibility = { hasAccount: boolean; hasPendingInvitation: boolean };

/** `AUTH_BOOTSTRAP_EMAILS`: a comma-separated list, lowercased and trimmed. Only meant for the
 * very first admin of a fresh database, whom nobody can invite. */
export function parseBootstrapEmails(raw: string | undefined): ReadonlySet<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0),
  );
}

/** A new account is created only for an invited address, or a bootstrap address. */
export function mayCreateAccount(email: string, eligibility: SignInEligibility, bootstrapEmails: ReadonlySet<string>): boolean {
  return eligibility.hasPendingInvitation || bootstrapEmails.has(email.trim().toLowerCase());
}

/** A magic link is mailed to an existing account, or to an address that may create one. Anyone
 * else gets the same "check your inbox" answer and no mail, so the form never reveals which
 * addresses have an account. */
export function mayReceiveMagicLink(email: string, eligibility: SignInEligibility, bootstrapEmails: ReadonlySet<string>): boolean {
  return eligibility.hasAccount || mayCreateAccount(email, eligibility, bootstrapEmails);
}
