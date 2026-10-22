// The log of received mails and what became of each attachment (decisions/0075-email-intake.md).
// Stable codes only (AGENTS.md "Code"): the UI translates them under `MailIntake.statuses`,
// `MailIntake.reasons` and `MailIntake.outcomes`.

/** `received`: stored, the job has not finished yet. `processed`: at least one attachment is
 * now a document (or already was one). `rejected`: nothing was imported, for `reasonCode`.
 * `failed`: the provider could not be reached even after every retry. */
export const INBOUND_EMAIL_STATUSES = ["received", "processed", "rejected", "failed"] as const;
export type InboundEmailStatus = (typeof INBOUND_EMAIL_STATUSES)[number];

export const INBOUND_EMAIL_REASONS = [
  /** The sender is not allowed by the workspace's policy. Notifies the admin. */
  "sender_not_allowed",
  /** The sender is on the allowlist (or a member) but the mail failed SPF/DKIM/DMARC, so the
   * `From:` may be forged. Notifies the admin. */
  "sender_not_authenticated",
  /** The provider's own recipient list does not contain the workspace's current address
   * (it was rotated after the mail arrived). Silent. */
  "recipient_not_matched",
  /** No attachment could become a document. Notifies the admin. */
  "no_supported_attachment",
  /** The workspace's quota stopped the import (possibly after some attachments). Notifies. */
  "quota_exceeded",
  /** The provider's API failed on every attempt. */
  "provider_unavailable",
] as const;
export type InboundEmailReason = (typeof INBOUND_EMAIL_REASONS)[number];

/** The reasons an admin is e-mailed about (throttled, see `NOTIFICATION_THROTTLE_MS`). */
export const NOTIFIED_REASONS = ["sender_not_allowed", "sender_not_authenticated", "no_supported_attachment", "quota_exceeded"] as const satisfies readonly InboundEmailReason[];
export type NotifiedReason = (typeof NOTIFIED_REASONS)[number];

export function isNotifiedReason(reason: InboundEmailReason | null): reason is NotifiedReason {
  return reason !== null && (NOTIFIED_REASONS as readonly string[]).includes(reason);
}

/** At most one notification per workspace and reason within this window: a leaked address
 * flooded with spam must not turn into a flood of admin mails (and must not burn through the
 * shared Resend sending quota). Every single rejection still shows in the log. */
export const NOTIFICATION_THROTTLE_MS = 24 * 60 * 60 * 1000;

export const ATTACHMENT_OUTCOMES = [
  /** A new document was created. */
  "imported",
  /** The exact same file already exists in the workspace: counts as success. */
  "duplicate",
  /** A small image (a logo, an icon, a tracking pixel), never a scanned page. */
  "skipped_small",
  /** Larger than `MAX_ATTACHMENT_BYTES`. */
  "too_large",
  /** Beyond the first `MAX_ATTACHMENTS_PER_EMAIL` attachments. */
  "over_limit",
  /** Not a format Digipost reads (by its bytes, never its name or declared type). */
  "unsupported",
  /** A supported format that is broken or too long (`detail` has the upload error code). */
  "invalid",
  /** The workspace's quota was reached; not imported. */
  "quota_exceeded",
  /** The download kept failing on every attempt. */
  "download_failed",
] as const;
export type AttachmentOutcome = (typeof ATTACHMENT_OUTCOMES)[number];

export type AttachmentResult = {
  /** The provider's attachment id: what a retry uses to skip an attachment already handled. */
  attachmentId: string;
  fileName: string;
  sizeBytes: number | null;
  outcome: AttachmentOutcome;
  /** Set for `imported` and `duplicate`. */
  documentId?: string;
  /** For `invalid`: the upload error code (`invalid_pdf`, `too_many_pages`, ...). */
  detail?: string;
};

export function countImported(results: readonly AttachmentResult[]): number {
  return results.filter((result) => result.outcome === "imported" || result.outcome === "duplicate").length;
}
