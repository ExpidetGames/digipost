// Owner: src/modules/mail-intake (decisions/0075-email-intake.md). The E-Mail-Eingang: every
// workspace gets a secret address `post-<token>@<INBOUND_EMAIL_DOMAIN>`; a mail sent there
// reaches `POST /api/webhooks/resend` (metadata only), is logged here, and a job then fetches
// its attachments and turns each supported one into a document through
// `DocumentUseCases.createFromUpload` - the same dedupe, quota checks, storage write and
// `process-document` enqueue an upload gets, with `uploadedByUserId: null`.
//
// Neutral-Entrypoint-Regel (WEBAPP_TEMPLATE_SPEC.md §5.4): only `Repositories`/`UnitOfWork`,
// the injected `InboundMailProvider` port, the sibling `DocumentUseCases`, and pure logic from
// `@/modules/mail-intake`/`@/modules/documents`/`@/modules/intake` neutral entrypoints. The
// admin notification e-mail is rendered by the composition root's job handler
// (`composition/job-handlers.ts`), never here.
//
// Workspace scoping: every admin/member method takes the caller's own resolved workspace id.
// `receiveInboundEmail` is the one deliberately cross-workspace entry point, like the
// retention cron: an unauthenticated (signature-verified) webhook has no session to scope to;
// the secret token in the recipient address is what selects the workspace.
import {
  attachmentDocumentName,
  collectInboundTokens,
  countImported,
  DEFAULT_SENDER_POLICY,
  extractEmailAddress,
  formatInboundAddress,
  generateInboundToken,
  isNotifiedReason,
  isSenderAllowed,
  isSenderAuthenticated,
  MAX_ALLOWED_SENDERS,
  parseInboundRecipient,
  MAX_ATTACHMENT_BYTES,
  normalizeAllowedSenderEntry,
  NOTIFICATION_THROTTLE_MS,
  planAttachments,
  resultFor,
  type AttachmentResult,
  type InboundEmailReason,
  type InboundEmailStatus,
  type InboundEmailView,
  type MailIntakeSettingsView,
  type NotifiedReason,
  type SenderPolicy,
} from "@/modules/mail-intake";
import { MAX_UPLOAD_PAGES, processIntakeUpload } from "@/modules/documents";
import { fileHash } from "@/modules/intake";
import type { InboundEmailRow, MailIntakeSettingsRow, Repositories, UnitOfWork } from "@/persistence/repositories/contracts";
import { DOCUMENT_ERROR, DuplicateDocumentError, type DocumentUseCases } from "@/persistence/use-cases/documents-use-cases";
import { UseCaseError } from "@/persistence/use-cases/errors";
import { isDbError } from "@/persistence/foundation/db-errors";
import {
  INBOUND_MAIL_ERROR_CODES,
  InboundMailError,
  type InboundAttachment,
  type InboundEmailDetails,
  type InboundMailProvider,
  type ReceivedEmail,
} from "@/platform/inbound-mail";
import { JOB_KINDS, TransientJobError } from "@/platform/jobs";

export const MAIL_INTAKE_ERROR = {
  notFound: "not_found",
  invalidSenderEntry: "invalid_sender_entry",
  senderAlreadyAllowed: "sender_already_allowed",
  tooManyAllowedSenders: "too_many_allowed_senders",
} as const;
export type MailIntakeErrorCode = (typeof MAIL_INTAKE_ERROR)[keyof typeof MAIL_INTAKE_ERROR];

/** How many job runs may hit a provider failure before the mail is marked `failed` instead of
 * retried once more. Below the job queue's own default `maxAttempts` (5), so the use case
 * always gets to record the outcome itself rather than leaving the row `received` forever. */
export const MAX_PROCESSING_ATTEMPTS = 4;

/** The log on the settings page: the newest mails first. */
export const INBOUND_EMAIL_LOG_LIMIT = 50;

