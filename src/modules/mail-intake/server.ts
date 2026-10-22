// Owner: src/modules/mail-intake. Privileged entrypoint (`import "server-only"`,
// decisions/0075-email-intake.md): the page read models and the admin notification e-mail.
import "server-only";

export { getEmailSourceForDocumentProjection, getMailIntakeSettingsProjection, listInboundEmailsProjection } from "./server/read-models";
export {
  mailIntakeNotificationSubject,
  renderMailIntakeNotificationEmail,
  type MailIntakeNotificationEmailProps,
} from "./server/emails/rejection-notification-email";
