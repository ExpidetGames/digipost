// The composition root's own small orchestration layer between `src/platform/jobs`'s
// generic dispatcher and each owning module's use-case methods ("handlers registered where
// they belong", decisions/0016-processing-pipeline-and-ai.md). Kept out of
// `src/persistence/use-cases/documents-use-cases.ts` on purpose: a use case must never import
// a module's own `server.ts` (the Neutral-Entrypoint-Regel, WEBAPP_TEMPLATE_SPEC.md §5.4),
// but rendering the quota-warning e-mail needs exactly that (`@/modules/billing/server`'s
// `renderQuotaWarningEmail`). This file is rank `composition` (the top rank), so it may import
// modules' privileged entrypoints the same way `create-request-services.ts` itself binds
// concrete `src/platform/*/server` adapters.
import "server-only";

import { z } from "zod";

import { quotaWarningEmailSubject, renderQuotaWarningEmail } from "@/modules/billing/server";
import { NOTIFIED_REASONS } from "@/modules/mail-intake";
import { mailIntakeNotificationSubject, renderMailIntakeNotificationEmail } from "@/modules/mail-intake/server";
import { TIER_LIMITS, type Tier } from "@/modules/billing";
import { DOCUMENT_KINDS } from "@/modules/intake";
import { MATCH_TRIGGERS } from "@/modules/payments";
import type { AccountsUseCases } from "@/persistence/use-cases/accounts-use-cases";
import {
  DOCUMENT_ERROR,
  type DocumentUseCases,
  type ImportAccountTransactionsInput,
  type ProcessDocumentInput,
  type PurgeRejectedIntakeInput,
} from "@/persistence/use-cases/documents-use-cases";
import { UseCaseError } from "@/persistence/use-cases/errors";
import type { BillingUseCases, SendQuotaWarningInput } from "@/persistence/use-cases/billing-use-cases";
import type { JobHandlers } from "@/persistence/use-cases/jobs-use-cases";
import type { MailIntakeUseCases, ProcessInboundEmailInput, SendMailIntakeNotificationInput } from "@/persistence/use-cases/mail-intake-use-cases";
import type { MatchPaymentsInput, MatchSettlementReportInput, PaymentsUseCases } from "@/persistence/use-cases/payments-use-cases";
import type { WorkspaceUseCases } from "@/persistence/use-cases/workspaces-use-cases";
import { JOB_KINDS, TransientJobError } from "@/platform/jobs";
import { serverEnv } from "@/platform/env/server";
import type { Mailer } from "@/platform/mailer/server";
import type { ObjectStorage } from "@/platform/object-storage";

// `kindOverride` (decisions/0072-correcting-a-document-s-kind.md): only `reclassifyDocument`
// sets it; a payload without it (every upload, every retry) parses exactly as before.
const processDocumentPayloadSchema = z.object({ workspaceId: z.uuid(), documentId: z.uuid(), kindOverride: z.enum(DOCUMENT_KINDS).optional() });
const importAccountTransactionsPayloadSchema = z.object({ workspaceId: z.uuid(), documentId: z.uuid() });
const sendQuotaWarningPayloadSchema = z.object({
  workspaceId: z.uuid(),
  period: z.string(),
  limit: z.enum(["total", "monthly"]),
});
const matchPaymentsPayloadSchema = z.object({ workspaceId: z.uuid(), trigger: z.enum(MATCH_TRIGGERS) });
const matchSettlementLinesPayloadSchema = z.object({ workspaceId: z.uuid(), documentId: z.uuid() });
// F5 (decisions/0027-hardening-and-deletion.md): no `workspaceId` field - the workspace this
// prefix belonged to no longer exists by the time this job runs.
const cleanupWorkspaceStoragePayloadSchema = z.object({ prefix: z.string().min(1) });
const purgeRejectedIntakePayloadSchema = z.object({ workspaceId: z.uuid(), documentId: z.uuid() });
const processInboundEmailPayloadSchema = z.object({ workspaceId: z.uuid(), inboundEmailId: z.uuid() });
const sendMailIntakeNotificationPayloadSchema = z.object({ workspaceId: z.uuid(), inboundEmailId: z.uuid(), reason: z.enum(NOTIFIED_REASONS) });

