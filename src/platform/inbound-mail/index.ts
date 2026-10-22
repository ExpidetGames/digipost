/**
 * Neutral entrypoint of `src/platform/inbound-mail` (decisions/0075-email-intake.md): the
 * `InboundMailProvider` port, its error codes, and the webhook payload parser. No I/O, no
 * `server-only`: `src/persistence/use-cases/**` imports the port and the errors from here.
 */
export { INBOUND_MAIL_ERROR_CODES, InboundMailError, WebhookSignatureError, type InboundMailErrorCode } from "./core/errors";
export type { InboundAttachment, InboundEmailDetails, InboundMailAuthentication, InboundMailProvider } from "./core/ports";
export { EMAIL_RECEIVED_EVENT, parseWebhookEvent, type ParsedWebhookEvent, type ReceivedEmail } from "./core/webhook-event";
