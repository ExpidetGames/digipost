/**
 * `GET /api/cron/purge-rejected-intake` (F5, decisions/0027-hardening-and-deletion.md's
 * retention cron): the only auto-deletion this product performs. Finds every intake document
 * rejected ("Ablehnen") more than `RETENTION_DAYS_REJECTED_INTAKE` (30) days ago, across every
 * workspace, enqueues a `purge-rejected-intake` job per document (the row + both storage
 * objects, via `DocumentUseCases.deleteDocument`), then sweeps due jobs immediately so the
 * deletions actually happen within this same request rather than waiting for the next
 * `process-jobs` sweep. Secured the same way as `GET /api/cron/process-jobs`
 * (`Authorization: Bearer $CRON_SECRET`, `requireCronSecret`). Nothing else in this product is
 * ever auto-deleted - confirmed imports, invoices, and contacts have statutory retention
 * obligations a rejected proposal (nothing was ever imported) never had.
 */
import {
  createApiHandlerFromContract,
  defineApiEndpointContract,
} from "@/platform/api-pipeline";
import { CronAuthError, requireCronSecret } from "@/platform/api-pipeline/server";
import { runDueJobs } from "@/platform/jobs/server";
import { getRequestServices } from "@/persistence/composition/request-services";

// Generous headroom for a sweep that both enqueues and then immediately runs a batch of
// deletions (each a DB delete plus two best-effort object-storage deletes).
export const maxDuration = 60;

type CronErrorCode = "unauthorized" | "unknown";

const contract = defineApiEndpointContract<CronErrorCode>({
  invalidRequestError: { errorCode: "unknown", status: 400 },
  unknownError: { errorCode: "unknown", status: 500 },
});

const CRON_JOB_LIMIT = 50;

export const GET = createApiHandlerFromContract(contract, {
  access: {
    run: ({ request }) => requireCronSecret(request),
    mapError: (err) => (err instanceof CronAuthError ? { errorCode: "unauthorized", status: 401 } : null),
  },

  parse: {
    run: () => ({}),
  },

  execute: {
    run: async () => {
      const { enqueued } = await getRequestServices().documents.enqueuePurgeForRejectedIntake();
      const { processed } = await runDueJobs({ limit: CRON_JOB_LIMIT });
      return { enqueued, processed };
    },
  },

  respond: {
    run: ({ result }) => Response.json(result, { status: 200 }),
  },
});
