import "server-only";

/**
 * Local development only (decisions/0042). Production drives the job queue from an external
 * scheduler calling `GET /api/cron/process-jobs`; `next dev` has none, so retries and the
 * debounced matching run (decisions/0041) would otherwise wait until the next upload happens to
 * kick the queue. Calls that same route with the same bearer secret every 20 seconds, never two
 * calls at once. Started from `src/instrumentation.ts`.
 */
export function startLocalCronSweeper(): void {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.warn("[jobs] local cron sweeper not started: CRON_SECRET is not set");
    return;
  }
  const url = `http://127.0.0.1:${process.env.PORT ?? "3000"}/api/cron/process-jobs`;
  console.info("[jobs] local cron sweeper started", { url, intervalMs: 20_000 });
  let running = false;
  setInterval(() => {
    if (running) return;
    running = true;
    fetch(url, { headers: { authorization: `Bearer ${secret}` } })
      .then((response) => {
        if (!response.ok) console.warn("[jobs] local cron sweep failed", { status: response.status });
      })
      .catch(() => undefined) // the server may still be starting; the next tick retries
      .finally(() => {
        running = false;
      });
  }, 20_000);
}
