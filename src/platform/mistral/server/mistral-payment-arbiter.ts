// The real `PaymentArbiter` (decisions/0023-payment-matching.md, phase F3a): `POST
// /v1/chat/completions`, `response_format: { type: "json_object" }`, `temperature: 0` -
// exactly `mistral-intake-classifier.ts`'s shape, reused rather than duplicated
// (`mistralFetch`, `mistralChatResponseSchema`, the same error classification). Returns the
// RAW `PaymentArbiterRawResult` - it deliberately does NOT call
// `@/modules/payments`'s `validateArbiterResult` itself: that function needs the exact
// `PaymentArbiterInput` (transaction + candidates) to re-check direction/candidate-membership,
// which the adapter already has here but the port's own contract keeps validation as the
// CALLER's responsibility (`F3b`, or a test), so every `PaymentArbiter` implementation
// (real and fake alike) is validated the identical way, in one place, rather than each
// adapter re-implementing the same check.
import "server-only";

import type { MatchableDocument, MatchableTransaction, PaymentArbiter, PaymentArbiterRawResult } from "@/modules/payments";
import { MAX_ARBITER_CANDIDATES } from "@/modules/payments";

import { MISTRAL_ERROR_CODES, MistralRequestError } from "../core/errors";
import { mistralChatResponseSchema } from "../core/schemas";
import { mistralFetch, type MistralFetchConfig } from "./mistral-fetch";
import { buildPaymentArbiterSystemPrompt, buildPaymentArbiterUserPrompt } from "./payment-arbiter-prompts";

export type MistralPaymentArbiterConfig = MistralFetchConfig & { model: string };

/**
 * `bestDocumentId`/`confidence`/`reason` are parsed as leniently as possible from the model's
 * JSON content (missing/wrong-typed fields degrade to a "no suggestion" answer, never a thrown
 * error) - the actual hallucination/direction/format guarantees are
 * `@/modules/payments`'s `validateArbiterResult`'s job, run by the caller against this
 * adapter's raw output.
 */
export function createMistralPaymentArbiter(config: MistralPaymentArbiterConfig): PaymentArbiter {
  return {
    async rank(input: { transaction: MatchableTransaction; candidates: readonly MatchableDocument[] }): Promise<PaymentArbiterRawResult> {
      if (input.candidates.length > MAX_ARBITER_CANDIDATES) {
        throw new Error(`Payment arbiter called with ${input.candidates.length} candidates, more than the max of ${MAX_ARBITER_CANDIDATES}`);
      }
      if (input.candidates.length === 0) {
        return { bestDocumentId: null, confidence: 0, reason: "Keine Kandidaten vorhanden." };
      }

      const json = await mistralFetch(
        "/v1/chat/completions",
        {
          model: config.model,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: buildPaymentArbiterSystemPrompt() },
            { role: "user", content: buildPaymentArbiterUserPrompt(input) },
          ],
        },
        config,
      );

      const parsed = mistralChatResponseSchema.safeParse(json);
      if (!parsed.success) {
        throw new MistralRequestError(MISTRAL_ERROR_CODES.invalidResponse, false, "Mistral payment-arbiter response failed validation");
      }

      const content = parsed.data.choices[0]?.message.content ?? "";
      let raw: unknown;
      try {
        raw = JSON.parse(content);
      } catch {
        raw = {};
      }

      return normalizeRawResult(raw);
    },
  };
}

function normalizeRawResult(raw: unknown): PaymentArbiterRawResult {
  if (typeof raw !== "object" || raw === null) {
    return { bestDocumentId: null, confidence: 0, reason: "Die Antwort des Modells konnte nicht ausgewertet werden." };
  }
  const record = raw as Record<string, unknown>;
  const bestDocumentId = typeof record.bestDocumentId === "string" ? record.bestDocumentId : null;
  const confidence = typeof record.confidence === "number" ? record.confidence : 0;
  const reason = typeof record.reason === "string" ? record.reason : "";
  return { bestDocumentId, confidence, reason };
}
