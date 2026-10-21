import "server-only";

/**
 * Public server entrypoint (WEBAPP_TEMPLATE_SPEC.md §4.2). The `(app)` pages under
 * `/dashboard/finance` import from here, never from `src/modules/accounts/core/**`/`server/**`
 * directly.
 */
export {
  getAccountOverviewProjection,
  getContactClearingAccountProjection,
  listAccountsOverviewProjection,
  listImportBatchesProjection,
  listPendingAccountDocumentsProjection,
  listTransactionsProjection,
} from "./server/read-models";
