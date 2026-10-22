// The Resend adapter of `InboundMailProvider` (decisions/0075-email-intake.md): plain `fetch`
// against Resend's REST API, no SDK. `GET /emails/receiving/{email_id}` gives the mail's
// recipients (`to`/`cc`/`bcc`/`received_for`) and the receiving side's
// `authentication: { spf, dkim, dmarc }` verdicts. `fetch` is injectable so the unit tests never touch the
// network (`scripts/test/unit-guard.ts`).
//
// `GET /emails/receiving/{email_id}/attachments` answers `{ object: "list", has_more, data: [{
// id, filename, size, content_type, content_disposition, content_id, download_url, expires_at
// }] }`; without `limit` it returns every attachment at once, and `has_more`/`after` page
// through the rest should a response ever be partial. `download_url` is a signed URL valid
// for one hour, so a caller lists right before downloading, never from a stored listing.
// Resend allows 10 requests per second per team; a 429 is reported as retryable and the job
// queue's own backoff spaces the retry out.
import "server-only";

import { z } from "zod";

import { INBOUND_MAIL_ERROR_CODES, InboundMailError } from "../core/errors";
import type { InboundAttachment, InboundEmailDetails, InboundMailAuthentication, InboundMailProvider } from "../core/ports";

const RESEND_API_BASE = "https://api.resend.com";
const REQUEST_TIMEOUT_MS = 30_000;
/** A mail has at most a handful of attachments; this only bounds a misbehaving `has_more`. */
const MAX_PAGES = 10;

const attachmentListSchema = z.object({
  has_more: z.boolean().optional(),
  data: z.array(
    z.object({
      id: z.string().min(1),
      filename: z.string().nullish(),
      size: z.number().nullish(),
      content_type: z.string().nullish(),
      content_disposition: z.string().nullish(),
      download_url: z.string().url(),
    }),
  ),
});

const verdict = z
  .union([z.string(), z.object({ result: z.string().nullish(), status: z.string().nullish() }).passthrough()])
  .nullish()
  .transform((value): string | null => {
    if (value === null || value === undefined) return null;
    const text = typeof value === "string" ? value : (value.result ?? value.status ?? null);
    return text ? text.trim().toLowerCase() : null;
  });

/** `GET /emails/receiving/{id}`, only the fields this adapter reads (verified against the real
 * API: `to`, `cc`, `bcc`, `received_for` arrays and `authentication: { spf, dkim, dmarc }`).
 * A verdict is also accepted as `{ result }`/`{ status }`, should the provider ever nest it. */
const receivedEmailSchema = z.object({
  to: z.array(z.string()).nullish(),
  cc: z.array(z.string()).nullish(),
  bcc: z.array(z.string()).nullish(),
  received_for: z.array(z.string()).nullish(),
  authentication: z.object({ spf: verdict, dkim: verdict, dmarc: verdict }).passthrough().nullish(),
});

function errorForStatus(status: number): InboundMailError {
  if (status === 429) return new InboundMailError(INBOUND_MAIL_ERROR_CODES.rateLimited, true, `HTTP ${status}`);
  if (status === 401 || status === 403) return new InboundMailError(INBOUND_MAIL_ERROR_CODES.unauthorized, false, `HTTP ${status}`);
  if (status === 404) return new InboundMailError(INBOUND_MAIL_ERROR_CODES.notFound, false, `HTTP ${status}`);
  if (status >= 500) return new InboundMailError(INBOUND_MAIL_ERROR_CODES.unavailable, true, `HTTP ${status}`);
  return new InboundMailError(INBOUND_MAIL_ERROR_CODES.invalidResponse, false, `HTTP ${status}`);
}

async function guardedFetch(fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch {
    // A network error or a timeout: worth another attempt later.
    throw new InboundMailError(INBOUND_MAIL_ERROR_CODES.unavailable, true, "request failed");
  }
}

