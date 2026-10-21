// Unit tests for the two `PaymentProvider` adapters (WEBAPP_TEMPLATE_SPEC.md §10.2,
// decisions/0017-billing-tiers-and-packages.md).
import { describe, expect, it } from "vitest";

import { createNotConfiguredPaymentProvider, createTestPaymentProvider, PaymentProviderError } from "../core/payment-provider";

describe("createTestPaymentProvider", () => {
  it("completes a tier change instantly, recording provider: test", async () => {
    const provider = createTestPaymentProvider();
    const result = await provider.changeTier({ workspaceId: "w1", newTier: "pro" });
    expect(result).toEqual({ provider: "test", providerReference: null });
  });

  it("completes a package purchase instantly, recording provider: test", async () => {
    const provider = createTestPaymentProvider();
    const result = await provider.purchasePackage({ workspaceId: "w1", packageKey: "m" });
    expect(result).toEqual({ provider: "test", providerReference: null });
  });
});

describe("createNotConfiguredPaymentProvider", () => {
  it("refuses a tier change with PaymentProviderError (billing_not_configured)", async () => {
    const provider = createNotConfiguredPaymentProvider();
    await expect(provider.changeTier({ workspaceId: "w1", newTier: "pro" })).rejects.toThrow(PaymentProviderError);
    await provider.changeTier({ workspaceId: "w1", newTier: "pro" }).catch((err: unknown) => {
      expect(err).toBeInstanceOf(PaymentProviderError);
      expect((err as PaymentProviderError).code).toBe("billing_not_configured");
    });
  });

  it("refuses a package purchase with PaymentProviderError (billing_not_configured)", async () => {
    const provider = createNotConfiguredPaymentProvider();
    await expect(provider.purchasePackage({ workspaceId: "w1", packageKey: "s" })).rejects.toThrow(PaymentProviderError);
  });
});
