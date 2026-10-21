// The trigger surface every caller actually uses (decisions/0016-processing-pipeline-and-ai.md):
// the upload route's `after()`, the cron sweeper, and a workspace-scoped "kick" from the UI
// all call this one function. It is a thin wrapper: the real claim/dispatch/backoff logic
// lives in `src/persistence/use-cases/jobs-use-cases.ts` (the generic runner, its `handlers`
// map built once by the composition root from each owning module's own use-case methods -
// "handlers registered where they belong", this owner never imports a module directly).
import "server-only";

import { getRequestServices } from "@/persistence/composition/request-services";

export type RunDueJobsInput = {
  /** Max number of jobs to claim and run in this call. Default 5. */
  limit?: number;
  /** Restrict claiming to jobs belonging to one workspace (the UI "kick" trigger) - omit
   * for the cron sweeper, which processes every workspace's due jobs. */
  workspaceId?: string;
};

export type RunDueJobsResult = { processed: number };

export async function runDueJobs(input: RunDueJobsInput = {}): Promise<RunDueJobsResult> {
  return getRequestServices().jobs.runDue(input);
}
