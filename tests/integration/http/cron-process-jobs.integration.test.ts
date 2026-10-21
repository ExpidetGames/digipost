// Owner-crossing integration test (WEBAPP_TEMPLATE_SPEC.md §10.1): the real
// `GET /api/cron/process-jobs` route handler against real Postgres - proves the cron
// bearer-secret gate and the sweep both work end to end (unlike the route's own
// `route.test.ts`, which mocks `runDueJobs`). `CRON_SECRET` comes from the real,
// already-validated environment (docker/compose.test.yml's `x-app-env`, or `.env.local` on
// the host), never hardcoded here.
import { describe, expect, it } from "vitest";

import { serverEnv } from "@/platform/env/server";

import { GET } from "@/app/api/cron/process-jobs/route";

function requestWithAuth(header?: string): Request {
  return new Request("http://localhost/api/cron/process-jobs", header ? { headers: { authorization: header } } : undefined);
}

describe("GET /api/cron/process-jobs (real Postgres)", () => {
  it("returns 401 without an Authorization header", async () => {
    const response = await GET(requestWithAuth(), {} as never);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ errorCode: "unauthorized" });
  });

  it("returns 401 for the wrong bearer secret", async () => {
    const response = await GET(requestWithAuth("Bearer wrong-secret-wrong-secret-wrong-secret"), {} as never);
    expect(response.status).toBe(401);
  });

  it("returns 200 with the processed count for the correct bearer secret", async () => {
    const response = await GET(requestWithAuth(`Bearer ${serverEnv().CRON_SECRET}`), {} as never);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { processed: number };
    expect(typeof body.processed).toBe("number");
  });
});
