/**
 * Neutral entrypoint (WEBAPP_TEMPLATE_SPEC.md §4.2): job kinds, the two error shapes a
 * handler throws, the pure backoff function, and the `after()` runner time budget - all safe to import from
 * `src/persistence/use-cases/**` (persistence may import platform, WEBAPP_TEMPLATE_SPEC.md
 * §4's direction matrix) or any other non-privileged code. No I/O, no `server-only`.
 */
export { computeBackoffMs, type BackoffOptions } from "./core/backoff";
export { PermanentJobError, TransientJobError } from "./core/errors";
export { JOB_KINDS, type JobKind } from "./core/job-kinds";
export { AFTER_RESPONSE_JOB_BUDGET_MS } from "./core/run-budget";
