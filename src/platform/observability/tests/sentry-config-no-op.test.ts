/**
 * Proves the actual `src/sentry.server.config.ts`/`src/sentry.edge.config.ts` files (not
 * just `sentryInitOptions` in isolation) never call `Sentry.init()` without a DSN.
 * `@sentry/nextjs` itself is mocked so this stays a pure unit test (no SDK
 * network/global state, WEBAPP_TEMPLATE_SPEC.md §10.2).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ init: vi.fn() }));

vi.mock("@sentry/nextjs", () => ({ init: h.init }));

beforeEach(() => {
  h.init.mockClear();
  vi.resetModules();
});
afterEach(() => vi.unstubAllEnvs());

describe("src/sentry.server.config.ts", () => {
  it("does not call Sentry.init without SENTRY_DSN", async () => {
    vi.stubEnv("SENTRY_DSN", "");
    await import("@/sentry.server.config");
    expect(h.init).not.toHaveBeenCalled();
  });

  it("calls Sentry.init with the shared options when SENTRY_DSN is set", async () => {
    vi.stubEnv("SENTRY_DSN", "https://example@o0.ingest.sentry.io/0");
    await import("@/sentry.server.config");
    expect(h.init).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ dsn: "https://example@o0.ingest.sentry.io/0", sendDefaultPii: false }),
    );
  });
});

describe("src/sentry.edge.config.ts", () => {
  it("does not call Sentry.init without SENTRY_DSN", async () => {
    vi.stubEnv("SENTRY_DSN", "");
    await import("@/sentry.edge.config");
    expect(h.init).not.toHaveBeenCalled();
  });

  it("calls Sentry.init with the shared options when SENTRY_DSN is set", async () => {
    vi.stubEnv("SENTRY_DSN", "https://example@o0.ingest.sentry.io/0");
    await import("@/sentry.edge.config");
    expect(h.init).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ dsn: "https://example@o0.ingest.sentry.io/0", sendDefaultPii: false }),
    );
  });
});
