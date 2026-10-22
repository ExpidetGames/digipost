// Owner: src/modules/mail-intake (decisions/0075-email-intake.md). Contracts only: no Drizzle
// import besides type-only schema references.
import type { InferSelectModel } from "drizzle-orm";

import type { AllowedSenderKind, AttachmentResult, InboundEmailReason, InboundEmailStatus, SenderPolicy } from "@/modules/mail-intake";
import type { inboundEmails, mailIntakeAllowedSenders, mailIntakeSettings } from "@/persistence/schema/mail-intake";

export type MailIntakeSettingsRow = InferSelectModel<typeof mailIntakeSettings>;
export type MailIntakeAllowedSenderRow = InferSelectModel<typeof mailIntakeAllowedSenders>;
export type InboundEmailRow = InferSelectModel<typeof inboundEmails>;

export type CreateInboundEmailRow = {
  workspaceId: string;
  providerEmailId: string;
  fromAddress: string;
  subject: string | null;
  messageId: string | null;
  receivedAt: Date;
  status: InboundEmailStatus;
  reasonCode: InboundEmailReason | null;
  processedAt?: Date | null;
};

export type UpdateInboundEmailPatch = {
  status?: InboundEmailStatus;
  reasonCode?: InboundEmailReason | null;
  attachments?: AttachmentResult[];
  attempts?: number;
  notifiedAt?: Date | null;
  processedAt?: Date | null;
};

export interface MailIntakeRepository {
  /** Inserts the workspace's settings row with `token` unless one exists already (a
   * concurrent first visit, or simply any later one), then returns whichever row is stored.
   * The lazy creation path of decisions/0075. */
  ensureSettings(workspaceId: string, token: string): Promise<MailIntakeSettingsRow>;
  findSettings(workspaceId: string): Promise<MailIntakeSettingsRow | null>;
  /** `select ... for update` inside the caller's transaction: serializes the notification
   * throttle check of two mails processed at the same moment. */
  lockSettings(workspaceId: string): Promise<MailIntakeSettingsRow | null>;
  /** Deliberately NOT workspace-scoped: the token is how a received mail finds its workspace
   * in the first place (the webhook has no session). Returns the settings row or `null`. */
  findSettingsByToken(token: string): Promise<MailIntakeSettingsRow | null>;
  updateSettings(
    workspaceId: string,
    patch: { enabled?: boolean; senderPolicy?: SenderPolicy; token?: string; tokenRotatedAt?: Date },
  ): Promise<MailIntakeSettingsRow | null>;

  listAllowedSenders(workspaceId: string): Promise<MailIntakeAllowedSenderRow[]>;
  countAllowedSenders(workspaceId: string): Promise<number>;
  /** `null` when the same normalized value is already on this workspace's list. */
  addAllowedSender(input: {
    workspaceId: string;
    kind: AllowedSenderKind;
    value: string;
    createdByUserId: string | null;
  }): Promise<MailIntakeAllowedSenderRow | null>;
  /** `false` when no such entry exists in this workspace. */
  removeAllowedSender(workspaceId: string, id: string): Promise<boolean>;

  /** Idempotent on `(providerEmailId, workspaceId)`: `null` when the row already exists (a
   * webhook retry), so the caller enqueues nothing a second time. */
  insertInboundEmail(row: CreateInboundEmailRow): Promise<InboundEmailRow | null>;
  findInboundEmail(workspaceId: string, id: string): Promise<InboundEmailRow | null>;
  updateInboundEmail(workspaceId: string, id: string, patch: UpdateInboundEmailPatch): Promise<void>;
  /** Newest first. */
  listInboundEmails(workspaceId: string, limit: number): Promise<InboundEmailRow[]>;
  /** Whether any mail of this workspace with `reasonCode` was notified about at or after
   * `since` (the notification throttle). */
  hasNotificationSince(workspaceId: string, reasonCode: InboundEmailReason, since: Date): Promise<boolean>;
  /** The received mail one of whose attachments CREATED `documentId` (outcome `imported`; a
   * `duplicate` only points at a document that came from elsewhere), or `null`. */
  findByDocumentId(workspaceId: string, documentId: string): Promise<InboundEmailRow | null>;
}
