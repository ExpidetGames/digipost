# src/modules/mail-intake

Document type: reference
Lifecycle: active
Owner: src/modules/mail-intake
Scope: The E-Mail-Eingang: the per-workspace inbound address, recipient matching, the sender
policy and its allowlist, sender authentication, the attachment plan, the received-mail log,
the admin notification e-mail, and the `/dashboard/email-intake` page
Canonical responsibility: Turning a mail sent to a workspace's address into documents,
through `src/modules/documents`' own upload path, and deciding which mails may do so
Maintenance triggers:
- The address format, the token alphabet or length changes
- The sender policy, the authentication rule, or the attachment limits change
- A new status, reason or attachment outcome code is added (`de.json`'s `MailIntake`)
- The notification throttle changes
Last verified: 2026-10-22, decisions/0075-email-intake.md (initial implementation)

## Purpose

Every workspace gets a secret address `post-<token>@<INBOUND_EMAIL_DOMAIN>` (production:
`<id>.resend.app`). A mail sent there arrives as Resend's `email.received` webhook at
`POST /api/webhooks/resend`; each supported attachment becomes its own document through
`DocumentUseCases.createFromUpload` (same exact-duplicate check, both quota checks, storage
write and `process-document` job as an upload), with `uploadedByUserId: null`. See
decisions/0075-email-intake.md for every decision behind this.

## Layout

- `core/address.ts`: token generation (20 characters from a 30-symbol lookalike-free
  lowercase alphabet, about 98 bits), `formatInboundAddress`, and the STRICT recipient parser
  (`parseInboundRecipient`: exactly `post-<token>` on exactly the configured domain, no
  `+tag`, no subdomain). Resend forwards every mail the whole account receives, so this parser
  is what keeps foreign mail out.
- `core/sender-policy.ts`: `allowlist` (default; members implicitly, plus admin entries,
  address or domain including subdomains) or `anyone`; `isSenderAuthenticated` (DMARC `pass`,
  or without DMARC both SPF and DKIM `pass`), required only under `allowlist`.
- `core/attachment-plan.ts`: 15 MB per attachment, 10 attachments per mail, images under
  20 KB skipped as signature logos (decided by size, not by `Content-Disposition` or
  `Content-ID`; Gmail sets a `Content-ID` on ordinary attachments, Apple Mail sends photos
  inline). A retry keeps every per-attachment result already stored.
- `core/inbound-email.ts`: the stable status, reason and outcome codes and the notification
  throttle (one e-mail per workspace and reason per 24 hours).
- `core/types.ts`, `core/schemas.ts`, `core/error-codes.ts`: view shapes, action inputs,
  action error codes.
- `server/read-models.ts`: the page and document-detail projections.
- `server/emails/rejection-notification-email.tsx`: the admin notice (React Email, German).
- `ui/mail-intake-page-client.tsx`: the page; every member sees the address, only
  `mail_intake.manage` sees the controls and the log.
- `actions.ts`: the five admin actions, each behind `requirePermission(PERMISSIONS.mailIntakeManage)`.

## Public interfaces

- `index.ts` (neutral): the pure domain above, used by `src/persistence/use-cases/mail-intake-use-cases.ts`
  and `src/persistence/schema/mail-intake.ts`.
- `server.ts`: `getMailIntakeSettingsProjection`, `listInboundEmailsProjection`,
  `getEmailSourceForDocumentProjection`, and the notification e-mail renderer (used by
  `src/persistence/composition/job-handlers.ts`).
- `client.ts`: `MailIntakePageClient`.
- `actions.ts`: `regenerateInboundAddressAction`, `setMailIntakeEnabledAction`,
  `setSenderPolicyAction`, `addAllowedSenderAction`, `removeAllowedSenderAction`.

## Data

Tables `mail_intake_settings`, `mail_intake_allowed_senders`, `inbound_emails`
(`src/persistence/schema/mail-intake.ts`, migration `0023_round_junta.sql`), written only by
`src/persistence/repositories/drizzle/mail-intake-repository.ts`. All three cascade from
`workspaces.id`. The settings row (and with it the address) is created lazily on first use
(opening the page), never by a backfill. The log is kept until the workspace is deleted.

## Tests

`tests/` (unit: address, sender policy, authentication, attachment plan, i18n coverage),
`src/persistence/tests/mail-intake-repository.db.test.ts` (constraints, idempotency, scoping,
cascade), `tests/integration/http/webhooks-resend.integration.test.ts` (route + job with the
fake provider), `tests/e2e/mail-intake.spec.ts` (the page and a signed webhook end to end).
