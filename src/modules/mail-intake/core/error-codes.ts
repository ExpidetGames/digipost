// Stable error codes (AGENTS.md "Code": `as const` sets, never raw text). `ui/*.tsx` maps them
// to `MailIntake.errors` in `de.json`. Mirrors `src/persistence/use-cases/mail-intake-use-cases.ts`'s
// `MAIL_INTAKE_ERROR` plus `invalid_input` (a Zod parse failure in `actions.ts`), the
// `WorkspaceAccessErrorCode`s `requirePermission` returns, and `unknown`.
export const MAIL_INTAKE_ACTION_ERROR_CODES = [
  "invalid_input",
  "invalid_sender_entry",
  "sender_already_allowed",
  "too_many_allowed_senders",
  "not_found",
  "unauthenticated",
  "no_workspace",
  "forbidden",
  "unknown",
] as const;
export type MailIntakeActionErrorCode = (typeof MAIL_INTAKE_ACTION_ERROR_CODES)[number];
