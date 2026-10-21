import { describe, expect, it } from "vitest";

import { redactInviteTokenFromUrl, sentryInitOptions } from "@/platform/observability";

describe("sentryInitOptions", () => {
  it("is a no-op (returns undefined) without a DSN", () => {
    expect(sentryInitOptions(undefined)).toBeUndefined();
  });

  it("is a no-op for an empty or whitespace-only DSN", () => {
    expect(sentryInitOptions("")).toBeUndefined();
    expect(sentryInitOptions("   ")).toBeUndefined();
  });

  it("returns init options with no PII when a DSN is set", () => {
    const options = sentryInitOptions("https://example@o0.ingest.sentry.io/0");
    expect(options).toEqual({
      dsn: "https://example@o0.ingest.sentry.io/0",
      sendDefaultPii: false,
      tracesSampleRate: expect.any(Number),
      beforeSend: expect.any(Function),
      beforeBreadcrumb: expect.any(Function),
    });
  });

  it("trims the DSN", () => {
    expect(sentryInitOptions("  https://example@o0.ingest.sentry.io/0  ")?.dsn).toBe("https://example@o0.ingest.sentry.io/0");
  });
});

// P6 review finding B3 (decisions/0018-invite-token-sentry-scrubbing.md): an invitation
// token travels in the URL path (`/invite/<token>`) and must never reach Sentry verbatim.
describe("redactInviteTokenFromUrl", () => {
  it("redacts the token from an absolute URL", () => {
    expect(redactInviteTokenFromUrl("https://app.example.test/invite/abc123secretTOKEN")).toBe(
      "https://app.example.test/invite/[redacted]",
    );
  });

  it("redacts the token from a bare path", () => {
    expect(redactInviteTokenFromUrl("/invite/abc123secretTOKEN")).toBe("/invite/[redacted]");
  });

  it("stops at the next path segment, query string, or fragment", () => {
    expect(redactInviteTokenFromUrl("/invite/abc123/extra")).toBe("/invite/[redacted]/extra");
    expect(redactInviteTokenFromUrl("/invite/abc123?ref=email")).toBe("/invite/[redacted]?ref=email");
    expect(redactInviteTokenFromUrl("/invite/abc123#section")).toBe("/invite/[redacted]#section");
  });

  it("redacts every occurrence in a string with more than one", () => {
    expect(redactInviteTokenFromUrl("saw /invite/tok1 then redirected to /invite/tok2")).toBe(
      "saw /invite/[redacted] then redirected to /invite/[redacted]",
    );
  });

  it("leaves a URL with no invite token unchanged", () => {
    expect(redactInviteTokenFromUrl("https://app.example.test/dashboard")).toBe("https://app.example.test/dashboard");
  });
});

describe("sentryInitOptions' beforeSend/beforeBreadcrumb redact invite tokens", () => {
  const options = sentryInitOptions("https://example@o0.ingest.sentry.io/0")!;

  it("beforeSend redacts event.request.url", () => {
    const event = { request: { url: "https://app.example.test/invite/topSecretToken" } };
    const result = options.beforeSend(event);
    expect(result.request?.url).toBe("https://app.example.test/invite/[redacted]");
  });

  it("beforeSend redacts breadcrumb data URLs already attached to the event", () => {
    const event = {
      breadcrumbs: [
        { data: { url: "https://app.example.test/invite/topSecretToken" } },
        { data: { to: "/invite/anotherToken", from: "/dashboard" } },
        { message: "navigated to /invite/thirdToken" },
      ],
    };
    const result = options.beforeSend(event);
    expect(result.breadcrumbs?.[0]?.data?.url).toBe("https://app.example.test/invite/[redacted]");
    expect(result.breadcrumbs?.[1]?.data?.to).toBe("/invite/[redacted]");
    expect(result.breadcrumbs?.[1]?.data?.from).toBe("/dashboard");
    expect(result.breadcrumbs?.[2]?.message).toBe("navigated to /invite/[redacted]");
  });

  it("beforeBreadcrumb redacts a single breadcrumb before it is ever recorded", () => {
    const breadcrumb = { data: { url: "/invite/aFreshToken" } };
    const result = options.beforeBreadcrumb(breadcrumb);
    expect(result.data?.url).toBe("/invite/[redacted]");
  });

  it("does not throw and returns the event unchanged when there is nothing to redact", () => {
    const event = { request: { url: "https://app.example.test/dashboard" } };
    expect(options.beforeSend(event)).toEqual(event);
    expect(options.beforeSend({})).toEqual({});
  });
});
