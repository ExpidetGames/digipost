// The deterministic fake `InboundMailProvider` (decisions/0075-email-intake.md), bound when
// `INBOUND_MAIL_PROVIDER=fake` (the hermetic test stack) or, outside production, when no
// `RESEND_API_KEY` is set. Mirrors `@/platform/mistral`'s fake adapters: no network, ever.
//
// Two sources of attachments, in this order:
// 1. `registerFakeInboundEmail(emailId, attachments)`: an in-process registry an integration
//    test fills before posting the webhook (same process as the route handler it calls).
// 2. Otherwise a single generated one-page PDF whose bytes include the email id, so every
//    distinct mail yields a distinct document (never an accidental duplicate). This is what an
//    end-to-end test gets, since it cannot reach into the app server's memory.
// An email id starting with `fake-unavailable` makes `listAttachments` fail retryably, so
// the "provider down" path is testable end to end too.
import "server-only";

import { INBOUND_MAIL_ERROR_CODES, InboundMailError } from "../core/errors";
import type { InboundAttachment, InboundEmailDetails, InboundMailProvider } from "../core/ports";

export type FakeInboundAttachment = {
  fileName: string;
  contentType: string;
  bytes: Uint8Array;
  contentDisposition?: string;
  /** Overrides the reported size (default: `bytes.byteLength`), e.g. to claim 20 MB without
   * allocating it. */
  reportedSize?: number;
  /** Makes every download of this attachment fail retryably `failuresBeforeSuccess` times. */
  failuresBeforeSuccess?: number;
};

type Registry = Map<string, FakeInboundAttachment[]>;

declare global {
  var __fakeInboundMailRegistry: Registry | undefined;
  var __fakeInboundMailDetails: Map<string, InboundEmailDetails> | undefined;
  var __fakeInboundMailDownloadFailures: Map<string, number> | undefined;
}

function registry(): Registry {
  return (globalThis.__fakeInboundMailRegistry ??= new Map());
}

function failures(): Map<string, number> {
  return (globalThis.__fakeInboundMailDownloadFailures ??= new Map());
}

function details(): Map<string, InboundEmailDetails> {
  return (globalThis.__fakeInboundMailDetails ??= new Map());
}

/** What `getEmail` reports for a mail nobody registered: every check passed, recipients
 * unknown (the fake never saw the webhook). An end-to-end test therefore exercises a sender
 * that authenticates; a mail id starting with `fake-unauthenticated` reports DMARC `fail`. */
const DEFAULT_DETAILS: InboundEmailDetails = { recipients: null, authentication: { spf: "pass", dkim: "pass", dmarc: "pass" } };
const FAILING_DETAILS: InboundEmailDetails = { recipients: null, authentication: { spf: "fail", dkim: "fail", dmarc: "fail" } };

/** Test hook: what `listAttachments(emailId)` returns, and optionally what `getEmail` reports. */
export function registerFakeInboundEmail(emailId: string, attachments: FakeInboundAttachment[], emailDetails?: Partial<InboundEmailDetails>): void {
  registry().set(emailId, attachments);
  if (emailDetails) details().set(emailId, { ...DEFAULT_DETAILS, ...emailDetails });
  attachments.forEach((attachment, index) => {
    if (attachment.failuresBeforeSuccess) failures().set(`${emailId}:${index}`, attachment.failuresBeforeSuccess);
  });
}

/** Test hook: forget every registered mail. */
export function resetFakeInboundMailForTests(): void {
  registry().clear();
  failures().clear();
  details().clear();
}

/** A minimal, valid one-page PDF whose text content names `emailId` (pdf-lib-free on purpose:
 * the platform owner needs no PDF library for a fixture). Byte offsets in the xref table are
 * computed, so `pdf-lib` and other readers accept it. */
export function generatedFakePdf(emailId: string): Uint8Array {
  const text = `Digipost Testanhang ${emailId}`.replace(/[()\\]/g, "");
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return new TextEncoder().encode(body);
}

function attachmentsFor(emailId: string): FakeInboundAttachment[] {
  const registered = registry().get(emailId);
  if (registered) return registered;
  return [{ fileName: "E-Mail-Anhang.pdf", contentType: "application/pdf", bytes: generatedFakePdf(emailId), contentDisposition: "attachment" }];
}

export function createFakeInboundMailProvider(): InboundMailProvider {
  return {
    async getEmail(emailId) {
      if (emailId.startsWith("fake-unavailable")) {
        throw new InboundMailError(INBOUND_MAIL_ERROR_CODES.unavailable, true, "fake provider unavailable");
      }
      return details().get(emailId) ?? (emailId.startsWith("fake-unauthenticated") ? FAILING_DETAILS : DEFAULT_DETAILS);
    },

    async listAttachments(emailId) {
      if (emailId.startsWith("fake-unavailable")) {
        throw new InboundMailError(INBOUND_MAIL_ERROR_CODES.unavailable, true, "fake provider unavailable");
      }
      return attachmentsFor(emailId).map(
        (attachment, index): InboundAttachment => ({
          id: `${emailId}:${index}`,
          fileName: attachment.fileName,
          sizeBytes: attachment.reportedSize ?? attachment.bytes.byteLength,
          contentType: attachment.contentType,
          contentDisposition: attachment.contentDisposition ?? "attachment",
          downloadUrl: `fake://${emailId}/${index}`,
        }),
      );
    },

    async downloadAttachment(attachment, maxBytes) {
      const separator = attachment.id.lastIndexOf(":");
      const emailId = attachment.id.slice(0, separator);
      const index = Number(attachment.id.slice(separator + 1));
      const remaining = failures().get(attachment.id) ?? 0;
      if (remaining > 0) {
        failures().set(attachment.id, remaining - 1);
        throw new InboundMailError(INBOUND_MAIL_ERROR_CODES.unavailable, true, "fake download failure");
      }
      const source = attachmentsFor(emailId)[index];
      if (!source) throw new InboundMailError(INBOUND_MAIL_ERROR_CODES.notFound, false);
      if (source.bytes.byteLength > maxBytes) throw new InboundMailError(INBOUND_MAIL_ERROR_CODES.tooLarge, false);
      return source.bytes;
    },
  };
}
