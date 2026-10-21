#!/usr/bin/env node
// node scripts/deploy/check.mjs <url> [--expect-version=<short-sha>]
//
// The post-deploy check of .github/workflows/deploy-production.yml's `health` job (WEBAPP_TEMPLATE_SPEC.md
// §13.4, decisions/0073-public-repo-and-production-pipeline.md). It runs against the STAGED production deployment
// (a domain-less `https://<hash>.vercel.app` address, before `vercel promote`) and answers a different question
// than the E2E @smoke set: not "does the app work" (that passed in CI) but "is THIS deployment wired correctly" -
// env vars present in Vercel, the runtime DB role reachable, the right build actually staged. It never logs in
// and never writes data (safe against production), needs no browser and no dependency beyond Node's built-in
// fetch, so the job needs no `pnpm install`.
//
// The staged address is under Vercel Deployment Protection. The project's Protection Bypass for Automation
// secret opens it: set it in the environment variable DEPLOY_CHECK_BYPASS_SECRET (never as an argument, which
// would show up in the process list) and every request carries it as `x-vercel-protection-bypass`. The secret is
// only ever sent to an https `*.vercel.app` address and no redirect is followed with it.
//
// Waits for a first healthy /api/health (a fresh deployment cold-starts, a database may be waking up), then runs
// each check once and exits non-zero with a clear reason on the first failure:
//   1. GET /api/health  -> 200, { ok: true } and - when --expect-version is given - `version` equal to it (proves
//      the staged build is the commit that was just deployed, not a stale one).
//   2. GET /            -> 200, contains the landing page's brand name.
//   3. GET /login       -> 200, contains the sign-in heading ("Anmelden": the UI is German-only,
//      decisions/0013-german-ui-language.md).
//   4. GET /dashboard   -> redirected (no cookie sent) to /login, proving src/proxy.ts's cookie-presence guard and
//      the (app) layout's real session check are both live.
// Only status codes and fixed phrases are printed, never a response body or a header.

import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

export const MARKETING_TITLE = "Digipost";
export const LOGIN_HEADING = "Anmelden";
export const BYPASS_HEADER = "x-vercel-protection-bypass";

const DEFAULTS = {
  healthWaitTimeoutMs: 300_000,
  healthPollIntervalMs: 10_000,
  requestTimeoutMs: 15_000,
};

export class CheckFailure extends Error {
  constructor(message) {
    super(message);
    this.name = "CheckFailure";
  }
}

/** `--expect-version=<sha>` and the positional URL. Returns null for a missing URL. */
export function parseArgs(argv) {
  const [rawUrl, ...rest] = argv;
  if (!rawUrl) return null;
  const versionArg = rest.find((arg) => arg.startsWith("--expect-version="));
  return {
    baseUrl: rawUrl.replace(/\/+$/, ""),
    expectVersion: versionArg ? versionArg.slice("--expect-version=".length) : undefined,
  };
}

/** The bypass secret may only be sent to a Vercel deployment address, over https. */
export function assertBypassTarget(baseUrl) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new CheckFailure("the deployment address is not a valid URL");
  }
  if (url.protocol !== "https:" || !url.hostname.endsWith(".vercel.app") || url.username || url.password) {
    throw new CheckFailure("refusing to send the protection bypass secret anywhere but an https *.vercel.app address");
  }
}

/** Pure verdict on the /api/health answer. Returns an error message, or null when it is fine. */
export function healthProblem(status, body, expectVersion) {
  if (status !== 200) return `HTTP ${status}`;
  if (body === null || typeof body !== "object" || body.ok !== true) return "responded with ok: false or an unexpected body";
  if (expectVersion !== undefined && body.version !== expectVersion) {
    return `version mismatch: expected "${expectVersion}", got "${body.version ?? "null"}" - the staged deployment is not running the commit that was just deployed`;
  }
  return null;
}

/**
 * Runs every check. All I/O is injected (`fetchImpl`, `sleepImpl`, `log`) so the unit tests need no network.
 * Throws CheckFailure on the first failed check.
 *
 * @param {{
 *   baseUrl: string,
 *   expectVersion?: string,
 *   bypassSecret?: string,
 *   fetchImpl?: typeof fetch,
 *   sleepImpl?: (ms: number) => Promise<unknown>,
 *   log?: (line: string) => void,
 *   healthWaitTimeoutMs?: number,
 *   healthPollIntervalMs?: number,
 *   requestTimeoutMs?: number,
 * }} options
 */
