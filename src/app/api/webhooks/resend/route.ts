/**
 * `POST /api/webhooks/resend` (decisions/0075-email-intake.md): Resend's `email.received`
 * webhook, the entry point of the E-Mail-Eingang. Built on `src/platform/api-pipeline`'s
 * `access -> parse -> execute -> respond` step machine:
 *
 * - `access`: 503 when this deployment has no `INBOUND_EMAIL_DOMAIN`/`RESEND_WEBHOOK_SECRET`
 *   (Resend retries; nothing is lost while the configuration is being fixed), then reads the
 *   RAW body (capped) and verifies its Svix signature; 401 on any failure. No session: the
 *   signature is the authentication.
 * - `parse`: nothing (the step only sees the request, whose body `access` already consumed).
 * - `execute`: parses the event JSON (any type other than `email.received` is acknowledged with
 *   200 and ignored; a signed but malformed `email.received` is a 400), then
 *   `MailIntakeUseCases.receiveInboundEmail`. The provider forwards EVERY mail the
 *   whole Resend account receives, so only recipients exactly `post-<token>@<INBOUND_EMAIL_DOMAIN>`
 *   with an existing, enabled token are kept; everything else is dropped without storing
 *   anything. One log row plus one `process-inbound-email` job per matched workspace, in one
 *   transaction, idempotent on Resend's `email_id` (a webhook retry stores nothing new).
 * - `respond`: 200 for every handled case (matched, unmatched, duplicate, ignored), because a
 *   persistently failing endpoint gets disabled by Resend; only a real infrastructure failure
 *   (the database) answers 5xx. `after()` then runs the new jobs right away.
 *
 * Logging carries counts and reason codes only, never an address or a subject.
 * `src/proxy.ts`'s matcher (`/dashboard/:path*`, `/onboarding`) never sees this path.
 */
import { after } from "next/server";

import { createApiHandlerFromContract, defineApiEndpointContract } from "@/platform/api-pipeline";
import { parseWebhookEvent, WebhookSignatureError, type ParsedWebhookEvent } from "@/platform/inbound-mail";
import { isInboundMailWebhookConfigured, verifyInboundWebhook } from "@/platform/inbound-mail/server";
import { runDueJobs } from "@/platform/jobs/server";
import { getRequestServices } from "@/persistence/composition/request-services";

// Storing the log row is fast; the generous headroom is for the `after()` job run, which
// downloads attachments and creates documents within this same invocation.
export const maxDuration = 60;

/** An `email.received` event is metadata only (a few KB); anything far larger is not one. */
const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;

type WebhookErrorCode = "not_configured" | "invalid_signature" | "payload_too_large" | "invalid_payload" | "unknown";

class WebhookNotConfiguredError extends Error {
  override readonly name = "WebhookNotConfiguredError";
}

class WebhookInvalidPayloadError extends Error {
  override readonly name = "WebhookInvalidPayloadError";
}

class WebhookPayloadTooLargeError extends Error {
  override readonly name = "WebhookPayloadTooLargeError";
}

const contract = defineApiEndpointContract<WebhookErrorCode>({
  invalidRequestError: { errorCode: "invalid_payload", status: 400 },
  unknownError: { errorCode: "unknown", status: 500 },
});

async function readBodyWithCap(request: Request, maxBytes: number): Promise<string> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) throw new WebhookPayloadTooLargeError();
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new WebhookPayloadTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

type WebhookOutcome = { kind: "ignored" } | { kind: "received"; workspaceIds: string[]; matched: number };

export const POST = createApiHandlerFromContract(contract, {
  access: {
    run: async ({ request }): Promise<{ rawBody: string }> => {
      if (!isInboundMailWebhookConfigured()) throw new WebhookNotConfiguredError();
      const rawBody = await readBodyWithCap(request, MAX_WEBHOOK_BODY_BYTES);
      verifyInboundWebhook(rawBody, request.headers);
      return { rawBody };
    },
    mapError: (err) => {
      if (err instanceof WebhookNotConfiguredError) return { errorCode: "not_configured", status: 503 };
      if (err instanceof WebhookSignatureError) return { errorCode: "invalid_signature", status: 401 };
      if (err instanceof WebhookPayloadTooLargeError) return { errorCode: "payload_too_large", status: 413 };
      return null;
    },
  },

  // The body was already read (and verified) by `access`; the step machine hands `parse` only
  // the request, so the event itself is parsed at the start of `execute`.
  parse: {
    run: () => ({}),
  },

  execute: {
    run: async ({ access }): Promise<WebhookOutcome> => {
      const parsedInput: ParsedWebhookEvent | null = parseWebhookEvent(access.rawBody);
      if (!parsedInput) throw new WebhookInvalidPayloadError();
      if (parsedInput.kind === "ignored") {
        console.info("[webhooks/resend] event ignored", { reason: "event_type_not_handled" });
        return { kind: "ignored" };
      }
      const result = await getRequestServices().mailIntake.receiveInboundEmail(parsedInput.email);
      if (result.matched === 0) {
        console.info("[webhooks/resend] mail dropped", { reason: "no_matching_recipient", ...result.skipped });
      }
      return { kind: "received", workspaceIds: result.workspaceIds, matched: result.matched };
    },
    mapError: (err) => (err instanceof WebhookInvalidPayloadError ? { errorCode: "invalid_payload", status: 400 } : null),
  },

  respond: {
    run: ({ result }) => {
      if (result.kind === "received" && result.workspaceIds.length > 0) {
        // Like the upload route: starts the new jobs once the response is out, never delaying
        // the 200. `after()` throws outside a Next request scope (a test calling `POST`
        // directly); the cron sweep picks the jobs up then.
        try {
          after(async () => {
            for (const workspaceId of result.workspaceIds) {
              await runDueJobs({ workspaceId, limit: 5 });
            }
          });
        } catch (err) {
          console.error("[webhooks/resend] after() scheduling failed", err instanceof Error ? err.message : err);
        }
      }
      const body = result.kind === "ignored" ? { status: "ignored" } : { status: "ok", accepted: result.workspaceIds.length };
      return Response.json(body, { status: 200 });
    },
  },
});
