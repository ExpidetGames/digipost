// Vitest setup file for the "unit" project only (vitest.config.ts). Unit tests must not
// touch a real database or the network (WEBAPP_TEMPLATE_SPEC.md §10.2): a repository
// gets a *.db.test.ts against real Postgres instead of a unit test, and any external
// call is injected (a `fetch` parameter, a Mailer port) rather than called directly.
import { vi } from "vitest";

vi.mock("pg", () => ({
  Pool: class {
    constructor() {
      throw new Error(
        "Database access in a unit test. Use a typed fake (src/persistence/tests/support once it exists) or write a *.db.test.ts instead.",
      );
    }
  },
}));

vi.stubGlobal("fetch", () => {
  throw new Error("Network access in a unit test. Inject `fetch` as a dependency instead.");
});

for (const key of [
  "DATABASE_URL",
  "DATABASE_URL_PUBLIC",
  "DATABASE_URL_MIGRATE",
  "SMTP_URL",
  "BETTER_AUTH_SECRET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  // decisions/0075-email-intake.md: a developer's real Resend credentials in `.env.local` must
  // never reach a unit test (which would then talk to the real API if `fetch` were not stubbed).
  "RESEND_API_KEY",
  "RESEND_WEBHOOK_SECRET",
]) {
  delete process.env[key];
}
