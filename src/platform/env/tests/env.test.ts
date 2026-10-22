import { afterEach, describe, expect, it } from "vitest";

import { resetServerEnvCacheForTests, serverEnv } from "@/platform/env/server";

const REQUIRED_KEYS = [
  "NODE_ENV",
  "APP_URL",
  "DATABASE_URL",
  "BETTER_AUTH_SECRET",
  "SMTP_URL",
  "MAIL_FROM",
  "CRON_SECRET",
  "S3_REGION",
  "S3_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
] as const;

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
    S3_REGION: "us-east-1",
    S3_BUCKET: "digipost-documents",
    S3_ACCESS_KEY_ID: "minioadmin",
    S3_SECRET_ACCESS_KEY: "minioadmin",
  };
}

function withEnv<T>(env: Record<string, string | undefined>, run: () => T): T {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetServerEnvCacheForTests();
  try {
    return run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetServerEnvCacheForTests();
  }
}

describe("serverEnv", () => {
  afterEach(() => {
    resetServerEnvCacheForTests();
  });

  it("parses a fully valid environment", () => {
    withEnv(validEnv(), () => {
      const env = serverEnv();
      expect(env.APP_URL).toBe("http://localhost:3000");
      expect(env.DATABASE_URL_PUBLIC).toBeUndefined();
      expect(env.SENTRY_DSN).toBeUndefined();
    });
  });

  it("accepts the optional fields when present", () => {
    withEnv(
      {
        ...validEnv(),
        DATABASE_URL_PUBLIC: "postgres://user:pass@localhost:5432/app",
        SENTRY_DSN: "https://key@example.ingest.sentry.io/1",
        APP_COMMIT_SHA: "abc1234def5678",
        S3_ENDPOINT: "http://localhost:54346",
        S3_FORCE_PATH_STYLE: "true",
        MISTRAL_API_KEY: "test-mistral-key",
        AI_PROVIDER: "mistral",
        MISTRAL_OCR_MODEL: "mistral-ocr-latest",
        MISTRAL_CHAT_MODEL: "mistral-small-latest",
      },
      () => {
        const env = serverEnv();
        expect(env.DATABASE_URL_PUBLIC).toBe("postgres://user:pass@localhost:5432/app");
        expect(env.SENTRY_DSN).toBe("https://key@example.ingest.sentry.io/1");
        expect(env.APP_COMMIT_SHA).toBe("abc1234def5678");
        expect(env.S3_ENDPOINT).toBe("http://localhost:54346");
        expect(env.S3_FORCE_PATH_STYLE).toBe(true);
        expect(env.MISTRAL_API_KEY).toBe("test-mistral-key");
        expect(env.AI_PROVIDER).toBe("mistral");
        expect(env.MISTRAL_OCR_MODEL).toBe("mistral-ocr-latest");
        expect(env.MISTRAL_CHAT_MODEL).toBe("mistral-small-latest");
      },
    );
  });

  it("leaves the Mistral fields undefined when unset", () => {
    withEnv(validEnv(), () => {
      const env = serverEnv();
      expect(env.MISTRAL_API_KEY).toBeUndefined();
      expect(env.AI_PROVIDER).toBeUndefined();
      expect(env.MISTRAL_OCR_MODEL).toBeUndefined();
      expect(env.MISTRAL_CHAT_MODEL).toBeUndefined();
    });
  });

  it("rejects an AI_PROVIDER value other than mistral/fake", () => {
    withEnv({ ...validEnv(), AI_PROVIDER: "openai" }, () => {
      expect(() => serverEnv()).toThrow();
    });
  });

  // decisions/0075-email-intake.md: the E-Mail-Eingang variables are all optional - without
  // them the feature is off, never a startup failure.
  it("leaves the E-Mail-Eingang fields undefined when unset", () => {
    withEnv(
      { ...validEnv(), RESEND_API_KEY: undefined, RESEND_WEBHOOK_SECRET: undefined, INBOUND_EMAIL_DOMAIN: undefined, INBOUND_MAIL_PROVIDER: undefined },
      () => {
        const env = serverEnv();
        expect(env.RESEND_API_KEY).toBeUndefined();
        expect(env.RESEND_WEBHOOK_SECRET).toBeUndefined();
        expect(env.INBOUND_EMAIL_DOMAIN).toBeUndefined();
        expect(env.INBOUND_MAIL_PROVIDER).toBeUndefined();
      },
    );
  });

  it("accepts the E-Mail-Eingang fields when present", () => {
    withEnv(
      {
        ...validEnv(),
        RESEND_API_KEY: "re_test",
        RESEND_WEBHOOK_SECRET: "whsec_dGVzdA==",
        INBOUND_EMAIL_DOMAIN: "inbox.example.de",
        INBOUND_MAIL_PROVIDER: "resend",
      },
      () => {
        const env = serverEnv();
        expect(env.INBOUND_EMAIL_DOMAIN).toBe("inbox.example.de");
        expect(env.INBOUND_MAIL_PROVIDER).toBe("resend");
      },
    );
  });

  it("rejects an INBOUND_EMAIL_DOMAIN that is an address or URL rather than a bare domain", () => {
    withEnv({ ...validEnv(), INBOUND_EMAIL_DOMAIN: "post@inbox.example.de" }, () => {
      expect(() => serverEnv()).toThrow();
    });
    withEnv({ ...validEnv(), INBOUND_EMAIL_DOMAIN: "https://inbox.example.de" }, () => {
      expect(() => serverEnv()).toThrow();
    });
  });

  it("rejects an INBOUND_MAIL_PROVIDER value other than resend/fake", () => {
    withEnv({ ...validEnv(), INBOUND_MAIL_PROVIDER: "sendgrid" }, () => {
      expect(() => serverEnv()).toThrow();
    });
  });

  it("defaults S3_FORCE_PATH_STYLE to false when unset", () => {
    withEnv(validEnv(), () => {
      expect(serverEnv().S3_FORCE_PATH_STYLE).toBe(false);
    });
  });

  it("leaves S3_ENDPOINT undefined when unset (AWS S3's default endpoint)", () => {
    withEnv(validEnv(), () => {
      expect(serverEnv().S3_ENDPOINT).toBeUndefined();
    });
  });

  it("leaves APP_COMMIT_SHA undefined when unset (local dev, every test env)", () => {
    withEnv(validEnv(), () => {
      expect(serverEnv().APP_COMMIT_SHA).toBeUndefined();
    });
  });

  it("caches the parsed result across calls", () => {
    withEnv(validEnv(), () => {
      expect(serverEnv()).toBe(serverEnv());
    });
  });

  it.each(REQUIRED_KEYS)("throws when %s is missing", (key) => {
    withEnv({ ...validEnv(), [key]: undefined }, () => {
      expect(() => serverEnv()).toThrow();
    });
  });

  // D4 (P7's defect list): `.env.example` ships every optional variable as an empty line
  // (`MISTRAL_OCR_MODEL=`), which Next.js loads as `""`, not `undefined` - `cp .env.example
  // .env.local` must not 500 the whole app over that. `it.each` below covers every optional
  // field whose Zod type would otherwise reject an empty string outright
  // (`.min(1)`/`.url()`/an enum): each throws before the fix in `blankStringsToUndefined`
  // (src/platform/env/server/env.ts), each must parse to `undefined` (identical to the key
  // being absent entirely) after it.
  const OPTIONAL_STRING_KEYS = [
    "DATABASE_URL_PUBLIC",
    "S3_ENDPOINT",
    "SENTRY_DSN",
    "MISTRAL_API_KEY",
    "MISTRAL_OCR_MODEL",
    "MISTRAL_CHAT_MODEL",
  ] as const;

  it.each(OPTIONAL_STRING_KEYS)("treats an empty %s the same as an absent one (not a validation error)", (key) => {
    withEnv({ ...validEnv(), [key]: "" }, () => {
      expect(() => serverEnv()).not.toThrow();
      expect(serverEnv()[key]).toBeUndefined();
    });
  });

  it.each(["S3_FORCE_PATH_STYLE", "BILLING_TEST_MODE"] as const)("treats an empty %s as unset (defaults to false), not a validation error", (key) => {
    withEnv({ ...validEnv(), [key]: "" }, () => {
      expect(() => serverEnv()).not.toThrow();
      expect(serverEnv()[key]).toBe(false);
    });
  });

  it("treats an empty AI_PROVIDER as unset rather than an invalid enum value", () => {
    withEnv({ ...validEnv(), AI_PROVIDER: "" }, () => {
      expect(() => serverEnv()).not.toThrow();
      expect(serverEnv().AI_PROVIDER).toBeUndefined();
    });
  });

  it("treats an empty APP_COMMIT_SHA as unset", () => {
    withEnv({ ...validEnv(), APP_COMMIT_SHA: "" }, () => {
      expect(() => serverEnv()).not.toThrow();
      expect(serverEnv().APP_COMMIT_SHA).toBeUndefined();
    });
  });

  it("still throws when a REQUIRED field is an empty string, not only when it is absent", () => {
    withEnv({ ...validEnv(), BETTER_AUTH_SECRET: "" }, () => {
      expect(() => serverEnv()).toThrow();
    });
    withEnv({ ...validEnv(), APP_URL: "" }, () => {
      expect(() => serverEnv()).toThrow();
    });
  });

  it("still accepts an optional field's real value alongside other blank optional fields (the .env.example-copy scenario)", () => {
    withEnv(
      {
        ...validEnv(),
        MISTRAL_API_KEY: "real-key",
        AI_PROVIDER: "mistral",
        MISTRAL_OCR_MODEL: "",
        MISTRAL_CHAT_MODEL: "",
        SENTRY_DSN: "",
        S3_ENDPOINT: "",
        DATABASE_URL_PUBLIC: "",
        APP_COMMIT_SHA: "",
      },
      () => {
        const env = serverEnv();
        expect(env.MISTRAL_API_KEY).toBe("real-key");
        expect(env.AI_PROVIDER).toBe("mistral");
        expect(env.MISTRAL_OCR_MODEL).toBeUndefined();
        expect(env.MISTRAL_CHAT_MODEL).toBeUndefined();
        expect(env.SENTRY_DSN).toBeUndefined();
      },
    );
  });

  it("throws when BETTER_AUTH_SECRET is shorter than 32 characters", () => {
    withEnv({ ...validEnv(), BETTER_AUTH_SECRET: "too-short" }, () => {
      expect(() => serverEnv()).toThrow();
    });
  });

  it("throws when APP_URL is not a valid URL", () => {
    withEnv({ ...validEnv(), APP_URL: "not-a-url" }, () => {
      expect(() => serverEnv()).toThrow();
    });
  });
});