/** Reads `body` with a hard byte cap, cancelling the stream the moment it is crossed. */
async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new InboundMailError(INBOUND_MAIL_ERROR_CODES.tooLarge, false);
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array(await response.arrayBuffer());

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    let next: ReadableStreamReadResult<Uint8Array>;
    try {
      next = await reader.read();
    } catch {
      throw new InboundMailError(INBOUND_MAIL_ERROR_CODES.unavailable, true, "download interrupted");
    }
    if (next.done) break;
    total += next.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new InboundMailError(INBOUND_MAIL_ERROR_CODES.tooLarge, false);
    }
    chunks.push(next.value);
  }
  const combined = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

export function createResendInboundMailProvider(options: { apiKey: string; fetch?: typeof fetch; baseUrl?: string }): InboundMailProvider {
  const fetchImpl = options.fetch ?? fetch;
  const baseUrl = options.baseUrl ?? RESEND_API_BASE;

  async function getJson(url: string): Promise<unknown> {
    const response = await guardedFetch(fetchImpl, url, {
      method: "GET",
      headers: { Authorization: `Bearer ${options.apiKey}`, Accept: "application/json" },
    });
    if (!response.ok) throw errorForStatus(response.status);
    try {
      return await response.json();
    } catch {
      throw new InboundMailError(INBOUND_MAIL_ERROR_CODES.invalidResponse, true, "response is not JSON");
    }
  }

  return {
    async getEmail(emailId): Promise<InboundEmailDetails> {
      const parsed = receivedEmailSchema.safeParse(await getJson(`${baseUrl}/emails/receiving/${encodeURIComponent(emailId)}`));
      if (!parsed.success) throw new InboundMailError(INBOUND_MAIL_ERROR_CODES.invalidResponse, false, "unexpected received email shape");
      const data = parsed.data;
      const authentication: InboundMailAuthentication | null = data.authentication
        ? { spf: data.authentication.spf, dkim: data.authentication.dkim, dmarc: data.authentication.dmarc }
        : null;
      return {
        recipients: [...(data.to ?? []), ...(data.cc ?? []), ...(data.bcc ?? []), ...(data.received_for ?? [])],
        authentication,
      };
    },

    async listAttachments(emailId) {
      const attachments: InboundAttachment[] = [];
      let after: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const query = after ? `?after=${encodeURIComponent(after)}` : "";
        const json = await getJson(`${baseUrl}/emails/receiving/${encodeURIComponent(emailId)}/attachments${query}`);
        const parsed = attachmentListSchema.safeParse(json);
        if (!parsed.success) throw new InboundMailError(INBOUND_MAIL_ERROR_CODES.invalidResponse, false, "unexpected attachment list shape");

        for (const item of parsed.data.data) {
          attachments.push({
            id: item.id,
            fileName: item.filename ?? "",
            sizeBytes: typeof item.size === "number" ? item.size : null,
            contentType: item.content_type ?? null,
            contentDisposition: item.content_disposition ?? null,
            downloadUrl: item.download_url,
          });
        }
        const last = parsed.data.data.at(-1);
        if (!parsed.data.has_more || !last) break;
        after = last.id;
      }
      return attachments;
    },

    async downloadAttachment(attachment, maxBytes) {
      // The signed URL itself is the credential: no API key is sent along, so the key never
      // reaches whatever host serves the file.
      const response = await guardedFetch(fetchImpl, attachment.downloadUrl, { method: "GET" });
      if (!response.ok) {
        // An expired signed URL answers 403; the next attempt lists the attachments afresh and
        // gets a new one, so this is retryable here, unlike a 403 from the API itself.
        if (response.status === 403 || response.status === 404) {
          throw new InboundMailError(INBOUND_MAIL_ERROR_CODES.unavailable, true, `download HTTP ${response.status}`);
        }
        throw errorForStatus(response.status);
      }
      return readCapped(response, maxBytes);
    },
  };
}
