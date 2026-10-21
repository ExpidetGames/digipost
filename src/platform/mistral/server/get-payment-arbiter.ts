// Composition-root entry point for `PaymentArbiter` (decisions/0023-payment-matching.md,
// phase F3a), mirroring `get-intake-classifier.ts`'s pattern exactly (env-driven selection,
// `globalThis` memoization so Next's dev-server HMR does not rebuild it on every reload) for
// the identical reason that file documents: F3a builds pure code while F1b/F3b are mid-flight
// on this repository's schema/persistence, so every change here is additive-only (new files,
// or an appended export on `server.ts`). A future phase wiring payment matching fully into the
// composition root can fold this into `get-ai-adapters.ts` if having three near-identical
// `resolveMode` copies ever becomes the more annoying option.
import "server-only";

import { createFakePaymentArbiter, type PaymentArbiter } from "@/modules/payments";
import { serverEnv } from "@/platform/env/server";

import { MISTRAL_ERROR_CODES, MistralRequestError } from "../core/errors";
import { createMistralPaymentArbiter } from "./mistral-payment-arbiter";

type PaymentArbiterMode = "mistral" | "fake" | "not_configured";

/** Identical precedence to `get-ai-adapters.ts`/`get-intake-classifier.ts`'s own
 * `resolveMode`: `AI_PROVIDER` explicit beats everything; unset falls back to "mistral" once a
 * key exists, otherwise to "fake" outside production, and to "not_configured" in production. */
function resolveMode(): PaymentArbiterMode {
  const env = serverEnv();
  if (env.AI_PROVIDER === "fake") return "fake";
  if (env.AI_PROVIDER === "mistral") return env.MISTRAL_API_KEY ? "mistral" : "not_configured";
  if (env.MISTRAL_API_KEY) return "mistral";
  return env.NODE_ENV === "production" ? "not_configured" : "fake";
}

function createNotConfiguredPaymentArbiter(): PaymentArbiter {
  return {
    async rank() {
      throw new MistralRequestError(MISTRAL_ERROR_CODES.notConfigured, false, "AI provider is not configured");
    },
  };
}

function buildPaymentArbiter(mode: PaymentArbiterMode): PaymentArbiter {
  if (mode === "fake") return createFakePaymentArbiter();
  if (mode === "not_configured") return createNotConfiguredPaymentArbiter();
  const env = serverEnv();
  // Reuses MISTRAL_CHAT_MODEL - ranking payment candidates is a chat-completion call just
  // like document analysis and intake classification, and does not need a separate model
  // env var.
  return createMistralPaymentArbiter({ apiKey: env.MISTRAL_API_KEY ?? "", model: env.MISTRAL_CHAT_MODEL ?? "mistral-small-latest" });
}

declare global {
  var __paymentArbiter: PaymentArbiter | undefined;
}

export function getPaymentArbiter(): PaymentArbiter {
  return (globalThis.__paymentArbiter ??= buildPaymentArbiter(resolveMode()));
}

/** Test hook: drop the memoized adapter. */
export function resetPaymentArbiterForTests(): void {
  globalThis.__paymentArbiter = undefined;
}
