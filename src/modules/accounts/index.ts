// Neutral entrypoint of src/modules/accounts (WEBAPP_TEMPLATE_SPEC.md §4.2): pure domain
// logic only (no I/O, no `server-only`, no `"use client"`) - safe to import from
// `src/persistence/use-cases/accounts-use-cases.ts` and this module's own `actions.ts`/`ui/`.
export type { ImportableStatement, ImportableTransaction, ImportOutcome } from "./core/types";
export { mapCamt053StatementsToImportable, mapTabularRowsToImportable, summarizeStatementsForBatch } from "./core/mapping";
export { buildSettlementLineDrafts, type SettlementLineDraft, type SettlementLineType } from "./core/settlement-lines";
export { computeBalanceMismatch } from "./core/reconciliation";
export { resolveAccountByIban, type ExistingAccountForResolution } from "./core/account-resolution";
export { findCoverageGaps, type CoverageGap, type StatementRange } from "./core/coverage";
export {
  createContactClearingAccountSchema,
  importFromDocumentInputSchema,
  manualAccountCreateSchema,
  manualAccountUpdateSchema,
  transactionListQuerySchema,
  type CreateContactClearingAccountInput,
  type ManualAccountCreateInput,
  type ManualAccountUpdateInput,
  type TransactionListQuery,
} from "./core/schemas";
export { ACCOUNT_ACTION_ERROR_CODES, type AccountActionErrorCode } from "./core/error-codes";
