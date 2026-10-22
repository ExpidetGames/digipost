import "server-only";

/**
 * Privileged entrypoint of `src/platform/inbound-mail` (decisions/0075-email-intake.md): the
 * only reader of `RESEND_API_KEY`/`RESEND_WEBHOOK_SECRET`. Never imported from
 * client-reachable code.
 */
export {
  getInboundEmailDomain,
  getInboundMailProvider,
  isInboundMailWebhookConfigured,
  resetInboundMailProviderForTests,
} from "./server/get-inbound-mail-provider";
export { verifyInboundWebhook } from "./server/verify-webhook";
export { createResendInboundMailProvider } from "./server/resend-provider";
export {
  createFakeInboundMailProvider,
  generatedFakePdf,
  registerFakeInboundEmail,
  resetFakeInboundMailForTests,
  type FakeInboundAttachment,
} from "./server/fake-provider";
