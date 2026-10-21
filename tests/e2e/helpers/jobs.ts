// Job queue helpers for e2e (src/platform/jobs, decisions/0016-processing-pipeline-and-ai.md).
// Talks to Postgres directly with `pg` (e2e imports no app code, `tests/e2e/helpers/db.ts`'s
// own header doc) and drives the queue through the real cron route.
import { ownerQuery } from "./db";
import { requireEnv } from "./env";

/**
 * Runs the workspace's pending `match-payments` job now instead of after its debounce
 * (`MATCHING_DEBOUNCE_MS`, decisions/0041): moves the job's `run_at` to now, then calls
 * `GET /api/cron/process-jobs` with `CRON_SECRET` until that job has run. Only the jobs pending
 * at the call are waited for: a run that leaves a suggestion open queues its own follow-up
 * hours out (decisions/0039), which this helper leaves alone. The job itself, its handler and
 * the cron route are the real ones; only the wait is skipped.
 */
export async function runPaymentMatchingNow(workspaceId: string, baseURL: string, timeoutMs = 20_000): Promise<void> {
  const jobs = await ownerQuery<{ id: string }>(
    `update public.jobs set run_at = now()
     where workspace_id = $1 and kind = 'match-payments' and status = 'pending'
     returning id`,
    [workspaceId],
  );
  if (jobs.length === 0) throw new Error(`workspace ${workspaceId} has no pending match-payments job`);
  const ids = jobs.map((job) => job.id);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(new URL("/api/cron/process-jobs", baseURL), {
      headers: { authorization: `Bearer ${requireEnv("CRON_SECRET")}` },
    });
    if (!response.ok) throw new Error(`GET /api/cron/process-jobs answered ${response.status}`);
    const pending = await ownerQuery<{ id: string }>(`select id from public.jobs where id = any($1::uuid[]) and status = 'pending'`, [ids]);
    if (pending.length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`the match-payments job of workspace ${workspaceId} was still pending after ${timeoutMs} ms`);
}
