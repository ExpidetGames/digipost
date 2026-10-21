// Owner: src/modules/payments (F3b, decisions/0025-payment-matching-wiring.md). The Server
// Action layer's own error-code set, mirroring
// `src/persistence/use-cases/payments-use-cases.ts`'s `PAYMENT_ERROR` plus `invalid_input`
// (Zod parse failures) and `src/platform/access`'s `WorkspaceAccessErrorCode` - same pattern
// as `@/modules/accounts/core/error-codes.ts`'s `ACCOUNT_ACTION_ERROR_CODES`.
export const PAYMENT_ACTION_ERROR_CODES = [
  "invalid_input",
  "not_found",
  "already_decided",
  "cross_direction",
  "amount_exceeds_open",
  "amount_exceeds_transaction",
  "unauthenticated",
  "no_workspace",
  "forbidden",
  "unknown",
] as const;
export type PaymentActionErrorCode = (typeof PAYMENT_ACTION_ERROR_CODES)[number];
