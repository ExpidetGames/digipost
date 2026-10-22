// Owner: src/platform/jobs (decisions/0076-match-after-every-trigger.md). How long a job runner
// started from `after()` (the upload route, the Resend webhook, a Server Action's "kick") keeps
// starting new jobs. Production has no frequent cron (decisions/0076: the database must be able
// to scale to zero), so a finished invoice's or an imported statement's `match-payments` run has
// to happen in the same `after()` that processed the trigger. The routes that run jobs after
// their response declare `maxDuration = 300`; a job started just before this budget ends still
// has three minutes to finish (a `process-document` run takes well under one, a matching run
// roughly one to two seconds per AI arbiter call), so the platform never stops a job midway.
export const AFTER_RESPONSE_JOB_BUDGET_MS = 120_000;
