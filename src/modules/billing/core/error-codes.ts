// Stable error codes (AGENTS.md "Code": `as const` sets, never raw text). `ui/*.tsx` maps
// these to next-intl message keys under `Billing.errors`.

/** `changeTierAction`/`purchasePackageAction` (`src/modules/billing/actions.ts`). Mirrors
 * `src/persistence/use-cases/billing-use-cases.ts`'s `BILLING_ERROR` plus `invalid_input`
 * (Zod parse failures) and `src/platform/access`'s `WorkspaceAccessErrorCode`. The
 * `downgrade_below_stored_count` message names both numbers client-side (the page's own
 * `UsageViewModel`/`TIER_LIMITS` already have them), not via a server-sent payload -
 * `ActionResult`'s error branch stays the stable `{ status: "error", errorCode }` shape
 * every other module's action uses. */
export const BILLING_ACTION_ERROR_CODES = [
  "invalid_input",
  "not_found",
  "unknown_tier",
  "unknown_package",
  "downgrade_below_stored_count",
  "packages_not_available_on_free",
  "billing_not_configured",
  "unauthenticated",
  "no_workspace",
  "forbidden",
  "unknown",
] as const;
export type BillingActionErrorCode = (typeof BILLING_ACTION_ERROR_CODES)[number];
