// The real `IntakeClassifier` (decisions/0020-universal-intake.md, phase F1a): `POST
// /v1/chat/completions`, `response_format: { type: "json_object" }`, `temperature: 0` -
// exactly `mistral-analyzer.ts`'s shape, reused rather than duplicated (`mistralFetch`,
// `mistralChatResponseSchema`, the same error classification). Implements
// `src/modules/intake/core/classification.ts`'s `IntakeClassifier`, and runs its parsed
// output through that same module's `parseIntakeClassification` (the shared guarantee both
// the real and fake adapters give every caller - including that a hallucinated column name
// never survives into the returned `IntakeClassification`).
import "server-only";

import { parseIntakeClassification, type IntakeClassification, type IntakeClassifier, type IntakeClassifierInput } from "@/modules/intake";

import { MISTRAL_ERROR_CODES, MistralRequestError } from "../core/errors";
import { mistralChatResponseSchema } from "../core/schemas";
import { mistralFetch, type MistralFetchConfig } from "./mistral-fetch";
import { buildIntakeSystemPrompt, buildIntakeUserPrompt } from "./intake-prompts";

export type MistralIntakeClassifierConfig = MistralFetchConfig & { model: string };

export function createMistralIntakeClassifier(config: MistralIntakeClassifierConfig): IntakeClassifier {
  return {
    async classify(input: IntakeClassifierInput): Promise<IntakeClassification> {
      const json = await mistralFetch(
        "/v1/chat/completions",
        {
          model: config.model,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: buildIntakeSystemPrompt(input.kind === "text" ? input.ownCompany : null) },
            { role: "user", content: buildIntakeUserPrompt(input) },
          ],
        },
        config,
      );

      const parsed = mistralChatResponseSchema.safeParse(json);
      if (!parsed.success) {
        throw new MistralRequestError(MISTRAL_ERROR_CODES.invalidResponse, false, "Mistral intake-classification response failed validation");
      }

      const content = parsed.data.choices[0]?.message.content ?? "";
      let raw: unknown;
      try {
        raw = JSON.parse(content);
      } catch {
        raw = {};
      }

      const header = input.kind === "tabular" ? input.sample.header : null;
      // `parseIntakeClassification` never throws: an adversarial or malformed model
      // response degrades to `documentKind: "other"` with everything else null/empty, never
      // a processing failure, and any column name it invents that is not actually in
      // `header` is dropped rather than trusted (see that function's own header comment).
      return parseIntakeClassification(raw, header);
    },
  };
}
