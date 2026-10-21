/**
 * Liveness + DB readiness + deployed-version check (WEBAPP_TEMPLATE_SPEC.md §13.4).
 *
 * Bypasses `src/platform/api-pipeline` on purpose (`src/platform/api-pipeline/README.md`'s
 * adoption boundary): a single trivial check with no request to parse does not need
 * the step machine, and this endpoint's contract (`{ ok, version }`, never
 * `{ errorCode }`) is not the pipeline's error envelope anyway.
 *
 * Reached through the normal composition root (`getRequestServices().system.health()`)
 * like every other request that touches the database - WEBAPP_TEMPLATE_SPEC.md
 * §5.1's "one door in" rule makes no exception for this route just because it has
 * no session: the check is not user data, it is whether `app_runtime` (the role
 * `getDb()` behind `getRequestServices()` connects as) can be reached at all.
 *
 * `version` is `src/platform/env`'s `APP_COMMIT_SHA` (set only by the deploy workflow's
 * step, .github/workflows/deploy-production.yml - unset locally and in every test
 * environment), truncated to a short SHA. That is deliberately the *only* extra
 * thing this route leaks: no full SHA, no branch, no infra detail, and still
 * `Cache-Control: no-store` so no CDN or browser ever caches a stale answer. The
 * post-deploy check (`scripts/deploy/check.mjs`) compares this against the commit it
 * just deployed to catch "the right build didn't actually go live" - the failure
 * mode the version field exists for.
 */
import { serverEnv } from "@/platform/env/server";
import { getRequestServices } from "@/persistence/composition/request-services";

export const dynamic = "force-dynamic";

const SHORT_SHA_LENGTH = 7;

export async function GET(): Promise<Response> {
  const { ok } = await getRequestServices().system.health();
  const commitSha = serverEnv().APP_COMMIT_SHA;
  const version = commitSha ? commitSha.slice(0, SHORT_SHA_LENGTH) : null;
  return Response.json({ ok, version }, { status: ok ? 200 : 503, headers: { "cache-control": "no-store" } });
}
