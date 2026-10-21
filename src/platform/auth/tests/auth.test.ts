// Unit tests for getAuth()'s env boundary only (WEBAPP_TEMPLATE_SPEC.md §10.2): a
// fully valid env would make `buildAuth()` open a real database connection
// (`src/persistence/composition/auth-database.ts` -> `getDb()` -> `pg.Pool`), which
// scripts/test/unit-guard.ts deliberately blocks in this project - by design, the
// happy path is exercised at the integration/e2e level instead (tests/e2e/auth.spec.ts),
// not here. What IS safe and worth covering here: `serverEnv()` is validated before
// any database connection is attempted, so an invalid auth-relevant env variable
// must throw without ever touching `pg`.
import { afterEach, describe, expect, it } from "vitest";

import { resetServerEnvCacheForTests } from "@/platform/env/server";

import { getAuth, resetAuthForTests } from "../server/auth";

const SECRET = "a".repeat(32);

function validEnv(): Record<string, string> {
  return {
    NODE_ENV: "test",
    APP_URL: "http://localhost:3000",
    DATABASE_URL: "postgres://user:pass@localhost:5432/app",
    BETTER_AUTH_SECRET: SECRET,
    SMTP_URL: "smtp://localhost:1025",
    MAIL_FROM: "App <no-reply@example.com>",
    CRON_SECRET: SECRET,
  };
}

function withEnv(env: Record<string, string | undefined>, run: () => void): void {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetServerEnvCacheForTests();
  resetAuthForTests();
  try {
    run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetServerEnvCacheForTests();
    resetAuthForTests();
  }
}

describe("getAuth", () => {
  afterEach(() => {
    resetServerEnvCacheForTests();
    resetAuthForTests();
  });

  it("throws without touching the database when BETTER_AUTH_SECRET is missing", () => {
    withEnv({ ...validEnv(), BETTER_AUTH_SECRET: undefined }, () => {
      expect(() => getAuth()).toThrow();
    });
  });

  it("throws without touching the database when BETTER_AUTH_SECRET is shorter than 32 characters", () => {
    withEnv({ ...validEnv(), BETTER_AUTH_SECRET: "too-short" }, () => {
      expect(() => getAuth()).toThrow();
    });
  });

  it("throws without touching the database when APP_URL is not a valid URL", () => {
    withEnv({ ...validEnv(), APP_URL: "not-a-url" }, () => {
      expect(() => getAuth()).toThrow();
    });
  });

  it("throws without touching the database when SMTP_URL is missing", () => {
    withEnv({ ...validEnv(), SMTP_URL: undefined }, () => {
      expect(() => getAuth()).toThrow();
    });
  });
});
