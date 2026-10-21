// Owner: src/modules/billing. Privileged entrypoint (`import "server-only"`): picks the
// `PaymentProvider` adapter by env, the same lazy-singleton-by-env shape
// `src/platform/mistral/server/get-ai-adapters.ts` uses for `AI_PROVIDER`/`MISTRAL_API_KEY`.
// `BILLING_TEST_MODE` is never read anywhere else (architecture brief's product decision 3:
// no Stripe keys exist, so a tier change/package purchase only ever works in test mode).
import "server-only";

import { createNotConfiguredPaymentProvider, createTestPaymentProvider, type PaymentProvider } from "../core/payment-provider";

import { serverEnv } from "@/platform/env/server";

let cached: PaymentProvider | undefined;

/** `true` only when `BILLING_TEST_MODE=true` - backs both the UI's unmissable "Testmodus"
 * badge on every payment-ish control and the "payment is not connected yet" notice when
 * it is off (decisions/0017-billing-tiers-and-packages.md). */
export function isBillingTestModeActive(): boolean {
  return serverEnv().BILLING_TEST_MODE;
}

/**
 * `createTestPaymentProvider()` when `BILLING_TEST_MODE=true`, otherwise
 * `createNotConfiguredPaymentProvider()` (every call throws `PaymentProviderError`,
 * `billing_not_configured`) - this is what makes `changeTier`/`purchasePackage` refuse
 * unconditionally outside test mode, even if a Server Action is invoked directly, bypassing
 * whatever the UI itself checks.
 */
export function getPaymentProvider(): PaymentProvider {
  return (cached ??= isBillingTestModeActive() ? createTestPaymentProvider() : createNotConfiguredPaymentProvider());
}

/** Test-only: clears the memoized provider so a test can re-select it after changing env. */
export function resetPaymentProviderForTests(): void {
  cached = undefined;
}