export function createJobHandlers(deps: {
  documents: DocumentUseCases;
  billing: BillingUseCases;
  workspaces: WorkspaceUseCases;
  accounts: AccountsUseCases;
  payments: PaymentsUseCases;
  mailIntake: MailIntakeUseCases;
  mailer: Mailer;
  objectStorage: ObjectStorage;
}): JobHandlers {
  return {
    [JOB_KINDS.processDocument]: async (payload) => {
      const input: ProcessDocumentInput = processDocumentPayloadSchema.parse(payload);
      await deps.documents.processDocument(input);
      // decisions/0072-correcting-a-document-s-kind.md: open payment suggestions were computed
      // for the document's previous kind/direction/amount. `reclassifyDocumentAction` already
      // cleared them once; this second pass removes any a concurrent matching run created
      // against the old fields while the document was being re-extracted. AI suggestions in
      // particular would otherwise survive every later run (decisions/0045 only recomputes
      // the deterministic ones). The debounced matching run `processOcrDocument` schedules
      // for a still invoice-shaped document then proposes fresh ones. A failure here is logged,
      // not thrown: rethrowing would retry the whole job, OCR and analysis included, for a
      // cleanup the action already did once.
      if (input.kindOverride) {
        try {
          await deps.payments.discardOpenSuggestionsForDocument({ workspaceId: input.workspaceId, documentId: input.documentId });
        } catch (err) {
          console.error("[documents] failed to discard open payment suggestions after re-extraction", { workspaceId: input.workspaceId, documentId: input.documentId, err });
        }
      }
    },

    // F2 (decisions/0024-accounts-and-transactions.md): imports a confirmed bank-statement
    // document's transactions. Idempotent - `accounts.importFromDocument` upserts the same
    // import-batch row by `sourceDocumentId` and skips a transaction already known by its
    // `(accountId, idempotencyKey)`, so a retried/duplicated job run is safe.
    [JOB_KINDS.importAccountTransactions]: async (payload) => {
      const input: ImportAccountTransactionsInput = importAccountTransactionsPayloadSchema.parse(payload);
      await deps.accounts.importFromDocument(input);
    },

    // F3b (decisions/0025-payment-matching-wiring.md): runs the three-stage matching engine
    // for one workspace. Idempotent - re-running finds the same auto-confirms already
    // persisted (never re-decided), the same suggestions upserted in place, and the AI stage's
    // own cache key skips a repeated model call for an unchanged (transaction, candidate set)
    // pairing, so a retried/duplicated job run is safe.
    [JOB_KINDS.matchPayments]: async (payload) => {
      const input: MatchPaymentsInput = matchPaymentsPayloadSchema.parse(payload);
      await deps.payments.runMatching(input);
    },

    // F4 (decisions/0026-platform-settlements.md): matches one confirmed settlement report's
    // revenue lines against outgoing invoices, and re-attempts fee-invoice settlement.
    // Idempotent - `matchSettlementReport` skips a revenue line whose transaction already has
    // a non-rejected `document_transactions` row, so a retried/duplicated job run is safe.
    [JOB_KINDS.matchSettlementLines]: async (payload) => {
      const input: MatchSettlementReportInput = matchSettlementLinesPayloadSchema.parse(payload);
      await deps.payments.matchSettlementReport(input);
    },

    // The 80% quota warning e-mail (P3, decisions/0017-billing-tiers-and-packages.md).
    // Re-reads everything at send time rather than trusting the payload's numbers: the
    // workspace's tier, stored count, and usage may all have moved on between enqueueing
    // (inside `billing-use-cases.ts`'s `recordDocumentsCreated`) and this job actually
    // running (another document created or deleted, a package bought, a tier change) -
    // the mail reports whatever is true right now, addressed to whoever is admin right now.
    [JOB_KINDS.sendQuotaWarning]: async (payload) => {
      const input: SendQuotaWarningInput = sendQuotaWarningPayloadSchema.parse(payload);
      const contact = await deps.workspaces.getWorkspaceWithAdminContact(input.workspaceId);
      if (!contact || !contact.adminEmail) return;

      const tier = contact.workspace.tier as Tier;
      const limits = TIER_LIMITS[tier];

      let current: number;
      let max: number;
      if (input.limit === "total") {
        current = await deps.documents.countStored(input.workspaceId);
        max = limits.totalDocuments;
      } else {
        const usage = await deps.billing.getUsage(input.workspaceId);
        if (limits.monthlyDocuments === null) return; // tier changed to Free since enqueueing: nothing to warn about.
        current = usage.createdThisMonth;
        max = Math.min(limits.monthlyDocuments + usage.extraMonthlyQuota, limits.totalDocuments);
      }

      const url = `${serverEnv().APP_URL}/dashboard/billing`;
      const email = await renderQuotaWarningEmail({ workspaceName: contact.workspace.name, limit: input.limit, current, max, url });
      await deps.mailer.send({
        to: contact.adminEmail,
        subject: quotaWarningEmailSubject(input.limit),
        html: email.html,
        text: email.text,
      });
    },

    // F5 (decisions/0027-hardening-and-deletion.md): the durable retry for workspace-deletion
    // storage cleanup. Idempotent (listing an empty prefix is a no-op success); a non-empty
    // `failedKeys` result throws `TransientJobError` so the job queue's own backoff retries it
    // rather than this handler looping internally.
    [JOB_KINDS.cleanupWorkspaceStorage]: async (payload) => {
      const input = cleanupWorkspaceStoragePayloadSchema.parse(payload);
      const keys = await deps.objectStorage.listObjects(input.prefix);
      if (keys.length === 0) return;
      const { failedKeys } = await deps.objectStorage.deleteObjects(keys);
      if (failedKeys.length > 0) {
        console.error(
          `[workspaces] cleanup-workspace-storage: ${failedKeys.length}/${keys.length} object(s) under ${input.prefix} failed to delete, will retry`,
        );
        throw new TransientJobError("storage_cleanup_incomplete");
      }
    },

    // decisions/0075-email-intake.md: one received mail's attachments become documents.
    // Idempotent - a mail that is no longer `received` is skipped, and per-attachment results
    // stored by an earlier attempt are never redone.
    [JOB_KINDS.processInboundEmail]: async (payload) => {
      const input: ProcessInboundEmailInput = processInboundEmailPayloadSchema.parse(payload);
      await deps.mailIntake.processInboundEmail(input);
    },

    // decisions/0075-email-intake.md: the admin's rejection notice. The throttle was decided
    // when this job was enqueued; this handler only renders and sends, to whoever is admin now.
    [JOB_KINDS.sendMailIntakeNotification]: async (payload) => {
      const input: SendMailIntakeNotificationInput = sendMailIntakeNotificationPayloadSchema.parse(payload);
      const [contact, details] = await Promise.all([
        deps.workspaces.getWorkspaceWithAdminContact(input.workspaceId),
        deps.mailIntake.getNotificationDetails(input),
      ]);
      if (!contact || !contact.adminEmail || !details) return;

      const email = await renderMailIntakeNotificationEmail({
        workspaceName: contact.workspace.name,
        reason: input.reason,
        fromAddress: details.fromAddress,
        subject: details.subject,
        url: `${serverEnv().APP_URL}/dashboard/email-intake`,
      });
      await deps.mailer.send({
        to: contact.adminEmail,
        subject: mailIntakeNotificationSubject(input.reason),
        html: email.html,
        text: email.text,
      });
    },

    // F5 (decisions/0027-hardening-and-deletion.md): the retention cron's actual per-document
    // deletion work, enqueued by `GET /api/cron/purge-rejected-intake` for every intake
    // document rejected more than 30 days ago. Reuses `DocumentUseCases.deleteDocument`
    // unchanged (row + both storage objects, decisions/0012-object-storage.md) - a rejected
    // intake document is an ordinary document row like any other, just one this cron
    // identifies by its own criteria instead of a human clicking "Löschen".
    [JOB_KINDS.purgeRejectedIntake]: async (payload) => {
      const input: PurgeRejectedIntakeInput = purgeRejectedIntakePayloadSchema.parse(payload);
      try {
        await deps.documents.deleteDocument(input);
      } catch (err) {
        // Already deleted (by a user, or a previous/duplicate run of this same cron sweep)
        // - nothing left to purge, not a failure.
        if (err instanceof UseCaseError && err.code === DOCUMENT_ERROR.notFound) return;
        throw err;
      }
    },
  };
}
