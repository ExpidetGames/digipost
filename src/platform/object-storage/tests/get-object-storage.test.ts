// Env-boundary and caching test for the lazy singleton (WEBAPP_TEMPLATE_SPEC.md §10.2):
// constructing an `S3Client` does not itself open a connection (the AWS SDK connects
// lazily on the first request), so this stays a plain unit test as long as no command is
// ever sent - `getObjectStorage()` alone does not violate the unit guard's network ban.
import { afterEach, describe, expect, it } from "vitest";

import { resetServerEnvCacheForTests } from "@/platform/env/server";

import { getObjectStorage, resetObjectStorageForTests } from "../server";

function validEnv(): Record<string, string> {
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

function withEnv(env: Record<string, string | undefined>, run: () => void): void {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetServerEnvCacheForTests();
  resetObjectStorageForTests();
  try {
    run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetServerEnvCacheForTests();
    resetObjectStorageForTests();
  }
}

describe("getObjectStorage", () => {
  afterEach(() => {
    resetServerEnvCacheForTests();
    resetObjectStorageForTests();
  });

  it("builds an ObjectStorage from S3_* env without throwing or making a request", () => {
    withEnv(validEnv(), () => {
      const storage = getObjectStorage();
      expect(typeof storage.putObject).toBe("function");
      expect(typeof storage.getObject).toBe("function");
      expect(typeof storage.deleteObject).toBe("function");
      expect(typeof storage.presignDownload).toBe("function");
    });
  });

  it("caches the client across calls", () => {
    withEnv(validEnv(), () => {
      expect(getObjectStorage()).toBe(getObjectStorage());
    });
  });

  it("builds a fresh client after resetObjectStorageForTests()", () => {
    withEnv(validEnv(), () => {
      const first = getObjectStorage();
      resetObjectStorageForTests();
      const second = getObjectStorage();
      expect(second).not.toBe(first);
    });
  });
});
