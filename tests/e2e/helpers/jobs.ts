// Job queue helpers for e2e (src/platform/jobs, decisions/0016-processing-pipeline-and-ai.md).
// Talks to Postgres directly with `pg` (e2e imports no app code, `tests/e2e/helpers/db.ts`'s
// own header doc). Observes the queue only: nothing here runs or reschedules a job, so a spec
// proves that the app's own `after()` runner did the work.
import { ownerQuery } from "./db";

/** The database's clock, to mark the start of a step whose matching run a spec waits for. */
export async function databaseNow(): Promise<Date> {
  const [row] = await ownerQuery<{ now: Date }>("select now() as now", []);
  if (!row) throw new Error("select now() returned no row");
  return row.now;
}

/**
 * Waits until the workspace's payment matching has run after a trigger (decisions/0076): at
 * least one `match-payments` job completed since `since`, and no `match-payments` job is due or
 * running any more (`status = 'pending'` with `run_at <= now()`). A finished invoice and an
 * imported statement queue their run due immediately and the same `after()` runner that
 * processed them runs it, so this only waits, it never triggers anything. A follow-up queued
 * hours out (decisions/0039) is not due and is ignored. Fails on timeout, which is exactly the
 * regression this guards against: a run left waiting for the next cron sweep.
 */
export async function waitForPaymentMatching(workspaceId: string, since: Date, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [row] = await ownerQuery<{ done: string; due: string }>(
      `select
         count(*) filter (where status = 'done' and completed_at >= $2) as done,
         count(*) filter (where status = 'pending' and run_at <= now()) as due
       from public.jobs
       where workspace_id = $1 and kind = 'match-payments'`,
      [workspaceId, since],
    );
    if (row && Number(row.done) > 0 && Number(row.due) === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`payment matching of workspace ${workspaceId} did not finish within ${timeoutMs} ms of its trigger`);
}
