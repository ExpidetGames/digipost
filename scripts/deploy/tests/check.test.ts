// Unit tests for scripts/deploy/check.mjs (the staged-deployment health check of
// .github/workflows/deploy-production.yml): every I/O call is injected, no network.
import { describe, expect, it, vi } from "vitest";

import {
  BYPASS_HEADER,
  CheckFailure,
  LOGIN_HEADING,
  assertBypassTarget,
  healthProblem,
  parseArgs,
  runChecks,
} from "../check.mjs";

const BASE = "https://digipost-abc123.vercel.app";
const SHA = "abc1234";

type Route = { status: number; body?: string; location?: string };

/** A fetch fake serving `routes` by path, recording every request's headers. */
function fakeFetch(routes: Record<string, Route | Route[]>) {
  const calls: { path: string; headers: Record<string, string> }[] = [];
  const counters = new Map<string, number>();
  const impl = async (input: string, init?: { headers?: Record<string, string> }) => {
    const path = input.slice(BASE.length);
    calls.push({ path, headers: init?.headers ?? {} });
    const entry = routes[path];
    if (!entry) throw new Error(`unexpected request to ${path}`);
    const index = counters.get(path) ?? 0;
    counters.set(path, index + 1);
    const route = Array.isArray(entry) ? entry[Math.min(index, entry.length - 1)] : entry;
    return new Response(route.body ?? "", {
      status: route.status,
      headers: route.location ? { location: route.location } : {},
    });
  };
  return { impl: impl as unknown as typeof fetch, calls };
}

const healthy = (version: string | null = SHA): Route => ({ status: 200, body: JSON.stringify({ ok: true, version }) });

const goodRoutes = (): Record<string, Route | Route[]> => ({
  "/api/health": healthy(),
  "/": { status: 200, body: "<title>Digipost</title>" },
  "/login": { status: 200, body: `<h1>${LOGIN_HEADING}</h1>` },
  "/dashboard": { status: 307, location: "/login" },
});

describe("parseArgs", () => {
  it("returns null without a URL", () => {
    expect(parseArgs([])).toBeNull();
  });

  it("strips trailing slashes and reads --expect-version", () => {
    expect(parseArgs([`${BASE}//`, `--expect-version=${SHA}`])).toEqual({ baseUrl: BASE, expectVersion: SHA });
    expect(parseArgs([BASE])).toEqual({ baseUrl: BASE, expectVersion: undefined });
  });
});

describe("assertBypassTarget", () => {
  it("accepts an https vercel.app deployment address", () => {
    expect(() => assertBypassTarget(BASE)).not.toThrow();
  });

  it.each([
    "http://digipost-abc123.vercel.app",
    "https://example.com",
    "https://vercel.app.example.com",
    "https://user:pw@digipost-abc123.vercel.app",
    "not a url",
  ])("refuses %s", (url) => {
    expect(() => assertBypassTarget(url)).toThrow(CheckFailure);
  });
});

describe("healthProblem", () => {
  it("is null for a healthy answer with the expected version", () => {
    expect(healthProblem(200, { ok: true, version: SHA }, SHA)).toBeNull();
    expect(healthProblem(200, { ok: true, version: null }, undefined)).toBeNull();
  });

  it("names a non-200, an unhealthy body and a version mismatch", () => {
    expect(healthProblem(503, { ok: false }, SHA)).toBe("HTTP 503");
    expect(healthProblem(200, { ok: false }, SHA)).toMatch(/ok: false/);
    expect(healthProblem(200, { ok: true, version: "old0000" }, SHA)).toMatch(/version mismatch/);
    expect(healthProblem(200, { ok: true, version: null }, SHA)).toMatch(/got "null"/);
  });
});

describe("runChecks", () => {
  const quiet = { log: () => undefined, sleepImpl: async () => undefined };

  it("passes against a correct deployment and sends the bypass header on every request", async () => {
    const { impl, calls } = fakeFetch(goodRoutes());

    await runChecks({ baseUrl: BASE, expectVersion: SHA, bypassSecret: "secret-value", fetchImpl: impl, ...quiet });

    expect(calls.map((c) => c.path)).toEqual(["/api/health", "/", "/login", "/dashboard"]);
    for (const call of calls) expect(call.headers[BYPASS_HEADER]).toBe("secret-value");
  });

  it("sends no bypass header without a secret", async () => {
    const { impl, calls } = fakeFetch(goodRoutes());

    await runChecks({ baseUrl: BASE, fetchImpl: impl, ...quiet });

    for (const call of calls) expect(call.headers[BYPASS_HEADER]).toBeUndefined();
  });

  it("refuses to send the secret to a foreign host before any request", async () => {
    const { impl, calls } = fakeFetch(goodRoutes());

    await expect(
      runChecks({ baseUrl: "https://example.com", bypassSecret: "secret-value", fetchImpl: impl, ...quiet }),
    ).rejects.toThrow(/refusing to send/);
    expect(calls).toHaveLength(0);
  });

  it("waits for a deployment that is still starting", async () => {
    const routes = goodRoutes();
    routes["/api/health"] = [{ status: 503, body: JSON.stringify({ ok: false }) }, { status: 502 }, healthy()];
    const { impl } = fakeFetch(routes);
    const sleepImpl = vi.fn(async () => undefined);

    await runChecks({ baseUrl: BASE, expectVersion: SHA, fetchImpl: impl, log: () => undefined, sleepImpl });

    expect(sleepImpl).toHaveBeenCalledTimes(2);
  });

  it("gives up with the last problem once the health window is over", async () => {
    const routes = goodRoutes();
    routes["/api/health"] = { status: 503, body: JSON.stringify({ ok: false }) };
    const { impl } = fakeFetch(routes);

    await expect(
      runChecks({ baseUrl: BASE, fetchImpl: impl, healthWaitTimeoutMs: 0, ...quiet }),
    ).rejects.toThrow(/never became healthy.*HTTP 503/);
  });

  it("fails at once, without retrying, when Deployment Protection rejects the request", async () => {
    const routes = goodRoutes();
    routes["/api/health"] = { status: 401 };
    const { impl, calls } = fakeFetch(routes);

    await expect(runChecks({ baseUrl: BASE, fetchImpl: impl, ...quiet })).rejects.toThrow(/Deployment Protection/);
    expect(calls).toHaveLength(1);
  });

  it("fails at once on a version mismatch", async () => {
    const routes = goodRoutes();
    routes["/api/health"] = healthy("old0000");
    const { impl, calls } = fakeFetch(routes);

    await expect(runChecks({ baseUrl: BASE, expectVersion: SHA, fetchImpl: impl, ...quiet })).rejects.toThrow(
      /version mismatch/,
    );
    expect(calls).toHaveLength(1);
  });

  it("fails when the sign-in page lacks the German heading", async () => {
    const routes = goodRoutes();
    routes["/login"] = { status: 200, body: "<h1>Sign in</h1>" };
    const { impl } = fakeFetch(routes);

    await expect(runChecks({ baseUrl: BASE, fetchImpl: impl, ...quiet })).rejects.toThrow(/sign-in heading/);
  });

  it("fails when /dashboard does not redirect to /login", async () => {
    const routes = goodRoutes();
    routes["/dashboard"] = { status: 200, body: "dashboard" };
    const { impl } = fakeFetch(routes);

    await expect(runChecks({ baseUrl: BASE, fetchImpl: impl, ...quiet })).rejects.toThrow(/redirect to \/login/);
  });
});
