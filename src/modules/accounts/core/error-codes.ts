// Owner: src/modules/accounts (F2, decisions/0024-accounts-and-transactions.md). The Server
// Action layer's own error-code set, mirroring `src/persistence/use-cases/accounts-use-cases.ts`'s
// `ACCOUNT_ERROR` plus `invalid_input` (Zod parse failures) and `src/platform/access`'s
// `WorkspaceAccessErrorCode` - same pattern as `@/modules/documents/core/error-codes.ts`'s
// `DOCUMENT_ACTION_ERROR_CODES`.
export const ACCOUNT_ACTION_ERROR_CODES = [
  "invalid_input",
  "not_found",
  "duplicate_iban",
  "not_importable",
  "iban_locked_by_imports",
  "not_bank_account",
  "clearing_account_exists",
  "unauthenticated",
  "no_workspace",
  "forbidden",
  "unknown",
] as const;
export type AccountActionErrorCode = (typeof ACCOUNT_ACTION_ERROR_CODES)[number];
