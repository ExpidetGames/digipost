// Neutral entrypoint of src/modules/payments (WEBAPP_TEMPLATE_SPEC.md §4.2,
// decisions/0023-payment-matching.md): pure domain logic only (no I/O, no `server-only`, no
// `"use client"`) - safe to import from a future persistence use case (F3b) and from
// `src/platform/mistral`'s payment-arbiter adapter alike, exactly like
// `@/modules/contacts`/`@/modules/intake`'s own neutral entrypoints.
export {
  DOCUMENT_TRANSACTION_STATUSES,
  MATCH_KINDS,
  MATCH_REASON_CODES,
  MATCH_TRIGGERS,
  MATCHED_BY_VALUES,
  PAYMENT_STATUSES,
  type DocumentTransactionStatus,
  type MatchableDocument,
  type MatchableDocumentDirection,
  type MatchableTransaction,
  type MatchedBy,
  type MatchKind,
  type MatchReasonCode,
  type MatchSuggestion,
  type MatchTrigger,
  type PaymentStatus,
} from "./core/types";
export { directionMatches } from "./core/direction";
export { MATCHING_DEBOUNCE_MS } from "./core/matching-schedule";
export { DEFAULT_PAYMENT_AUTO_CONFIRM_MODE, isPaymentAutoConfirmMode, PAYMENT_AUTO_CONFIRM_MODES, type PaymentAutoConfirmMode } from "./core/auto-confirm";
export { derivePaymentStatus, resolveDisplayStatus, type DerivePaymentStatusInput } from "./core/payment-status";
export {
  counterpartyNameSimilarity,
  documentNamesStatementReference,
  extractInvoiceReferences,
  extractStatementReferences,
  findCustomerNumbers,
  findInvoiceNumbers,
  hasContradictingInvoiceReference,
} from "./core/text-signals";
export { dayDistance, DEFAULT_SKONTO_TOLERANCE_PERCENT, isAutoConfirmMatch, isWithinSkontoTolerance, matchByRules, NAME_MATCH_THRESHOLD, sameCurrency, type AutoConfirmInput, type MatchRuleOptions } from "./core/rules";
export {
  findSubsetSums,
  partialPaymentFor,
  remainingOpenAmount,
  type PartialPaymentResult,
  type SubsetSumOptions,
  type SubsetSumResult,
} from "./core/arithmetic";
export {
  MAX_CANDIDATES,
  selectCandidateDocuments,
  selectCandidateTransactions,
  type CandidateOptions,
} from "./core/candidates";
export {
  MAX_ARBITER_CANDIDATES,
  arbiterCacheKey,
  validateArbiterResult,
  type PaymentArbiter,
  type PaymentArbiterInput,
  type PaymentArbiterRawResult,
} from "./core/arbiter";
export { createFakePaymentArbiter } from "./core/fake-payment-arbiter";
export { aliasKeyForCounterparty,
  applyAliases,
  filterRejectedPairs,
  learnAliasFromConfirmation,
  matchesLearnedChannel,
  rejectedPairKey,
  type ContactAliasMap,
  type PaymentChannelMap,
  type RejectedPairSet,
} from "./core/learning";
export { resolveContactForCounterparty, type ContactForResolution } from "./core/contact-resolution";
export { detectDuplicatePayment, reminderAlreadyPaid, type DuplicatePaymentWarning } from "./core/safety";
export {
  detectPlatformFromText,
  isPlatformContactName,
  looksLikePlatformPayout,
  reconcileFeeInvoice,
  textNamesPlatform,
  type FeeInvoiceReconciliation,
} from "./core/platform-detection";
export {
  decomposeSettlement,
  matchSettlementLinesToDocuments,
  type SettlementDecomposition,
  type SettlementLine,
  type SettlementLineMatch,
} from "./core/settlement";
export {
  planApplePayoutPairing,
  planGooglePayoutPairing,
  type AppStorePayoutPairing,
  type AppStoreReportSummary,
  type BankCreditCandidate,
} from "./core/app-store-payout-matching";
export { PAYMENT_ACTION_ERROR_CODES, type PaymentActionErrorCode } from "./core/error-codes";
export {
  decisionInputSchema,
  linkManuallyInputSchema,
  markNoDocumentNeededInputSchema,
  markSettledWithoutPaymentInputSchema,
  type DecisionActionInput,
  type LinkManuallyActionInput,
  type MarkNoDocumentNeededActionInput,
  type MarkSettledWithoutPaymentActionInput,
} from "./core/schemas";
export type {
  DocumentPaymentSection,
  MatchedTransactionView,
  OpenItemsView,
  OpenItemView,
  SettlementLineView,
  SettlementReportView,
  SuggestionView,
  UnmatchedTransactionView,
} from "./core/view-types";
