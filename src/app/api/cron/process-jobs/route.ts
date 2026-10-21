/**
 * `GET /api/cron/process-jobs` (decisions/0016-processing-pipeline-and-ai.md): the job
 * queue's sweeper, secured by `Authorization: Bearer $CRON_SECRET`
 * (`src/platform/api-pipeline/server/cron-auth.ts`, this pipeline's first real
 * `requireCronSecret` adopter). Claims and runs due jobs across every workspace (no
 * `workspaceId` filter, unlike the UI's own workspace-scoped "kick",
 * `src/modules/documents/actions.ts`'s `kickProcessingAction`). `vercel.json`'s cron entry
 * points here; Vercel Hobby only allows a daily schedule (decisions/0016's "Consequences"),
 * so production needs Vercel Pro or an external scheduler hitting this same URL more often.
 */
import {
  createApiHandlerFromContract,
  defineApiEndpointContract,
} from "@/platform/api-pipeline";
import { CronAuthError, requireCronSecret } from "@/platform/api-pipeline/server";
import { runDueJobs } from "@/platform/jobs/server";

// Generous headroom for a sweep that claims several jobs, each potentially calling Mistral
// OCR/chat over HTTP.
export const maxDuration = 60;

type CronErrorCode = "unauthorized" | "unknown";

const contract = defineApiEndpointContract<CronErrorCode>({
  invalidRequestError: { errorCode: "unknown", status: 400 },
  unknownError: { errorCode: "unknown", status: 500 },
});

const CRON_JOB_LIMIT = 20;

export const GET = createApiHandlerFromContract(contract, {
  access: {
    run: ({ request }) => requireCronSecret(request),
    mapError: (err) => (err instanceof CronAuthError ? { errorCode: "unauthorized", status: 401 } : null),
  },

  parse: {
    run: () => ({}),
  },

  execute: {
    run: () => runDueJobs({ limit: CRON_JOB_LIMIT }),
  },

  respond: {
    run: ({ result }) => Response.json({ processed: result.processed }, { status: 200 }),
  },
});
