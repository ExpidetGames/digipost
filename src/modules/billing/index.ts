// Neutral entrypoint of src/modules/billing (WEBAPP_TEMPLATE_SPEC.md §4.2): pure tier/package
// data and the pure `evaluateQuota` check, safe to import from persistence schema/use-cases
// and from client-reachable code alike (no `server-only`, no `"use client"`, no I/O).
//
// P2a shipped this skeleton plus the persistence use case
// (`src/persistence/use-cases/billing-use-cases.ts`) that reads/writes usage; P3
// (decisions/0017-billing-tiers-and-packages.md) added the billing UI
// (`/dashboard/billing`), the test-mode plan-change and package-purchase actions, the 80%
// warning e-mail job (`evaluateWarningCrossing` below, reading `QuotaEvaluation.totalRatio`/
// `monthlyRatio`), and the `PaymentProvider` port.
export {
  canPurchasePackages,
  evaluateQuota,
  evaluateWarningCrossing,
  PACKAGE_KEYS,
  PACKAGES,
  periodKeyFor,
  QUOTA_ERROR,
  TIER_LIMITS,
  TIERS,
  WARNING_THRESHOLD_RATIO,
  type EvaluateQuotaInput,
  type PackageDefinition,
  type PackageKey,
  type QuotaErrorCode,
  type QuotaEvaluation,
  type Tier,
  type TierLimits,
  type WarningCrossing,
} from "./core/plans";
export {
  createNotConfiguredPaymentProvider,
  createTestPaymentProvider,
  PaymentProviderError,
  type PaymentProvider,
  type PaymentResult,
} from "./core/payment-provider";
