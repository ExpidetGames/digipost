// Webhook signature verification (decisions/0075-email-intake.md). Resend signs every webhook
// through Svix: `svix-id`, `svix-timestamp` and `svix-signature` headers, an HMAC over
// `<id>.<timestamp>.<raw body>` with the endpoint's `whsec_...` secret, and a timestamp
// tolerance against replays. Verified over the RAW body text, before any JSON parsing; the
// fake provider changes nothing here, every environment verifies for real.
import "server-only";

import { Webhook } from "svix";

import { serverEnv } from "@/platform/env/server";

import { WebhookSignatureError } from "../core/errors";

const SVIX_HEADERS = ["svix-id", "svix-timestamp", "svix-signature"] as const;

/** `secret` defaults to `RESEND_WEBHOOK_SECRET`; tests pass their own. Throws
 * `WebhookSignatureError` on any failure (including a missing secret, so an unconfigured
 * deployment never accepts anything). */
export function verifyInboundWebhook(rawBody: string, headers: Headers, secret: string | undefined = serverEnv().RESEND_WEBHOOK_SECRET): void {
  if (!secret) throw new WebhookSignatureError();
  const svixHeaders: Record<string, string> = {};
  for (const name of SVIX_HEADERS) {
    const value = headers.get(name);
    if (!value) throw new WebhookSignatureError();
    svixHeaders[name] = value;
  }
  try {
    new Webhook(secret).verify(rawBody, svixHeaders);
  } catch {
    throw new WebhookSignatureError();
  }
}
