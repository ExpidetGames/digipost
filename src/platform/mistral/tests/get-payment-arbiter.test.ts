// Mirrors `src/platform/object-storage/tests/get-object-storage.test.ts`'s env-boundary and
// caching pattern for this owner's own env-driven lazy singleton.
import { afterEach, describe, expect, it } from "vitest";

import { resetServerEnvCacheForTests } from "@/platform/env/server";

import { getPaymentArbiter, resetPaymentArbiterForTests } from "../server/get-payment-arbiter";

function baseEnv(): Record<string, string> {
  return {
    NODE_ENV: "test",
    APP_URL: "http://localhost:3000",
    DATABASE_URL: "postgres://user:pass@localhost:5432/app",
    BETTER_AUTH_SECRET: "a".repeat(32),
    SMTP_URL: "smtp://localhost:1025",
    MAIL_FROM: "Digipost <no-reply@digipost.local>",
    CRON_SECRET: "a".repeat(32),
    S3_ENDPOINT: "http://localhost:54346",
    S3_REGION: "us-east-1",
    S3_BUCKET: "digipost-documents",
    S3_ACCESS_KEY_ID: "minioadmin",
    S3_SECRET_ACCESS_KEY: "minioadmin",
    S3_FORCE_PATH_STYLE: "true",
  };
}

function withEnv(env: Record<string, string | undefined>, run: () => Promise<void> | void): Promise<void> | void {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetServerEnvCacheForTests();
  resetPaymentArbiterForTests();

  const restore = () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetServerEnvCacheForTests();
    resetPaymentArbiterForTests();
  };

  const result = run();
  if (result instanceof Promise) return result.finally(restore);
  restore();
  return undefined;
}

describe("getPaymentArbiter", () => {
  afterEach(() => {
    resetServerEnvCacheForTests();
    resetPaymentArbiterForTests();
  });

  it("binds the fake arbiter when AI_PROVIDER=fake, even with a key present", async () => {
    await withEnv({ ...baseEnv(), AI_PROVIDER: "fake", MISTRAL_API_KEY: "some-key" }, async () => {
      const arbiter = getPaymentArbiter();
      const result = await arbiter.rank({ transaction: { id: "t", bookingDate: "2026-01-01", amountCents: -100, currency: "EUR", counterpartyName: null, counterpartyIban: null, remittanceText: null, endToEndId: null, accountId: "a" }, candidates: [] });
      expect(result.bestDocumentId).toBeNull();
    });
  });

  it("binds the fake arbiter outside production when no key is configured", () => {
    withEnv({ ...baseEnv(), NODE_ENV: "test" }, () => {
      const arbiter = getPaymentArbiter();
      expect(typeof arbiter.rank).toBe("function");
    });
  });

  it("binds a not-configured arbiter that throws on first use in production with no key", async () => {
    await withEnv({ ...baseEnv(), NODE_ENV: "production", APP_URL: "https://example.com" }, async () => {
      const arbiter = getPaymentArbiter();
      await expect(
        arbiter.rank({ transaction: { id: "t", bookingDate: "2026-01-01", amountCents: -100, currency: "EUR", counterpartyName: null, counterpartyIban: null, remittanceText: null, endToEndId: null, accountId: "a" }, candidates: [] }),
      ).rejects.toMatchObject({ code: "ai_not_configured" });
    });
  });

  it("caches the arbiter across calls", () => {
    withEnv(baseEnv(), () => {
      expect(getPaymentArbiter()).toBe(getPaymentArbiter());
    });
  });

  it("builds a fresh arbiter after resetPaymentArbiterForTests()", () => {
    withEnv(baseEnv(), () => {
      const first = getPaymentArbiter();
      resetPaymentArbiterForTests();
      const second = getPaymentArbiter();
      expect(second).not.toBe(first);
    });
  });
});
