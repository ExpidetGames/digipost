// The `InboundMailProvider` port (decisions/0075-email-intake.md, WEBAPP_TEMPLATE_SPEC.md §2.6:
// a third party only ever behind a port of our own). Resend's webhook carries metadata only,
// never an attachment's bytes; they are fetched through this port, always freshly listed right
// before downloading, because a listed download URL expires after an hour.
export type InboundAttachment = {
  id: string;
  fileName: string;
  /** `null` when the provider did not report a size. */
  sizeBytes: number | null;
  contentType: string | null;
  contentDisposition: string | null;
  downloadUrl: string;
};

/** The receiving side's own SPF/DKIM/DMARC verdicts for one mail, lowercased (`"pass"`,
 * `"fail"`, `"none"`, ...); a field is `null` when the provider did not report it. */
export type InboundMailAuthentication = {
  spf: string | null;
  dkim: string | null;
  dmarc: string | null;
};

/** What the provider's retrieve endpoint says about one received mail, beyond the webhook. */
export type InboundEmailDetails = {
  /** Every recipient the provider knows (To, Cc, Bcc and the envelope's `received_for`).
   * `null` when the adapter cannot know them (the fake for an unregistered mail). */
  recipients: string[] | null;
  /** `null` when the provider reported no authentication results at all. */
  authentication: InboundMailAuthentication | null;
};

export interface InboundMailProvider {
  /** The mail's recipients and authentication results (`GET /emails/receiving/{id}`). */
  getEmail(emailId: string): Promise<InboundEmailDetails>;
  /** Every attachment of one received mail, in the provider's order. */
  listAttachments(emailId: string): Promise<InboundAttachment[]>;
  /** The attachment's bytes. Throws `InboundMailError` with code `too_large` as soon as more
   * than `maxBytes` arrive, without buffering the rest. */
  downloadAttachment(attachment: InboundAttachment, maxBytes: number): Promise<Uint8Array>;
}
