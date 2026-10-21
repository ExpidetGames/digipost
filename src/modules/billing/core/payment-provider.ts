// Owner: src/modules/billing (decisions/0017-billing-tiers-and-packages.md's payment port:
// "no Stripe keys exist" - the architecture brief's product decision 3). Pure: no I/O, no
// `next/*`/`react`, no env access (`server.ts` picks which implementation to bind, the same
// lazy-singleton-by-env shape `src/platform/mistral/server/get-ai-adapters.ts` already uses
// for `AI_PROVIDER`). Both a tier change and a package purchase are "payment actions" for
// the purpose of this port - a future Stripe adapter needs the same two operations, plus
// (outside this port, in `src/platform/*`) a webhook endpoint and idempotent event handling;
// see decisions/0017 for exactly what that future adapter has to implement.
import type { PackageKey } from "./plans";
import type { Tier } from "./plans";

export type PaymentResult = {
  /** `"test"` today (the only adapter this phase ships); a future Stripe adapter returns
   * `"stripe"`. Persisted verbatim on `quota_package_purchases.provider`/
   * `workspace_tier_changes.provider`. */
  provider: "test" | "stripe";
  /** A provider-specific reference (a Stripe checkout session id, subscription id, or
   * event id, once a real adapter exists) - `null` for the test adapter, which has nothing
   * to reference. */
  providerReference: string | null;
};

/** Thrown by `createNotConfiguredPaymentProvider()`'s methods when `BILLING_TEST_MODE` is
 * not `true` (architecture brief's product decision 3: "never in production", and this
 * phase ships no real Stripe adapter at all). `code` is always `"billing_not_configured"` -
 * `src/persistence/use-cases/billing-use-cases.ts` catches this and rethrows it as a
 * `UseCaseError`, so `changeTier`/`purchasePackage` refuse with this stable code even if a
 * Server Action is called directly, bypassing whatever the UI itself checks. */
export class PaymentProviderError extends Error {
  override readonly name = "PaymentProviderError";
  readonly code = "billing_not_configured";

  constructor() {
    super("Billing payment provider is not configured (BILLING_TEST_MODE is not true).");
  }
}

/**
 * The seam a future Stripe adapter implements (decisions/0017-billing-tiers-and-packages.md
 * documents exactly what that needs: checkout, webhook signature verification, idempotent
 * event handling keyed by event id, and treating the subscription's own state as the source
 * of truth for the tier - none of which this port or its test adapter attempt).
 * `src/persistence/use-cases/billing-use-cases.ts`'s `changeTier`/`purchasePackage` depend
 * only on this interface, never on a concrete adapter.
 */
export interface PaymentProvider {
  changeTier(input: { workspaceId: string; newTier: Tier }): Promise<PaymentResult>;
  purchasePackage(input: { workspaceId: string; packageKey: PackageKey }): Promise<PaymentResult>;
}

/**
 * Completes instantly, records `provider: "test"` (architecture brief's product decision 3:
 * "test mode adapter that completes a purchase instantly"). No I/O, no network, no state -
 * every call always succeeds. Bound only when `BILLING_TEST_MODE=true`
 * (`src/modules/billing/server.ts`'s `getPaymentProvider()`).
 */
export function createTestPaymentProvider(): PaymentProvider {
  return {
    async changeTier() {
      return { provider: "test", providerReference: null };
    },
    async purchasePackage() {
      return { provider: "test", providerReference: null };
    },
  };
}

/**
 * Bound whenever `BILLING_TEST_MODE` is not `true` (the default, and always in production,
 * since no real Stripe adapter exists yet). Every call throws `PaymentProviderError` -
 * `changeTier`/`purchasePackage` refuse unconditionally, so a tier change or a package
 * purchase is simply impossible while this is bound, regardless of what any caller passes.
 */
export function createNotConfiguredPaymentProvider(): PaymentProvider {
  return {
    async changeTier(): Promise<PaymentResult> {
      throw new PaymentProviderError();
    },
    async purchasePackage(): Promise<PaymentResult> {
      throw new PaymentProviderError();
    },
  };
}
