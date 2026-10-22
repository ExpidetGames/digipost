// Stable job kind identifiers (AGENTS.md "Code": `as const` sets, never raw text). This
// owner (src/platform/jobs) only ever sees a `kind` string to dispatch on - it has no idea
// what "process-document" actually does (WEBAPP_TEMPLATE_SPEC.md §14's jobqueue recipe: keep
// the queue itself domain-free). The literal values are also stored in the `jobs.kind`
// database column, so they must never be renamed without a data migration.
export const JOB_KINDS = {
  processDocument: "process-document",
  /** The 80% quota warning e-mail (P3, decisions/0017-billing-tiers-and-packages.md),
   * enqueued by `src/persistence/use-cases/billing-use-cases.ts`'s `recordDocumentsCreated`. */
  sendQuotaWarning: "send-quota-warning",
  /** F2 (decisions/0024-accounts-and-transactions.md): imports a confirmed bank-statement
   * document's transactions into `src/modules/accounts`, enqueued by
   * `src/persistence/use-cases/documents-use-cases.ts` the moment a document's
   * `intakeStatus` becomes `confirmed` with kind `bank_statement` (both the camt.053 branch
   * and a confirmed tabular mapping, never a settlement/payout report). */
  importAccountTransactions: "import-account-transactions",
  /** F3b (decisions/0025-payment-matching-wiring.md): runs `PaymentsUseCases.runMatching` for
   * one workspace - enqueued after every successful import batch (F2) and after every
   * document reaches `done` with invoice fields (C2), and self-rescheduled by `runMatching`
   * itself (a few hours out, `trigger: "cron"`) as long as the workspace still has an
   * unresolved suggestion or unmatched transaction; the existing sweep
   * (`GET /api/cron/process-jobs`) then simply picks it up like any other due job, no
   * dedicated cron route needed for this phase. */
  matchPayments: "match-payments",
  /** F4 (decisions/0026-platform-settlements.md): matches one confirmed settlement report's
   * `revenue` lines against the workspace's outgoing invoices and attempts fee-invoice
   * settlement, enqueued by `src/persistence/use-cases/accounts-use-cases.ts`'s
   * `importSettlementReport` the moment it inserts at least one new settlement line. Kept
   * separate from `match-payments` (never folded into `runMatching`'s own per-transaction
   * loop): a settlement report's revenue-line transactions live on a `clearing` account,
   * excluded from `match-payments`' own transaction pool entirely - they need
   * `@/modules/payments`'s `decomposeSettlement`/`matchSettlementLinesToDocuments`, not the
   * three-stage engine. */
  matchSettlementLines: "match-settlement-lines",
  /** F5 (decisions/0027-hardening-and-deletion.md): retries the object-storage cleanup for a
   * just-deleted workspace's `workspaces/<id>/` prefix - enqueued (with `workspaceId: null`,
   * so it survives the very cascade delete it is cleaning up after) inside the same
   * transaction as `WorkspaceUseCases.deleteWorkspace`'s row delete, as a durable safety net
   * alongside the synchronous best-effort attempt the Server Action also makes. Idempotent:
   * listing an already-empty prefix is a no-op success. */
  cleanupWorkspaceStorage: "cleanup-workspace-storage",
  /** F5 (decisions/0027-hardening-and-deletion.md): the retention cron
   * (`GET /api/cron/purge-rejected-intake`) enqueues one of these per workspace that has at
   * least one intake document rejected more than 30 days ago, so the actual deletion work
   * (DB row + storage object, `DocumentUseCases.deleteDocument`) runs through the same
   * job-queue retry/backoff machinery as everything else, rather than the cron route doing
   * unbounded work synchronously within its own request. */
  purgeRejectedIntake: "purge-rejected-intake",
  /** decisions/0075-email-intake.md: turns one received mail's attachments into documents
   * (sender policy, fresh attachment listing, download, `createFromUpload` per attachment),
   * enqueued by the `POST /api/webhooks/resend` route in the same transaction that stores the
   * mail's log row. Idempotent: per-attachment results are stored as they happen, so a retry
   * skips everything already handled. */
  processInboundEmail: "process-inbound-email",
  /** decisions/0075-email-intake.md: the admin's "a mail was rejected" e-mail, enqueued (at
   * most once per workspace and reason per 24 hours) by the `process-inbound-email` handler. */
  sendMailIntakeNotification: "send-mail-intake-notification",
} as const;
export type JobKind = (typeof JOB_KINDS)[keyof typeof JOB_KINDS];
