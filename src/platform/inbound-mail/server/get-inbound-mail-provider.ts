// Composition-root entry point (decisions/0075-email-intake.md): picks the Resend adapter or the
// deterministic fake by env, with the exact precedence `@/platform/mistral`'s
// `get-ai-adapters.ts` uses for `AI_PROVIDER`. `INBOUND_MAIL_PROVIDER` explicit beats
// everything; unset means "resend" once `RESEND_API_KEY` exists, otherwise the fake outside
// production and a hard `inbound_mail_not_configured` failure in production (a misconfigured
// production deployment must never invent attachments). Like `AI_PROVIDER=fake`, an explicit
// `fake` is honored even under `NODE_ENV=production`, because the hermetic test stack runs a
// production build; `scripts/deploy/README.md` forbids setting it in a real deployment.
import "server-only";

import { serverEnv } from "@/platform/env/server";

import { INBOUND_MAIL_ERROR_CODES, InboundMailError } from "../core/errors";
import type { InboundMailProvider } from "../core/ports";
import { createFakeInboundMailProvider } from "./fake-provider";
import { createResendInboundMailProvider } from "./resend-provider";

type InboundMailMode = "resend" | "fake" | "not_configured";

function resolveMode(): InboundMailMode {
  const env = serverEnv();
  if (env.INBOUND_MAIL_PROVIDER === "fake") return "fake";
  if (env.INBOUND_MAIL_PROVIDER === "resend") return env.RESEND_API_KEY ? "resend" : "not_configured";
  if (env.RESEND_API_KEY) return "resend";
  return env.NODE_ENV === "production" ? "not_configured" : "fake";
}

function createNotConfiguredProvider(): InboundMailProvider {
  const fail = async (): Promise<never> => {
    throw new InboundMailError(INBOUND_MAIL_ERROR_CODES.notConfigured, false, "inbound mail provider is not configured");
  };
  return { getEmail: fail, listAttachments: fail, downloadAttachment: fail };
}

function build(mode: InboundMailMode): InboundMailProvider {
  if (mode === "fake") return createFakeInboundMailProvider();
  if (mode === "not_configured") return createNotConfiguredProvider();
  return createResendInboundMailProvider({ apiKey: serverEnv().RESEND_API_KEY ?? "" });
}

declare global {
  var __inboundMailProvider: InboundMailProvider | undefined;
}

export function getInboundMailProvider(): InboundMailProvider {
  return (globalThis.__inboundMailProvider ??= build(resolveMode()));
}

/** Test hook: drop the memoized adapter. */
export function resetInboundMailProviderForTests(): void {
  globalThis.__inboundMailProvider = undefined;
}

/** The receiving domain (`INBOUND_EMAIL_DOMAIN`), lowercased, or `null` when this deployment
 * has none: then no workspace shows an address and the webhook answers 503. */
export function getInboundEmailDomain(): string | null {
  const domain = serverEnv().INBOUND_EMAIL_DOMAIN?.trim().toLowerCase();
  return domain && domain.length > 0 ? domain : null;
}

/** Whether the webhook can do anything at all: it needs both the domain (to recognize our
 * addresses) and the signing secret (to trust the request). */
export function isInboundMailWebhookConfigured(): boolean {
  return getInboundEmailDomain() !== null && Boolean(serverEnv().RESEND_WEBHOOK_SECRET);
}
