// Neutral entrypoint (WEBAPP_TEMPLATE_SPEC.md §4.2) of `src/modules/mail-intake`
// (decisions/0075-email-intake.md): the pure domain (address tokens, recipient parsing, the
// sender policy, the attachment plan, the stable status/reason/outcome codes). Safe for
// `src/persistence/use-cases/**`, `src/persistence/schema/**` and client code alike: no I/O,
// no `server-only`, no `"use client"`.
export {
  collectInboundTokens,
  emailDomain,
  extractEmailAddress,
  formatInboundAddress,
  generateInboundToken,
  INBOUND_TOKEN_ALPHABET,
  INBOUND_TOKEN_LENGTH,
  isValidInboundToken,
  normalizeDomain,
  parseInboundRecipient,
} from "./core/address";
export {
  ALLOWED_SENDER_KINDS,
  DEFAULT_SENDER_POLICY,
  isSenderAllowed,
  isSenderAuthenticated,
  MAX_ALLOWED_SENDERS,
  normalizeAllowedSenderEntry,
  SENDER_POLICIES,
  type AllowedSenderEntry,
  type AllowedSenderKind,
  type SenderAuthentication,
  type SenderPolicy,
} from "./core/sender-policy";
export {
  ATTACHMENT_OUTCOMES,
  countImported,
  INBOUND_EMAIL_REASONS,
  INBOUND_EMAIL_STATUSES,
  isNotifiedReason,
  NOTIFICATION_THROTTLE_MS,
  NOTIFIED_REASONS,
  type AttachmentOutcome,
  type AttachmentResult,
  type InboundEmailReason,
  type InboundEmailStatus,
  type NotifiedReason,
} from "./core/inbound-email";
export {
  attachmentDocumentName,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_EMAIL,
  MIN_IMAGE_BYTES,
  planAttachments,
  resultFor,
  type AttachmentMeta,
  type AttachmentPlanItem,
} from "./core/attachment-plan";
export { MAIL_INTAKE_ACTION_ERROR_CODES, type MailIntakeActionErrorCode } from "./core/error-codes";
export type { AllowedSenderView, InboundEmailView, MailIntakeSettingsView } from "./core/types";
