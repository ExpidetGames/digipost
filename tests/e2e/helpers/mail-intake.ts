// E-Mail-Eingang helpers (decisions/0075-email-intake.md): build a Resend-style
// `email.received` webhook and sign it with the test stack's `RESEND_WEBHOOK_SECRET` the way
// Resend's Svix signing does. e2e imports no app code; `svix` is the same library the app
// verifies with.
import { randomUUID } from "node:crypto";

import { Webhook } from "svix";

import { ownerQuery } from "./db";

/** `null` when this run has no webhook secret (a host-mode `pnpm test:e2e` without the
 * E-Mail-Eingang configured in `.env.local`): the spec then skips the webhook flow. */
export function webhookSecret(): string | null {
  return process.env.RESEND_WEBHOOK_SECRET || null;
}

export function signedWebhook(input: { from: string; to: string[]; subject?: string; emailId?: string }, secret: string) {
  const emailId = input.emailId ?? randomUUID();
  const body = JSON.stringify({
    type: "email.received",
    created_at: new Date().toISOString(),
    data: {
      email_id: emailId,
      created_at: new Date().toISOString(),
      from: input.from,
      to: input.to,
      cc: [],
      bcc: [],
      received_for: [],
      message_id: `<${emailId}@example.test>`,
      subject: input.subject ?? "Rechnung per E-Mail",
      attachments: [],
    },
  });
  const id = `msg_${randomUUID()}`;
  const at = new Date();
  return {
    emailId,
    body,
    headers: {
      "content-type": "application/json",
      "svix-id": id,
      "svix-timestamp": String(Math.floor(at.getTime() / 1000)),
      "svix-signature": new Webhook(secret).sign(id, at, body),
    },
  };
}

/** The ids of the documents a received mail created in `workspaceId`. */
export async function documentIdsFromMail(workspaceId: string, emailId: string): Promise<string[]> {
  const rows = await ownerQuery<{ document_id: string }>(
    `select a->>'documentId' as document_id
       from public.inbound_emails e, jsonb_array_elements(e.attachments) a
      where e.workspace_id = $1 and e.provider_email_id = $2 and a->>'outcome' = 'imported'`,
    [workspaceId, emailId],
  );
  return rows.map((row) => row.document_id);
}
