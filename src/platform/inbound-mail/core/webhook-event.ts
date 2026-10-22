// The provider's webhook payload, validated after the signature has been verified
// (decisions/0075-email-intake.md). Only `email.received` is handled; every other event type
// the same endpoint might be subscribed to is acknowledged and ignored. Resend's documented
// shape: `{ type, created_at, data: { email_id, created_at, from, to[], cc[], bcc[],
// received_for[], message_id, subject, attachments: [{ id, filename, content_type,
// content_disposition, content_id }] } }`, no body and no attachment content.
import { z } from "zod";

const addressList = z.array(z.string()).nullish().transform((value) => value ?? []);

const receivedEmailSchema = z.object({
  email_id: z.string().min(1).max(200),
  created_at: z.string().nullish(),
  from: z.string().max(1000),
  to: addressList,
  cc: addressList,
  bcc: addressList,
  received_for: addressList,
  message_id: z.string().max(1000).nullish(),
  subject: z.string().nullish(),
});

export const EMAIL_RECEIVED_EVENT = "email.received";

const eventEnvelopeSchema = z.object({ type: z.string(), data: z.unknown() });

export type ReceivedEmail = {
  emailId: string;
  from: string;
  /** To, Cc, Bcc and the envelope recipients together: any of them may be our address (a
   * mail forwarded by a rule often keeps the original `To:` and carries ours only in the
   * envelope). */
  recipients: string[];
  messageId: string | null;
  subject: string | null;
  receivedAt: Date | null;
};

export type ParsedWebhookEvent = { kind: "email_received"; email: ReceivedEmail } | { kind: "ignored"; type: string };

/** `null` when the body is not a well-formed event at all (or an `email.received` event is
 * missing a required field). */
export function parseWebhookEvent(rawBody: string): ParsedWebhookEvent | null {
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return null;
  }
  const envelope = eventEnvelopeSchema.safeParse(json);
  if (!envelope.success) return null;
  if (envelope.data.type !== EMAIL_RECEIVED_EVENT) return { kind: "ignored", type: envelope.data.type };

  const data = receivedEmailSchema.safeParse(envelope.data.data);
  if (!data.success) return null;

  const receivedAt = data.data.created_at ? new Date(data.data.created_at) : null;
  return {
    kind: "email_received",
    email: {
      emailId: data.data.email_id,
      from: data.data.from,
      recipients: [...data.data.to, ...data.data.cc, ...data.data.bcc, ...data.data.received_for],
      messageId: data.data.message_id ?? null,
      subject: data.data.subject ?? null,
      receivedAt: receivedAt && !Number.isNaN(receivedAt.getTime()) ? receivedAt : null,
    },
  };
}
