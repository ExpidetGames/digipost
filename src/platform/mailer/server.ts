import "server-only";

/**
 * Privileged entrypoint of `src/platform/mailer`: the SMTP-backed `Mailer`, the render
 * helper for React Email templates, and test hooks. Never imported from
 * client-reachable code.
 */
export { createSmtpMailer, type Mailer, type MailMessage } from "./server/mailer";
export { renderEmail, type RenderedEmail } from "./server/render-email";
export { getMailTransport, resetMailTransportForTests, type MailTransport } from "./server/transport";
