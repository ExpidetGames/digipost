# E-Mail-Eingang: documents by e-mail

Document type: decision
Lifecycle: active
Owner: src/modules/mail-intake
Scope: Receiving mail per workspace through Resend, turning attachments into documents, the
sender policy and authentication, limits, the received-mail log and its retention, admin
notifications, configuration, and the data-protection status
Canonical responsibility: Active source for every rule of the E-Mail-Eingang
Maintenance triggers:
- The receiving domain, the provider, or the webhook's handling of foreign mail changes
- The sender policy, the authentication rule, the limits or the notification throttle change
- A DPA with Resend is signed (the production note below then changes)
Last verified: 2026-10-22, against the unit, DB and integration suites named under
"Verification" and Resend's API shapes as verified by the project owner on the real account

## Status

Accepted. Builds on decisions/0015-documents-and-quotas.md (the upload path every attachment
reuses), decisions/0016-processing-pipeline-and-ai.md (the job queue), and extends
decisions/0027-hardening-and-deletion.md's cascade list. Replaces the "E-Mail-Eingang
(planned)" nav entry of decisions/0055-navigation-by-use-case.md with a real page.

## Context

Much of a small business's incoming "paper" mail is already e-mail: invoices as PDF
attachments, statements, letters scanned by a colleague. Forwarding such a mail should be as
good as uploading its attachment. Resend (already the SMTP provider) can receive mail on a
domain and calls a webhook per received mail; the webhook carries metadata only, the
attachments are fetched through Resend's API.

## Decision

**Provider: Resend inbound.** `POST /api/webhooks/resend` receives `email.received`. Resend's
API is reached with plain `fetch` (`src/platform/inbound-mail`, the only holder of
`RESEND_API_KEY`/`RESEND_WEBHOOK_SECRET`); `svix` verifies the webhook signature over the raw
body. The Resend Free tier stays for now (user decision): 100 mails per day, shared by the
magic-link mails and these admin notifications (hence the throttle below). How received mail
counts against the plan's limits is Resend's pricing to check; a busy installation should move
to a paid plan.

**Domain and address.** Production receives on the Resend-managed subdomain
`<id>.resend.app` (no custom domain is available): `INBOUND_EMAIL_DOMAIN=<id>.resend.app`.
Each workspace's address is `post-<token>@<domain>`, the token 20 characters from a 30-symbol
lowercase alphabet without lookalikes (`i`, `l`, `o`, `u`, `0`, `1`), about 98 bits, generated
by rejection sampling from the Web Crypto CSPRNG and unique across all workspaces (database
constraint). Switching to a custom domain later changes every workspace's address; senders
would have to be told, so it should be done with a grace period in which both domains are
accepted (not built).

**Lazy creation.** The settings row, and with it the address, is created the first time
anyone opens `/dashboard/email-intake` (`insert ... on conflict do nothing`). No backfill
migration is needed for existing workspaces (migrations are generated, never hand-written).

**Strict recipient matching; foreign mail is never stored.** The webhook receives EVERY mail
the whole Resend account receives. A recipient (To, Cc, Bcc, `received_for`) counts only when
its domain equals `INBOUND_EMAIL_DOMAIN` exactly (case-insensitive) and its local part is
exactly `post-<token>` with a well-formed token (no `+tag`, no subdomain). The token must
belong to an existing, ENABLED address. Anything else (another domain, an unknown or
malformed token, a disabled address, no matching recipient at all, another event type) is
answered 200 so Resend neither retries nor disables the endpoint, and nothing is stored: no
log row, no job, no download, no notification. The route logs only counts and reason codes,
never an address or subject. A mail addressed to two workspaces is delivered to both (one log
row and one job each).

**Webhook responses.** 503 while `INBOUND_EMAIL_DOMAIN` or `RESEND_WEBHOOK_SECRET` is unset
(the feature is off; Resend retries, so nothing is lost while the configuration is fixed); 401
for a bad signature; 400 for a signed but malformed `email.received`; 413 for a body over
256 KB; 200 otherwise, including a replay (idempotent on `(email_id, workspace)`); 5xx only for
a real infrastructure failure. The log row and the `process-inbound-email` job are written in
one transaction, then `after()` runs the job immediately (the cron sweep is the backstop).

**Processing, per mail** (`MailIntakeUseCases.processInboundEmail`):
1. `GET /emails/receiving/{id}` for the provider's own recipients and SPF/DKIM/DMARC verdicts.
   If the recipients do not contain the workspace's CURRENT address (it was rotated after the
   mail arrived), the mail is rejected as `recipient_not_matched`, silently.
