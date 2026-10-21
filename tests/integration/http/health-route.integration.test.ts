// Owner-crossing integration test (WEBAPP_TEMPLATE_SPEC.md §10.1): the real route
// handler against real Postgres - proves `GET /api/health` actually reaches
// `app_runtime` end to end, not just that `createSystemUseCases`' fake-backed unit
// test (`src/persistence/tests/system-use-cases.test.ts`) type-checks.
import { describe, expect, it } from "vitest";

import { GET } from "@/app/api/health/route";

describe("GET /api/health (real Postgres)", () => {
  it("returns 200 { ok: true, version: null } with Cache-Control: no-store", async () => {
    // version is null here because APP_COMMIT_SHA is unset in this test environment
    // (docker/compose.test.yml, WEBAPP_TEMPLATE_SPEC.md §13.4) - it is set only by
    // .github/workflows/deploy-production.yml against a real deployment.
    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ ok: true, version: null });
  });
});