/** The `process-inbound-email` job's payload. */
export type ProcessInboundEmailInput = { workspaceId: string; inboundEmailId: string };

/** The `send-mail-intake-notification` job's payload. */
export type SendMailIntakeNotificationInput = { workspaceId: string; inboundEmailId: string; reason: NotifiedReason };

export type ReceiveInboundEmailResult = {
  /** Workspaces a log row was newly created for (a webhook retry yields none). */
  workspaceIds: string[];
  /** Enabled workspace addresses matched by a recipient, including already-logged ones. */
  matched: number;
  /** Counts only (never an address): why recipients were dropped. `foreignOrMalformed` is 1
   * when no recipient at all was a well-formed address on our domain. */
  skipped: { foreignOrMalformed: number; unknownToken: number; disabled: number };
};

export interface MailIntakeUseCases {
  /** The settings view for `workspaceId`, creating the settings row (and with it the address)
   * on first use. */
  getSettings(workspaceId: string): Promise<MailIntakeSettingsView>;
  /** A new token: the old address stops working immediately. */
  regenerateAddress(workspaceId: string): Promise<MailIntakeSettingsView>;
  setEnabled(workspaceId: string, enabled: boolean): Promise<void>;
  setSenderPolicy(workspaceId: string, policy: SenderPolicy): Promise<void>;
  addAllowedSender(input: { workspaceId: string; value: string; userId: string | null }): Promise<void>;
  removeAllowedSender(workspaceId: string, id: string): Promise<void>;
  listInboundEmails(workspaceId: string, limit?: number): Promise<InboundEmailView[]>;
  /** The sender of the mail that created `documentId`, or `null` (the document detail's
   * "Per E-Mail von ..." line). */
  getEmailSourceForDocument(workspaceId: string, documentId: string): Promise<{ fromAddress: string } | null>;
  /** The webhook's entry point: one log row and one job per matched, enabled workspace
   * address, idempotent on the provider's email id. Everything else is dropped unstored. */
  receiveInboundEmail(email: ReceivedEmail): Promise<ReceiveInboundEmailResult>;
  /** The `process-inbound-email` job's body. */
  processInboundEmail(input: ProcessInboundEmailInput): Promise<void>;
  /** What the notification e-mail needs; `null` when the mail no longer exists. */
  getNotificationDetails(input: { workspaceId: string; inboundEmailId: string }): Promise<{
    fromAddress: string;
    subject: string | null;
    receivedAt: Date;
    attachments: AttachmentResult[];
  } | null>;
}

export type MailIntakeUseCaseDeps = {
  repos: Repositories;
  uow: UnitOfWork;
  documents: DocumentUseCases;
  inboundMail: InboundMailProvider;
  /** `INBOUND_EMAIL_DOMAIN`, or `null` when this deployment receives no mail. */
  inboundDomain: string | null;
  now?: () => Date;
  generateToken?: () => string;
};

function toInboundEmailView(row: InboundEmailRow): InboundEmailView {
  return {
    id: row.id,
    fromAddress: row.fromAddress,
    subject: row.subject,
    receivedAt: row.receivedAt.toISOString(),
    status: row.status,
    reasonCode: row.reasonCode,
    attachments: row.attachments,
  };
}

/** A stored `From:` header is trimmed to a sane length: it is shown in a table, never parsed
 * again for anything security-relevant. */
function normalizeFromForStorage(from: string): string {
  return (extractEmailAddress(from) ?? from.trim()).slice(0, 320);
}

