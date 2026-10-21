// The route's own access-step unit test (STRUCTURE.md §7's `route.test.ts` convention,
// WEBAPP_TEMPLATE_SPEC.md §10.2: no DB, no network). `runDueJobs` (which reaches
// `getRequestServices()` and therefore Postgres) is mocked; this test only proves the cron
// bearer-secret gate, exactly like `src/platform/api-pipeline/tests/cron-auth.test.ts` does
// for the step in isolation. The full sweep against real Postgres/MinIO is
// `tests/integration/http/cron-process-jobs.integration.test.ts`.
import { afterEach, describe, expect, it, vi } from "vitest";

import { resetServerEnvCacheForTests } from "@/platform/env/server";

const VALID_SECRET = "a".repeat(32);

vi.mock("@/platform/jobs/server", () => ({
  runDueJobs: vi.fn().mockResolvedValue({ processed: 3 }),
}));

function stubValidEnv(): void {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("APP_URL", "http://localhost:3000");
  vi.stubEnv("DATABASE_URL", "postgres://user:pass@localhost:5432/app");
  vi.stubEnv("BETTER_AUTH_SECRET", VALID_SECRET);
  vi.stubEnv("SMTP_URL", "smtp://localhost:1025");
  vi.stubEnv("MAIL_FROM", "App <no-reply@example.com>");
  vi.stubEnv("CRON_SECRET", VALID_SECRET);
  vi.stubEnv("S3_REGION", "us-east-1");
  vi.stubEnv("S3_BUCKET", "digipost-documents");
  vi.stubEnv("S3_ACCESS_KEY_ID", "minioadmin");
  vi.stubEnv("S3_SECRET_ACCESS_KEY", "minioadmin");
  resetServerEnvCacheForTests();
}

function requestWithAuth(header?: string): Request {
  return new Request("http://localhost/api/cron/process-jobs", header ? { headers: { authorization: header } } : undefined);
}

afterEach(() => {
  vi.unstubAllEnvs();
  resetServerEnvCacheForTests();
});

describe("GET /api/cron/process-jobs", () => {
  it("returns 401 without an Authorization header", async () => {
    stubValidEnv();
    const { GET } = await import("./route");

    const response = await GET(requestWithAuth(), {} as never);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ errorCode: "unauthorized" });
  });

  it("returns 401 for the wrong bearer secret", async () => {
    stubValidEnv();
    const { GET } = await import("./route");

    const response = await GET(requestWithAuth("Bearer wrong-secret-wrong-secret-wrong"), {} as never);

    expect(response.status).toBe(401);
  });

  it("returns 200 and the processed count for the right bearer secret", async () => {
    stubValidEnv();
    const { GET } = await import("./route");

    const response = await GET(requestWithAuth(`Bearer ${VALID_SECRET}`), {} as never);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ processed: 3 });
  });
});
