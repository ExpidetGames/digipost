// The two error shapes a job handler may throw (decisions/0016-processing-pipeline-and-ai.md).
// `src/persistence/use-cases/jobs-use-cases.ts`'s generic runner only ever distinguishes
// these two kinds - it has no idea what a "transient Mistral 429" or a "permanent invalid
// PDF" actually means, only whether the job is worth retrying. Any other thrown error is
// treated as transient (a bug should be retried and eventually surface via `max_attempts`
// exhaustion, not silently swallowed as permanent on its first occurrence).
export class TransientJobError extends Error {
  override readonly name = "TransientJobError";
  constructor(readonly code: string) {
    super(code);
  }
}

export class PermanentJobError extends Error {
  override readonly name = "PermanentJobError";
  constructor(readonly code: string) {
    super(code);
  }
}