export function createMailIntakeUseCases(deps: MailIntakeUseCaseDeps): MailIntakeUseCases {
  const now = deps.now ?? (() => new Date());
  const generateToken = deps.generateToken ?? (() => generateInboundToken());

  async function ensureSettings(workspaceId: string): Promise<MailIntakeSettingsRow> {
    const existing = await deps.repos.mailIntake.findSettings(workspaceId);
    if (existing) return existing;
    const workspace = await deps.repos.workspace.findById(workspaceId);
    if (!workspace) throw new UseCaseError(MAIL_INTAKE_ERROR.notFound);
    return deps.repos.mailIntake.ensureSettings(workspaceId, generateToken());
  }

  async function toSettingsView(settings: MailIntakeSettingsRow): Promise<MailIntakeSettingsView> {
    const allowed = await deps.repos.mailIntake.listAllowedSenders(settings.workspaceId);
    return {
      address: deps.inboundDomain ? formatInboundAddress(settings.token, deps.inboundDomain) : null,
      enabled: settings.enabled,
      senderPolicy: settings.senderPolicy,
      allowedSenders: allowed.map((row) => ({ id: row.id, kind: row.kind, value: row.value })),
      tokenRotatedAt: settings.tokenRotatedAt?.toISOString() ?? null,
    };
  }

  /**
   * Writes the mail's final state and, for a reason an admin hears about, enqueues the
   * notification unless one for the same workspace and reason went out within
   * `NOTIFICATION_THROTTLE_MS`. The settings row lock serializes two mails finishing at the
   * same moment, so the throttle never lets both through.
   */
  async function finalize(row: InboundEmailRow, input: { status: InboundEmailStatus; reasonCode: InboundEmailReason | null; attachments: AttachmentResult[] }): Promise<void> {
    await deps.uow.transaction(async (repos) => {
      const at = now();
      let notifiedAt: Date | null = null;
      if (isNotifiedReason(input.reasonCode)) {
        await repos.mailIntake.lockSettings(row.workspaceId);
        const recent = await repos.mailIntake.hasNotificationSince(row.workspaceId, input.reasonCode, new Date(at.getTime() - NOTIFICATION_THROTTLE_MS));
        if (!recent) {
          notifiedAt = at;
          await repos.jobs.enqueue({
            kind: JOB_KINDS.sendMailIntakeNotification,
            workspaceId: row.workspaceId,
            payload: { workspaceId: row.workspaceId, inboundEmailId: row.id, reason: input.reasonCode } satisfies SendMailIntakeNotificationInput,
          });
        }
      }
      await repos.mailIntake.updateInboundEmail(row.workspaceId, row.id, {
        status: input.status,
        reasonCode: input.reasonCode,
        attachments: input.attachments,
        processedAt: at,
        ...(notifiedAt ? { notifiedAt } : {}),
      });
    });
  }

  /** Turns one downloaded attachment into a document, or says why not. Throws only for what a
   * later attempt might fix (an unexpected storage/database error). */
  async function importAttachment(workspaceId: string, attachment: InboundAttachment, bytes: Uint8Array): Promise<AttachmentResult> {
    const meta = { id: attachment.id, fileName: attachment.fileName, sizeBytes: attachment.sizeBytes ?? bytes.byteLength, contentType: attachment.contentType };
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES) return resultFor(meta, "too_large");

    const processed = await processIntakeUpload([bytes], MAX_UPLOAD_PAGES);
    if (!processed.ok) {
      if (processed.errorCode === "unsupported_file_type" || processed.errorCode === "unrecognized_xml_format") return resultFor(meta, "unsupported");
      return resultFor(meta, "invalid", { detail: processed.errorCode });
    }

    const stored =
      processed.data.kind === "pdf_or_image"
        ? { bytes: processed.data.pdfBytes, mimeType: "application/pdf", extension: "pdf", pageCount: processed.data.pageCount }
        : { bytes: processed.data.data.bytes, mimeType: processed.data.data.mimeType, extension: processed.data.data.extension, pageCount: 0 };

    try {
      const document = await deps.documents.createFromUpload({
        workspaceId,
        uploadedByUserId: null,
        originalFileName: attachmentDocumentName(attachment.fileName),
        bytes: stored.bytes,
        mimeType: stored.mimeType,
        extension: stored.extension,
        pageCount: stored.pageCount,
        fileHash: fileHash(stored.bytes),
      });
      return resultFor(meta, "imported", { documentId: document.id });
    } catch (err) {
      if (err instanceof DuplicateDocumentError) return resultFor(meta, "duplicate", { documentId: err.existingDocumentId });
      if (err instanceof UseCaseError && (err.code === DOCUMENT_ERROR.quotaTotalExceeded || err.code === DOCUMENT_ERROR.quotaMonthlyExceeded)) {
        return resultFor(meta, "quota_exceeded");
      }
      throw err;
    }
  }

  return {
    async getSettings(workspaceId) {
      return toSettingsView(await ensureSettings(workspaceId));
    },

    async regenerateAddress(workspaceId) {
      await ensureSettings(workspaceId);
      // A token collision is astronomically unlikely (~98 bits), but the unique constraint is
      // the real guarantee: a second fresh token settles it.
      for (let attempt = 0; ; attempt++) {
        try {
          const updated = await deps.repos.mailIntake.updateSettings(workspaceId, { token: generateToken(), tokenRotatedAt: now() });
          if (!updated) throw new UseCaseError(MAIL_INTAKE_ERROR.notFound);
          return toSettingsView(updated);
        } catch (err) {
          if (attempt < 2 && isDbError(err, "unique")) continue;
          throw err;
        }
      }
    },

    async setEnabled(workspaceId, enabled) {
      await ensureSettings(workspaceId);
      await deps.repos.mailIntake.updateSettings(workspaceId, { enabled });
    },

    async setSenderPolicy(workspaceId, policy) {
      await ensureSettings(workspaceId);
      await deps.repos.mailIntake.updateSettings(workspaceId, { senderPolicy: policy });
    },

    async addAllowedSender({ workspaceId, value, userId }) {
      const entry = normalizeAllowedSenderEntry(value);
      if (!entry) throw new UseCaseError(MAIL_INTAKE_ERROR.invalidSenderEntry);
      await ensureSettings(workspaceId);
      if ((await deps.repos.mailIntake.countAllowedSenders(workspaceId)) >= MAX_ALLOWED_SENDERS) {
        throw new UseCaseError(MAIL_INTAKE_ERROR.tooManyAllowedSenders);
      }
      const row = await deps.repos.mailIntake.addAllowedSender({ workspaceId, kind: entry.kind, value: entry.value, createdByUserId: userId });
      if (!row) throw new UseCaseError(MAIL_INTAKE_ERROR.senderAlreadyAllowed);
    },

    async removeAllowedSender(workspaceId, id) {
      const removed = await deps.repos.mailIntake.removeAllowedSender(workspaceId, id);
      if (!removed) throw new UseCaseError(MAIL_INTAKE_ERROR.notFound);
    },

    async listInboundEmails(workspaceId, limit = INBOUND_EMAIL_LOG_LIMIT) {
      const rows = await deps.repos.mailIntake.listInboundEmails(workspaceId, limit);
      return rows.map(toInboundEmailView);
    },

    async getEmailSourceForDocument(workspaceId, documentId) {
      const row = await deps.repos.mailIntake.findByDocumentId(workspaceId, documentId);
      return row ? { fromAddress: row.fromAddress } : null;
    },

    async receiveInboundEmail(email) {
      // The provider forwards every mail the whole account receives (decisions/0075): anything
      // that is not addressed to an existing, ENABLED workspace address is dropped here without
      // storing a single byte of it - no log row, no job, no notification.
      const skipped = { foreignOrMalformed: 0, unknownToken: 0, disabled: 0 };
      if (!deps.inboundDomain) return { workspaceIds: [], matched: 0, skipped };
      const tokens = collectInboundTokens(email.recipients, deps.inboundDomain);
      skipped.foreignOrMalformed = tokens.length === 0 ? 1 : 0;
      const workspaceIds: string[] = [];
      let matched = 0;

      for (const token of tokens) {
        const settings = await deps.repos.mailIntake.findSettingsByToken(token);
        if (!settings) {
          skipped.unknownToken += 1;
          continue;
        }
        if (!settings.enabled) {
          skipped.disabled += 1;
          continue;
        }
        matched += 1;

        const inserted = await deps.uow.transaction(async (repos) => {
          const row = await repos.mailIntake.insertInboundEmail({
            workspaceId: settings.workspaceId,
            providerEmailId: email.emailId,
            fromAddress: normalizeFromForStorage(email.from),
            subject: email.subject?.slice(0, 998) ?? null,
            messageId: email.messageId?.slice(0, 998) ?? null,
            receivedAt: email.receivedAt ?? now(),
            status: "received",
            reasonCode: null,
          });
          if (row) {
            await repos.jobs.enqueue({
              kind: JOB_KINDS.processInboundEmail,
              workspaceId: settings.workspaceId,
              payload: { workspaceId: settings.workspaceId, inboundEmailId: row.id } satisfies ProcessInboundEmailInput,
            });
          }
          return row;
        });
        if (inserted) workspaceIds.push(settings.workspaceId);
      }

      return { workspaceIds, matched, skipped };
    },

    async processInboundEmail({ workspaceId, inboundEmailId }) {
      const row = await deps.repos.mailIntake.findInboundEmail(workspaceId, inboundEmailId);
      // Gone (the workspace was deleted) or already final (a duplicate job run): nothing to do.
      if (!row || row.status !== "received") return;

      const attempt = row.attempts + 1;
      await deps.repos.mailIntake.updateInboundEmail(workspaceId, row.id, { attempts: attempt });
      const lastAttempt = attempt >= MAX_PROCESSING_ATTEMPTS;

      const settings = await ensureSettings(workspaceId);

      // The provider's own record of the mail: its recipients (authoritative, where the adapter
      // knows them) and the receiving side's SPF/DKIM/DMARC verdicts.
      let details: InboundEmailDetails;
      try {
        details = await deps.inboundMail.getEmail(row.providerEmailId);
      } catch (err) {
        if (err instanceof InboundMailError && err.retryable && !lastAttempt) throw new TransientJobError(err.code);
        console.error("[mail-intake] retrieving the mail failed for good", { workspaceId, inboundEmailId, code: err instanceof InboundMailError ? err.code : "unknown" });
        await finalize(row, { status: "failed", reasonCode: "provider_unavailable", attachments: row.attachments });
        return;
      }

      // The webhook already matched this workspace; the retrieved recipient list must agree
      // that the mail went to this workspace's CURRENT address (an address rotated in the
      // meantime stops working, exactly as the "Neue Adresse erzeugen" confirmation says).
      if (details.recipients !== null && deps.inboundDomain) {
        const domain = deps.inboundDomain;
        const addressedHere = details.recipients.some((recipient) => parseInboundRecipient(recipient, domain) === settings.token);
        if (!addressedHere) {
          await finalize(row, { status: "rejected", reasonCode: "recipient_not_matched", attachments: [] });
          return;
        }
      }

      const policy = settings.senderPolicy ?? DEFAULT_SENDER_POLICY;
      const [allowed, members] = await Promise.all([
        deps.repos.mailIntake.listAllowedSenders(workspaceId),
        deps.repos.workspaceMember.listByWorkspace(workspaceId),
      ]);
      const senderAllowed = isSenderAllowed({
        policy,
        from: row.fromAddress,
        entries: allowed.map((entry) => ({ kind: entry.kind, value: entry.value })),
        memberEmails: members.map((member) => member.email),
      });
      if (!senderAllowed) {
        await finalize(row, { status: "rejected", reasonCode: "sender_not_allowed", attachments: [] });
        return;
      }
      // Under "only specific senders" a `From:` must be authenticated too, or the allowlist
      // could be passed with a forged address. "Everyone" checks nothing by definition.
      if (policy === "allowlist" && !isSenderAuthenticated(details.authentication)) {
        await finalize(row, { status: "rejected", reasonCode: "sender_not_authenticated", attachments: [] });
        return;
      }

      let listed: InboundAttachment[];
      try {
        listed = await deps.inboundMail.listAttachments(row.providerEmailId);
      } catch (err) {
        if (err instanceof InboundMailError && err.retryable && !lastAttempt) throw new TransientJobError(err.code);
        console.error("[mail-intake] listing attachments failed for good", { workspaceId, inboundEmailId, code: err instanceof InboundMailError ? err.code : "unknown" });
        await finalize(row, { status: "failed", reasonCode: "provider_unavailable", attachments: row.attachments });
        return;
      }

      const byId = new Map(listed.map((attachment) => [attachment.id, attachment]));
      const plan = planAttachments(
        listed.map((attachment) => ({ id: attachment.id, fileName: attachment.fileName, sizeBytes: attachment.sizeBytes, contentType: attachment.contentType })),
        row.attachments,
      );

      const results: AttachmentResult[] = plan.map((item) => (item.kind === "done" ? item.result : resultFor(item.attachment, "download_failed")));
      const pending = new Set<number>();
      plan.forEach((item, index) => {
        if (item.kind === "download") pending.add(index);
      });
      let quotaReached = results.some((result) => result.outcome === "quota_exceeded");
      let transientFailure: string | null = null;

      for (const index of [...pending]) {
        const item = plan[index]!;
        if (item.kind !== "download") continue;
        const attachment = byId.get(item.attachment.id)!;

        if (quotaReached) {
          results[index] = resultFor(item.attachment, "quota_exceeded");
          pending.delete(index);
          continue;
        }

        let bytes: Uint8Array;
        try {
          bytes = await deps.inboundMail.downloadAttachment(attachment, MAX_ATTACHMENT_BYTES);
        } catch (err) {
          if (err instanceof InboundMailError && err.code === INBOUND_MAIL_ERROR_CODES.tooLarge) {
            results[index] = resultFor(item.attachment, "too_large");
            pending.delete(index);
            continue;
          }
          // Left as `download_failed` for now; only stored if this is the last attempt.
          transientFailure = err instanceof InboundMailError ? err.code : "download_failed";
          continue;
        }

        results[index] = await importAttachment(workspaceId, attachment, bytes);
        pending.delete(index);
        if (results[index]!.outcome === "quota_exceeded") quotaReached = true;

        // Stored after every attachment: a crash or timeout in the middle never imports an
        // attachment twice on the retry (it is skipped as already handled).
        await deps.repos.mailIntake.updateInboundEmail(workspaceId, row.id, {
          attachments: results.filter((_, i) => !pending.has(i)),
        });
      }

      if (transientFailure && !lastAttempt) {
        await deps.repos.mailIntake.updateInboundEmail(workspaceId, row.id, { attachments: results.filter((_, i) => !pending.has(i)) });
        throw new TransientJobError(transientFailure);
      }

      const imported = countImported(results);
      if (quotaReached) {
        await finalize(row, { status: imported > 0 ? "processed" : "rejected", reasonCode: "quota_exceeded", attachments: results });
        return;
      }
      if (imported === 0) {
        await finalize(row, { status: "rejected", reasonCode: "no_supported_attachment", attachments: results });
        return;
      }
      await finalize(row, { status: "processed", reasonCode: null, attachments: results });
    },

    async getNotificationDetails({ workspaceId, inboundEmailId }) {
      const row = await deps.repos.mailIntake.findInboundEmail(workspaceId, inboundEmailId);
      if (!row) return null;
      return { fromAddress: row.fromAddress, subject: row.subject, receivedAt: row.receivedAt, attachments: row.attachments };
    },
  };
}
