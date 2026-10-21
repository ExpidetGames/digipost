// The one nodemailer transport (WEBAPP_TEMPLATE_SPEC.md §2.6): `nodemailer` must not
// be imported anywhere else. `SMTP_URL` is a full connection string
// (`smtp(s)://user:pass@host:port`, src/platform/env/server/env.ts), which nodemailer's
// `createTransport` accepts directly - no separate host/port/user/pass parsing needed.
import "server-only";

import nodemailer, { type Transporter } from "nodemailer";

import { serverEnv } from "@/platform/env/server";

/** The transport shape this owner needs: exactly nodemailer's `sendMail`. */
export type MailTransport = Pick<Transporter, "sendMail">;

declare global {
  var __mailerTransport: MailTransport | undefined;
}

/** Lazily created, memoized on `globalThis` so Next's dev-server HMR does not
 * leak sockets (same pattern as src/persistence/foundation/client.ts). */
export function getMailTransport(): MailTransport {
  return (globalThis.__mailerTransport ??= nodemailer.createTransport(serverEnv().SMTP_URL));
}

/** Test hook: drop the memoized transport. */
export function resetMailTransportForTests(): void {
  globalThis.__mailerTransport = undefined;
}
