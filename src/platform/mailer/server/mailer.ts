// The `Mailer` port (WEBAPP_TEMPLATE_SPEC.md §2.6, §10.2 "Drittanbieter nie direkt
// mocken, sondern hinter einem eigenen Port"): use cases and src/platform/auth depend on
// this interface, never on nodemailer directly, so a unit test can inject
// `src/platform/mailer/tests/support/fake-mailer.ts` instead of `vi.mock("nodemailer")`.
import "server-only";

import { serverEnv } from "@/platform/env/server";

import { getMailTransport } from "./transport";

export type MailMessage = {
  to: string;
  subject: string;
  text: string;
  html: string;
};

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

/** The real, SMTP-backed `Mailer` (`SMTP_URL` + `MAIL_FROM`). */
export function createSmtpMailer(): Mailer {
  return {
    async send(message) {
      await getMailTransport().sendMail({ from: serverEnv().MAIL_FROM, ...message });
    },
  };
}
