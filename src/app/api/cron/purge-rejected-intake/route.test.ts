// The route's own access-step unit test (STRUCTURE.md §7's `route.test.ts` convention,
// WEBAPP_TEMPLATE_SPEC.md §10.2: no DB, no network). Mirrors
// `src/app/api/cron/process-jobs/route.test.ts` exactly for the cron bearer-secret gate;
// `enqueuePurgeForRejectedIntake`/`runDueJobs` (both reaching `getRequestServices()` and
// therefore Postgres) are mocked. The full sweep against real Postgres/MinIO is a later
// integration test (decisions/0027-hardening-and-deletion.md).
import { afterEach, describe, expect, it, vi } from "vitest";

import { resetServerEnvCacheForTests } from "@/platform/env/server";

const VALID_SECRET = "a".repeat(32);

const enqueuePurgeForRejectedIntake = vi.fn().mockResolvedValue({ enqueued: 2 });
vi.mock("@/persistence/composition/request-services", () => ({
  getRequestServices: () => ({ documents: { enqueuePurgeForRejectedIntake } }),
}));

vi.mock("@/platform/jobs/server", () => ({
  runDueJobs: vi.fn().mockResolvedValue({ processed: 2 }),
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
  return new Request("http://localhost/api/cron/purge-rejected-intake", header ? { headers: { authorization: header } } : undefined);
}

afterEach(() => {
  vi.unstubAllEnvs();
  resetServerEnvCacheForTests();
});

describe("GET /api/cron/purge-rejected-intake", () => {
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

  it("returns 200 with the enqueued and processed counts for the correct bearer secret", async () => {
    stubValidEnv();
    const { GET } = await import("./route");

    const response = await GET(requestWithAuth(`Bearer ${VALID_SECRET}`), {} as never);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ enqueued: 2, processed: 2 });
  });
});
