// Stable error codes of `src/platform/inbound-mail` (AGENTS.md "Code"). `retryable` tells the
// caller (the mail-intake use case) whether a later job attempt may succeed; this owner itself
// knows nothing about the job queue.
export const INBOUND_MAIL_ERROR_CODES = {
  notConfigured: "inbound_mail_not_configured",
  rateLimited: "inbound_mail_rate_limited",
  unavailable: "inbound_mail_unavailable",
  notFound: "inbound_mail_not_found",
  unauthorized: "inbound_mail_unauthorized",
  invalidResponse: "inbound_mail_invalid_response",
  tooLarge: "inbound_mail_too_large",
} as const;
export type InboundMailErrorCode = (typeof INBOUND_MAIL_ERROR_CODES)[keyof typeof INBOUND_MAIL_ERROR_CODES];

export class InboundMailError extends Error {
  override readonly name = "InboundMailError";
  constructor(
    readonly code: InboundMailErrorCode,
    readonly retryable: boolean,
    message?: string,
  ) {
    super(message ?? code);
  }
}

/** The webhook's signature did not verify (missing headers, wrong secret, stale timestamp). */
export class WebhookSignatureError extends Error {
  override readonly name = "WebhookSignatureError";
  constructor() {
    super("invalid_signature");
  }
}
