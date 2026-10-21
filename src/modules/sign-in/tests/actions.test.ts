// Unit tests for requestMagicLinkAction/signOutAction (WEBAPP_TEMPLATE_SPEC.md
// §10.2: mock the module path the code under test actually imports). No DB, no
// network: `getAuth()` is mocked to a fake `{ handler, api }`, so these tests also
// document/guard decisions/0005's rule - `requestMagicLinkAction` must call
// `getAuth().handler(request)`, never `getAuth().api.signInMagicLink(...)` directly.
import { beforeEach, describe, expect, it, vi } from "vitest";

const handlerMock = vi.fn();
const signOutMock = vi.fn();
vi.mock("@/platform/auth/server", () => ({
  getAuth: () => ({ handler: handlerMock, api: { signOut: signOutMock } }),
}));

vi.mock("@/platform/env/server", () => ({
  serverEnv: () => ({ APP_URL: "http://localhost:3000" }),
}));

let incomingHeaders = new Headers();
vi.mock("next/headers", () => ({
  headers: async () => incomingHeaders,
}));

const redirectMock = vi.fn((url: string) => {
  throw new Error(`REDIRECT:${url}`);
});
vi.mock("next/navigation", () => ({
  redirect: (url: string) => redirectMock(url),
}));

import { requestMagicLinkAction, signOutAction, type RequestMagicLinkState } from "../actions";

const INITIAL_STATE: RequestMagicLinkState = { status: "idle" };

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

function jsonResponse(status: number, body: unknown = { status: true }): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("requestMagicLinkAction", () => {
  beforeEach(() => {
    handlerMock.mockReset();
    signOutMock.mockReset();
    redirectMock.mockClear();
    incomingHeaders = new Headers();
  });

  it("rejects a malformed address without calling the auth handler", async () => {
    const result = await requestMagicLinkAction(INITIAL_STATE, formData({ email: "not-an-email" }));
    expect(result).toEqual({ status: "error", errorCode: "invalid_email", email: "not-an-email" });
    expect(handlerMock).not.toHaveBeenCalled();
  });

  it("rejects a missing address without calling the auth handler", async () => {
    const result = await requestMagicLinkAction(INITIAL_STATE, formData({}));
    expect(result).toEqual({ status: "error", errorCode: "invalid_email", email: "" });
    expect(handlerMock).not.toHaveBeenCalled();
  });

  it("calls getAuth().handler(request), never auth.api.signInMagicLink, and returns sent on success", async () => {
    handlerMock.mockResolvedValue(jsonResponse(200));

    const result = await requestMagicLinkAction(INITIAL_STATE, formData({ email: "user@example.com" }));

    expect(result).toEqual({ status: "sent", email: "user@example.com" });
    expect(handlerMock).toHaveBeenCalledTimes(1);
    const request = handlerMock.mock.calls[0][0] as Request;
    expect(request).toBeInstanceOf(Request);
    expect(request.method).toBe("POST");
    expect(request.url).toBe("http://localhost:3000/api/auth/sign-in/magic-link");
  });

  it("normalizes (trims, lowercases) the email before sending", async () => {
    handlerMock.mockResolvedValue(jsonResponse(200));

    await requestMagicLinkAction(INITIAL_STATE, formData({ email: "  User@Example.com  " }));

    const request = handlerMock.mock.calls[0][0] as Request;
    const body = JSON.parse(await request.text());
    expect(body.email).toBe("user@example.com");
  });

  it("forwards x-forwarded-for from the incoming request so the rate limiter keys on the real IP", async () => {
    incomingHeaders = new Headers({ "x-forwarded-for": "203.0.113.7" });
    handlerMock.mockResolvedValue(jsonResponse(200));

    await requestMagicLinkAction(INITIAL_STATE, formData({ email: "user@example.com" }));

    const request = handlerMock.mock.calls[0][0] as Request;
    expect(request.headers.get("x-forwarded-for")).toBe("203.0.113.7");
  });

  it(
    "also forwards x-vercel-forwarded-for and x-real-ip, matching auth.ts's ipAddressHeaders " +
      "trust order (P6 review finding B2): x-forwarded-for alone is client-forgeable on any " +
      "deployment without a trusted proxy in front of it",
    async () => {
      incomingHeaders = new Headers({
        "x-vercel-forwarded-for": "198.51.100.9",
        "x-real-ip": "198.51.100.10",
        "x-forwarded-for": "203.0.113.7",
      });
      handlerMock.mockResolvedValue(jsonResponse(200));

      await requestMagicLinkAction(INITIAL_STATE, formData({ email: "user@example.com" }));

      const request = handlerMock.mock.calls[0][0] as Request;
      expect(request.headers.get("x-vercel-forwarded-for")).toBe("198.51.100.9");
      expect(request.headers.get("x-real-ip")).toBe("198.51.100.10");
      expect(request.headers.get("x-forwarded-for")).toBe("203.0.113.7");
    },
  );

  it("uses safeNextPath for callbackURL, neutralizing an absolute-URL open-redirect attempt", async () => {
    handlerMock.mockResolvedValue(jsonResponse(200));

    await requestMagicLinkAction(
      INITIAL_STATE,
      formData({ email: "user@example.com", next: "https://evil.example.com" }),
    );

    const request = handlerMock.mock.calls[0][0] as Request;
    const body = JSON.parse(await request.text());
    expect(body.callbackURL).toBe("/dashboard");
  });

  it("passes through a safe next path as callbackURL", async () => {
    handlerMock.mockResolvedValue(jsonResponse(200));

    await requestMagicLinkAction(
      INITIAL_STATE,
      formData({ email: "user@example.com", next: "/dashboard/domains/new" }),
    );

    const request = handlerMock.mock.calls[0][0] as Request;
    const body = JSON.parse(await request.text());
    expect(body.callbackURL).toBe("/dashboard/domains/new");
  });

  it("maps a 429 response to rate_limited", async () => {
    handlerMock.mockResolvedValue(new Response(null, { status: 429 }));

    const result = await requestMagicLinkAction(INITIAL_STATE, formData({ email: "user@example.com" }));

    expect(result).toEqual({ status: "error", errorCode: "rate_limited", email: "user@example.com" });
  });

  it("maps any other failure status to unknown", async () => {
    handlerMock.mockResolvedValue(new Response("boom", { status: 500 }));

    const result = await requestMagicLinkAction(INITIAL_STATE, formData({ email: "user@example.com" }));

    expect(result).toEqual({ status: "error", errorCode: "unknown", email: "user@example.com" });
  });

  it("maps a thrown error to unknown", async () => {
    handlerMock.mockRejectedValue(new Error("network down"));

    const result = await requestMagicLinkAction(INITIAL_STATE, formData({ email: "user@example.com" }));

    expect(result).toEqual({ status: "error", errorCode: "unknown", email: "user@example.com" });
  });
});

describe("signOutAction", () => {
  beforeEach(() => {
    signOutMock.mockReset();
    redirectMock.mockClear();
    incomingHeaders = new Headers();
  });

  it("calls auth.api.signOut and redirects to /login", async () => {
    signOutMock.mockResolvedValue(undefined);

    await expect(signOutAction()).rejects.toThrow("REDIRECT:/login");

    expect(signOutMock).toHaveBeenCalledTimes(1);
  });

  it("still redirects to /login when signOut itself throws", async () => {
    signOutMock.mockRejectedValue(new Error("session already gone"));

    await expect(signOutAction()).rejects.toThrow("REDIRECT:/login");
  });
});
