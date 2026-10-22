# src/platform/inbound-mail

Document type: reference
Lifecycle: active
Owner: src/platform/inbound-mail
Scope: Receiving mail through Resend: the `InboundMailProvider` port (retrieve a received
mail, list and download its attachments), the Resend and fake adapters, env-based adapter
selection, webhook signature verification, and the webhook payload parser
Canonical responsibility: The only holder of `RESEND_API_KEY` and `RESEND_WEBHOOK_SECRET`;
the only code that talks to Resend's receiving API
Maintenance triggers:
- Resend's receiving API or webhook payload shape changes
- The adapter selection (`INBOUND_MAIL_PROVIDER`) or the signature scheme changes
- `RESEND_API_KEY`/`RESEND_WEBHOOK_SECRET`/`INBOUND_EMAIL_DOMAIN`/`INBOUND_MAIL_PROVIDER`
  change (`src/platform/env/server/env.ts`)
Last verified: 2026-10-22, decisions/0075-email-intake.md (initial implementation, response
shapes verified against the real API by the project owner)

## Purpose

Resend's `email.received` webhook carries metadata only. This owner fetches the rest:
`GET /emails/receiving/{id}` (recipients incl. `received_for`, and
`authentication: { spf, dkim, dmarc }`), `GET /emails/receiving/{id}/attachments`
(`{ object, has_more, data: [{ id, filename, size (bytes), content_type, content_disposition,
content_id, download_url, expires_at }] }`), and the attachment bytes from the presigned
`download_url` (host `cdn.resend.app`, valid one hour, fetched WITHOUT the API key). Plain
`fetch`, no SDK; `svix` only verifies webhook signatures.

## Files

- `core/ports.ts`: `InboundMailProvider` (`getEmail`, `listAttachments`, `downloadAttachment`).
- `core/errors.ts`: `InboundMailError` (stable code + `retryable`), `WebhookSignatureError`.
- `core/webhook-event.ts`: `parseWebhookEvent` (zod), only `email.received` is handled.
- `server/resend-provider.ts`: the Resend adapter (429 and 5xx retryable, 401/403/404 from the
  API permanent, an expired download URL retryable because the next attempt lists afresh;
  the download is capped while streaming, never trusting the reported `size` alone).
- `server/fake-provider.ts`: deterministic, no network; an in-process registry for
  integration tests, a generated one-page PDF per mail id otherwise (what e2e gets), and the
  `fake-unavailable*`/`fake-unauthenticated*` mail id prefixes for the failure paths.
- `server/get-inbound-mail-provider.ts`: adapter selection with `AI_PROVIDER`'s precedence;
  `getInboundEmailDomain`, `isInboundMailWebhookConfigured`.
- `server/verify-webhook.ts`: `verifyInboundWebhook(rawBody, headers)` with
  `svix`'s `Webhook.verify` (signature over the raw body, timestamp tolerance against replays).

## Public interfaces

- `index.ts` (neutral): port types, errors, `parseWebhookEvent`.
- `server.ts`: the getters, `verifyInboundWebhook`, both adapters, and the fake's test hooks.