export async function runChecks({
  baseUrl,
  expectVersion,
  bypassSecret,
  fetchImpl = fetch,
  sleepImpl = sleep,
  log = console.log,
  ...overrides
}) {
  const options = { ...DEFAULTS, ...overrides };
  if (bypassSecret) assertBypassTarget(baseUrl);

  async function request(path, init = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.requestTimeoutMs);
    try {
      return await fetchImpl(`${baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          "cache-control": "no-cache",
          ...(bypassSecret ? { [BYPASS_HEADER]: bypassSecret } : {}),
          ...(init.headers ?? {}),
        },
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async function checkHealth() {
    const deadline = Date.now() + options.healthWaitTimeoutMs;
    let lastProblem = "no attempt made";
    for (let attempt = 1; ; attempt++) {
      try {
        const response = await request("/api/health", { redirect: "manual" });
        // Deployment Protection answers 401 (or a 3xx to its login page) when the bypass secret is missing or
        // wrong. Retrying cannot fix that, so fail at once with the reason.
        if (response.status === 401 || response.status === 403 || (response.status >= 300 && response.status < 400)) {
          throw new CheckFailure(
            `/api/health -> HTTP ${response.status}: Vercel Deployment Protection did not accept the request. Check the project's Protection Bypass for Automation secret (VERCEL_APP_AUTOMATION_BYPASS_SECRET in Infisical /ci).`,
          );
        }
        let body = null;
        try {
          body = await response.json();
        } catch {
          // not JSON: healthProblem() reports it
        }
        const problem = healthProblem(response.status, body, expectVersion);
        if (problem === null) {
          log(`  /api/health -> 200 { ok: true, version: ${JSON.stringify(body.version ?? null)} } (attempt ${attempt})`);
          return;
        }
        // A wrong version will not fix itself either: fail fast instead of waiting out the whole window.
        if (response.status === 200 && body?.ok === true) throw new CheckFailure(`/api/health ${problem}`);
        lastProblem = problem;
      } catch (err) {
        if (err instanceof CheckFailure) throw err;
        lastProblem = err instanceof Error ? err.message : String(err);
      }
      if (Date.now() >= deadline) {
        throw new CheckFailure(
          `/api/health never became healthy within ${options.healthWaitTimeoutMs / 1000}s (last attempt: ${lastProblem})`,
        );
      }
      log(`  /api/health attempt ${attempt}: ${lastProblem}`);
      await sleepImpl(options.healthPollIntervalMs);
    }
  }

  async function checkPageContains(path, marker, label) {
    const response = await request(path, { redirect: "manual" });
    if (response.status !== 200) throw new CheckFailure(`GET ${path} -> HTTP ${response.status}, expected 200`);
    const text = await response.text();
    if (!text.includes(marker)) throw new CheckFailure(`GET ${path} -> 200 but missing expected content (${label})`);
    log(`  ${path} -> 200, ${label} present`);
  }

  async function checkDashboardRedirectsToLogin() {
    const response = await request("/dashboard", { redirect: "manual" });
    const location = response.headers.get("location") ?? "";
    const isRedirect = response.status >= 300 && response.status < 400;
    if (!isRedirect || !location.includes("/login")) {
      throw new CheckFailure(
        `GET /dashboard (no cookie) -> expected a redirect to /login, got HTTP ${response.status} Location: ${location || "(none)"}`,
      );
    }
    log(`  /dashboard (no cookie) -> ${response.status} redirect to ${location}`);
  }

  log(`Deploy check against ${baseUrl}${expectVersion ? ` (expecting version ${expectVersion})` : ""}`);
  await checkHealth();
  await checkPageContains("/", MARKETING_TITLE, "landing page title");
  await checkPageContains("/login", LOGIN_HEADING, "sign-in heading");
  await checkDashboardRedirectsToLogin();
  log("All deploy checks passed.");
}

// Runs only when started as a script, not when a test imports the functions above.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    console.error("Usage: node scripts/deploy/check.mjs <url> [--expect-version=<short-sha>]");
    process.exit(2);
  }
  try {
    await runChecks({ ...args, bypassSecret: process.env.DEPLOY_CHECK_BYPASS_SECRET || undefined });
  } catch (err) {
    console.error(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
