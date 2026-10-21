import os from "node:os";

import { defineConfig, devices } from "@playwright/test";

import { loadLocalEnv } from "./tests/e2e/helpers/env";

// DB URLs, BETTER_AUTH_SECRET, CRON_SECRET, ... for the tests (the app loads
// .env.local itself). .env.local points at docker/compose.yml's local Postgres/Mailpit.
loadLocalEnv();

/**
 * Port/base URL are overridable so a production build can be tested next to a
 * running `next dev` on :3000, e.g. `E2E_PORT=3200 pnpm test:e2e` (the webServer
 * below then runs `pnpm build && pnpm start` on that port). The Docker test stack
 * (`pnpm test:e2e:docker`) sets `E2E_BASE_URL` directly (docker/compose.test.yml) and never
 * starts this `webServer` (see `reuseExistingServer` below).
 */
const PORT = Number(process.env.E2E_PORT ?? 3000);
// Careful: other projects on this machine may run `next dev` on the same port -
// globalSetup (tests/e2e/helpers/global-setup.ts) aborts if the server there is not this app.
const baseURL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;

/**
 * P6 review finding E1 (stability): this repository's development/CI machine is small (4
 * CPU / 7 GB, see the architecture brief) and `pnpm test:e2e:docker` runs Postgres,
 * Mailpit, MinIO, the built Next app, AND the Playwright runner's own Chromium workers all
 * at once, in the same compose stack, on those same 4 CPUs. Playwright's own default worker
 * count (roughly half the logical CPUs - so 2 on this machine) still leaves too little
 * headroom once every other service is also competing for the same CPU/memory, which
 * surfaced as tests intermittently reported "did not run" rather than failing outright -
 * resource contention, not a flaky test. One worker per 4 CPUs (so 1 on this machine,
 * noticeably more conservative than Playwright's own default) trades wall-clock time for
 * that headroom; a bigger CI runner scales back up automatically. This must never be
 * "fixed" instead by raising retries or skipping a test (AGENTS.md's "Tests and CI": never
 * weaken a test to make CI green) - if contention returns even at this level, lower the
 * divisor further, or reduce what else runs alongside the suite.
 */
const WORKERS = Math.max(1, Math.floor(os.cpus().length / 4));

export default defineConfig({
  testDir: "tests/e2e",
  globalSetup: "./tests/e2e/helpers/global-setup.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  workers: WORKERS,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL,
    locale: "en-GB",
    timezoneId: "Europe/Berlin",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      // The default, parallel project: every tests/e2e/**/*.spec.ts except tests/e2e/serial/**.
      name: "chromium",
      testDir: "tests/e2e",
      testIgnore: ["**/serial/**"],
      use: { ...devices["Desktop Chrome"] },
    },
    {
      // Tests that touch global/shared state (a cron run that drains *every* due
      // job, a shared mail outbox, global rate limits, an admin list spanning every
      // user, WEBAPP_TEMPLATE_SPEC.md §10.4) run here instead: `workers: 1`, and
      // `dependencies` starts this project only after the parallel one finishes, so
      // a serial test's cleanup (a targeted `TRUNCATE ... CASCADE` and reseed, never
      // a reset endpoint in the app itself) can never race a parallel test's data.
      name: "serial",
      testDir: "tests/e2e/serial",
      workers: 1,
      dependencies: ["chromium"],
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: `pnpm build && pnpm start --port ${PORT}`,
    env: { PORT: String(PORT) },
    url: baseURL,
    reuseExistingServer: true,
    timeout: 300_000,
  },
});