2. Sender policy, per workspace, admin-selectable:
   - `allowlist` ("Nur bestimmte Absender", the DEFAULT): the workspace's members are
     implicitly allowed (a team can forward its own mail without setup), plus admin entries,
     each a full address or a domain (which also covers its subdomains). Because a `From:` can
     be forged, the mail must ALSO be authenticated: DMARC `pass`; or, where DMARC is absent or
     `none` (the sender's domain publishes no DMARC policy), SPF `pass` AND DKIM `pass`.
     Anything else, including missing data, fails closed (`sender_not_authenticated`). The
     fallback is weaker than DMARC (neither check is tied to the `From:` domain on its own) and
     accepted because many small senders publish no DMARC record.
   - `anyone` ("Jeder, der die Adresse kennt"): no sender or authentication check; the secret
     address is the only gate, and the admin can rotate it.
3. List the attachments freshly (download URLs expire after an hour), then per attachment, in
   the provider's order: images under 20 KB are skipped as signature logos (decided by size,
   never by `Content-Disposition` or `Content-ID`: Gmail sets a `Content-ID` on ordinary
   attachments, Apple Mail sends a photo inline); only the first 10 remaining attachments are
   processed (`over_limit` for the rest); one over 15 MB by its reported size is not downloaded
   (`too_large`), and the download itself is capped at 15 MB while streaming; the bytes are
   sniffed by `processIntakeUpload` exactly like an upload (PDF, JPEG/PNG converted to a PDF,
   CAMT.053, MT940, CSV, TSV); each becomes its own document via
   `DocumentUseCases.createFromUpload` with `uploadedByUserId: null`. An exact duplicate is
   "already present" (success). The result of each attachment is stored right after it is
   handled, so a retry never imports anything twice.
4. Quota: the first refused attachment stops the import; the rest are recorded as
   `quota_exceeded`; the mail is `processed` (some imported) or `rejected` (none) with reason
   `quota_exceeded`, and the job completes (no endless retry).
5. No attachment imported or duplicate: `rejected`, `no_supported_attachment`.
6. A provider failure is retried by the job queue's backoff; the use case gives up on its
   4th attempt (below the queue's 5) and marks the mail `failed`, `provider_unavailable`.

The mail body is never fetched or stored; only sender, subject, message id, timestamps and the
per-attachment outcomes are.

**Notifications.** The admin is e-mailed (existing mailer) when a mail is rejected for
`sender_not_allowed`, `sender_not_authenticated`, `no_supported_attachment` or
`quota_exceeded`: at most ONE e-mail per workspace and reason per 24 hours, decided inside the
transaction that finalizes the mail, under a row lock on the workspace's settings (so two
mails finishing together cannot both notify). A flood to a leaked address therefore costs one
mail per reason per day, not one per spam mail, which also protects the shared Resend sending
quota. Every rejection is still visible in the log.

**Retention.** `inbound_emails` rows (sender, subject, per-attachment results) are kept until
the workspace is deleted; nothing is auto-deleted (AGENTS.md). All three tables cascade from
`workspaces.id` (added to decisions/0027-hardening-and-deletion.md's list and its test).

**Permissions.** Every member sees the address (any member may upload, so any member may
forward). `mail_intake.manage` (admin-only, `src/platform/access`) is needed to rotate the
address, switch it on or off, choose the sender policy, edit the allowlist, and read the log.

**Configuration.** `INBOUND_EMAIL_DOMAIN`, `RESEND_WEBHOOK_SECRET`, `RESEND_API_KEY`,
`INBOUND_MAIL_PROVIDER` (`resend` | `fake`), all optional. Adapter selection follows
`AI_PROVIDER`'s precedence: explicit wins; unset means Resend once a key exists, otherwise the
deterministic fake outside production and a hard `inbound_mail_not_configured` in production.
An explicit `fake` is honored even in a production build (the hermetic test stack runs one) and
must never be set in a real deployment. Without a domain no address is shown.

## Data protection

Resend becomes a sub-processor for incoming mail (sender, recipients, subject, body and
attachments pass through and are stored by Resend). No DPA with Resend exists yet and the data
residency of received mail is unclear. Like Mistral (AGENTS.md "Mistral and personal data"),
production use with real customer mail is blocked on that paperwork; the internal deployment
may use it for the company's own mail only.

## Consequences

- One new owner module (`src/modules/mail-intake`), one platform owner
  (`src/platform/inbound-mail`), three tables (migration `0023_round_junta.sql`), two job kinds
  (`process-inbound-email`, `send-mail-intake-notification`), one permission.
- `src/modules/documents` exports `processIntakeUpload` and `MAX_UPLOAD_PAGES` from its
  neutral entrypoint, so the use case shares the upload's byte sniffing.
- Documents from mail have no uploader; the detail page shows "Per E-Mail von <sender>".
- A PDF over 20 pages is refused exactly as an upload would be (`invalid`, `too_many_pages`).

## Verification

Unit: `src/modules/mail-intake/tests/*`, `src/platform/inbound-mail/tests/*` (Svix-signed
payloads, the Resend adapter against an injected `fetch`), `src/app/api/webhooks/resend/route.test.ts`.
DB: `src/persistence/tests/mail-intake-repository.db.test.ts`, the cascade test in
`workspaces-repository.db.test.ts`. Integration: `tests/integration/http/webhooks-resend.integration.test.ts`
(foreign domain, unknown token, disabled address, malformed local part, mixed recipients, bad
signature, replay, duplicate attachment, two workspaces, allowlist and domain match,
unauthenticated sender, `anyone`, rotated address, unsupported, no attachment, over 15 MB, over
10 attachments, quota, retry after partial success, provider down). E2E: `tests/e2e/mail-intake.spec.ts`.
