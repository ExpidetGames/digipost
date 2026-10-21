import "server-only";

/**
 * Public server entrypoint (WEBAPP_TEMPLATE_SPEC.md §4.2). The `(app)` pages under
 * `/dashboard/documents/[id]` and `/dashboard/finance` import from here, never from
 * `src/modules/payments/core/**`/`server/**` directly.
 */
export {
  countOpenSuggestionsProjection,
  countUnmatchedTransactionsProjection,
  getDocumentPaymentSectionProjection,
  getPaymentAutoConfirmModeProjection,
  getSettlementReportProjection,
  listContactPaymentAliasesProjection,
  listOpenItemsProjection,
  listUnmatchedTransactionsProjection,
} from "./server/read-models";
