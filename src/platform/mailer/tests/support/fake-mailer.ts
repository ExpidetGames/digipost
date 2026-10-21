// Typed fake for `Mailer` (WEBAPP_TEMPLATE_SPEC.md §10.2's "fakes instead of mocks"
// rule): collects every message a unit test's code under test sends, instead of
// mocking nodemailer or asserting on call arguments.
import type { Mailer, MailMessage } from "@/platform/mailer/server";

export function createFakeMailer(): { mailer: Mailer; sent: MailMessage[] } {
  const sent: MailMessage[] = [];
  return {
    sent,
    mailer: {
      async send(message) {
        sent.push(message);
      },
    },
  };
}
