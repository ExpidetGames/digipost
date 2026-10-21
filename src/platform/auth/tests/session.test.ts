// Unit tests for getCurrentUser/requireUser (WEBAPP_TEMPLATE_SPEC.md §10.2: mock the
// module path the code under test actually loads, `../server/auth`, not the public
// `server.ts` entrypoint - Vitest's `vi.mock` intercepts by resolved module identity).
// No DB, no network: `getAuth()` itself is never called for real.
//
// `getCurrentUser` is wrapped in React's `cache()`, which memoizes per render; outside
// a real request/render there is no reliable render boundary to key that memoization
// on, so each test re-imports the module fresh (`vi.resetModules()`) to avoid one
// test's mocked result leaking into the next.
import { beforeEach, describe, expect, it, vi } from "vitest";

const getSessionMock = vi.fn();
vi.mock("../server/auth", () => ({
  getAuth: () => ({ api: { getSession: getSessionMock } }),
}));

const headersMock = vi.fn();
vi.mock("next/headers", () => ({
  headers: () => headersMock(),
}));

const redirectMock = vi.fn((url: string) => {
  throw new Error(`REDIRECT:${url}`);
});
vi.mock("next/navigation", () => ({
  redirect: (url: string) => redirectMock(url),
  // A faithful-enough stand-in: only Next's own control-flow errors (our fake
  // "REDIRECT:..." ones, standing in for them here) must propagate past `unstable_rethrow`.
  unstable_rethrow: (err: unknown) => {
    if (err instanceof Error && err.message.startsWith("REDIRECT:")) throw err;
  },
}));

async function freshSession() {
  vi.resetModules();
  return import("../server/session");
}

describe("getCurrentUser", () => {
  beforeEach(() => {
    getSessionMock.mockReset();
    headersMock.mockReset();
    redirectMock.mockClear();
  });

  it("returns null when there is no session", async () => {
    const { getCurrentUser } = await freshSession();
    headersMock.mockResolvedValue(new Headers());
    getSessionMock.mockResolvedValue(null);

    await expect(getCurrentUser()).resolves.toBeNull();
  });

  it("returns the id and email from a real session", async () => {
    const { getCurrentUser } = await freshSession();
    headersMock.mockResolvedValue(new Headers());
    getSessionMock.mockResolvedValue({ user: { id: "u1", email: "a@example.com", extra: "ignored" } });

    await expect(getCurrentUser()).resolves.toEqual({ id: "u1", email: "a@example.com" });
  });

  it("swallows a plain error from getSession and returns null", async () => {
    const { getCurrentUser } = await freshSession();
    headersMock.mockResolvedValue(new Headers());
    getSessionMock.mockRejectedValue(new Error("auth database unreachable"));

    await expect(getCurrentUser()).resolves.toBeNull();
  });
});

describe("requireUser", () => {
  beforeEach(() => {
    getSessionMock.mockReset();
    headersMock.mockReset();
    redirectMock.mockClear();
  });

  it("returns the user without redirecting when signed in", async () => {
    const { requireUser } = await freshSession();
    headersMock.mockResolvedValue(new Headers());
    getSessionMock.mockResolvedValue({ user: { id: "u1", email: "a@example.com" } });

    await expect(requireUser()).resolves.toEqual({ id: "u1", email: "a@example.com" });
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("redirects to /login with next= when signed out and the proxy set the current-path header", async () => {
    const { requireUser } = await freshSession();
    const { CURRENT_PATH_HEADER } = await import("@/platform/auth/proxy-gate");
    const h = new Headers();
    h.set(CURRENT_PATH_HEADER, "/dashboard/settings?x=1");
    headersMock.mockResolvedValue(h);
    getSessionMock.mockResolvedValue(null);

    await expect(requireUser()).rejects.toThrow("REDIRECT:/login?next=%2Fdashboard%2Fsettings%3Fx%3D1");
  });

  it("redirects to plain /login when signed out and no current-path header is set", async () => {
    const { requireUser } = await freshSession();
    headersMock.mockResolvedValue(new Headers());
    getSessionMock.mockResolvedValue(null);

    await expect(requireUser()).rejects.toThrow("REDIRECT:/login");
  });
});
