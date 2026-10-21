// Pure exponential backoff with jitter (WEBAPP_TEMPLATE_SPEC.md §14's jobqueue recipe:
// "Claim ... Lease ... Backoff"). No I/O, no clock: `now`/randomness are always the
// caller's job, so this is trivially unit-tested and trivially deterministic in a test.
export type BackoffOptions = {
  /** Delay before the first retry (attempt 1), in milliseconds. Default 30s: Mistral's limits are
   * per minute (requests and tokens), so a retry within seconds hits the same exhausted window
   * (decisions/0042: 29 of 71 bulk-uploaded receipts burned all five attempts in about a minute). */
  baseMs?: number;
  /** Upper bound the exponential growth never exceeds, before jitter. Default 10 minutes. */
  maxMs?: number;
  /** Injectable randomness in [0, 1). Default `Math.random`. */
  random?: () => number;
};

/**
 * `attempt` is the 1-based number of attempts already made (the attempt that just failed).
 * Returns a delay in milliseconds: `min(maxMs, baseMs * 2^(attempt-1))`, then scaled by a
 * "half jitter" factor in `[0.5, 1)` so many jobs failing at once do not all retry at
 * exactly the same instant (thundering herd).
 */
export function computeBackoffMs(attempt: number, options: BackoffOptions = {}): number {
  const baseMs = options.baseMs ?? 30_000;
  const maxMs = options.maxMs ?? 10 * 60_000;
  const random = options.random ?? Math.random;

  const safeAttempt = Math.max(1, Math.floor(attempt));
  const exponential = Math.min(maxMs, baseMs * 2 ** (safeAttempt - 1));
  const jitterFactor = 0.5 + random() * 0.5;
  return Math.round(exponential * jitterFactor);
}
