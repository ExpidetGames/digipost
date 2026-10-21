// Unit test for the cron bearer-secret access step (WEBAPP_TEMPLATE_SPEC.md §10.2:
// no DB, no network). `serverEnv()` caches its parsed result across calls
// (`src/platform/env/server/env.ts`), so every test stubs the full required
// environment and resets that cache, the same pattern `src/platform/env/tests/env.test.ts`
// uses.
import { afterEach, describe, expect, it, vi } from "vitest";

import { resetServerEnvCacheForTests } from "@/platform/env/server";
import { CronAuthError, requireCronSecret } from "@/platform/api-pipeline/server/cron-auth";

const VALID_SECRET = "a".repeat(32);

function stubValidEnv(cronSecret: string = VALID_SECRET): void {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("APP_URL", "http://localhost:3000");
  vi.stubEnv("DATABASE_URL", "postgres://user:pass@localhost:5432/app");
  vi.stubEnv("BETTER_AUTH_SECRET", VALID_SECRET);
  vi.stubEnv("SMTP_URL", "smtp://localhost:1025");
  vi.stubEnv("MAIL_FROM", "App <no-reply@example.com>");
  vi.stubEnv("CRON_SECRET", cronSecret);
  vi.stubEnv("S3_REGION", "us-east-1");
  vi.stubEnv("S3_BUCKET", "digipost-documents");
  vi.stubEnv("S3_ACCESS_KEY_ID", "minioadmin");
  vi.stubEnv("S3_SECRET_ACCESS_KEY", "minioadmin");
  resetServerEnvCacheForTests();
}

function requestWithAuth(header?: string): Request {
  return new Request("http://localhost/api/cron/example", header ? { headers: { authorization: header } } : undefined);
}

afterEach(() => {
  vi.unstubAllEnvs();
  resetServerEnvCacheForTests();
});

describe("requireCronSecret", () => {
  it("does not throw for the correct bearer secret", () => {
    stubValidEnv();
    expect(() => requireCronSecret(requestWithAuth(`Bearer ${VALID_SECRET}`))).not.toThrow();
  });

  it("throws CronAuthError for a missing Authorization header", () => {
    stubValidEnv();
    expect(() => requireCronSecret(requestWithAuth())).toThrow(CronAuthError);
  });

  it("throws CronAuthError for the wrong secret", () => {
    stubValidEnv();
    expect(() => requireCronSecret(requestWithAuth("Bearer wrong-secret-wrong-secret-wrong"))).toThrow(CronAuthError);
  });

  it("throws CronAuthError when the header omits the Bearer prefix", () => {
    stubValidEnv();
    expect(() => requireCronSecret(requestWithAuth(VALID_SECRET))).toThrow(CronAuthError);
  });

  it("throws CronAuthError for a secret that is a prefix of the real one", () => {
    stubValidEnv();
    expect(() => requireCronSecret(requestWithAuth(`Bearer ${VALID_SECRET.slice(0, 10)}`))).toThrow(CronAuthError);
  });
});
