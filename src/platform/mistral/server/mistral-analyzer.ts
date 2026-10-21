// The real `DocumentAnalyzer` (architecture brief's product decision 8): `POST
// /v1/chat/completions`, `response_format: { type: "json_object" }`, `temperature: 0`.
// Implements `src/modules/documents/core/ports.ts`'s `DocumentAnalyzer`, and runs its parsed
// output through that same module's `validateAnalysisResult` (the shared guarantee both the
// real and fake adapters give every caller).
import "server-only";

import {
  validateAnalysisResult,
  validateGuidedAnalysisResult,
  type AnalysisResult,
  type DocumentAnalyzer,
  type GuidedAnalysisResult,
} from "@/modules/documents";

import { MISTRAL_ERROR_CODES, MistralRequestError } from "../core/errors";
import { mistralChatResponseSchema } from "../core/schemas";
import { mistralFetch, type MistralFetchConfig } from "./mistral-fetch";
import { buildAnalyzerSystemPrompt, buildAnalyzerUserPrompt, buildGuidedDerivedSystemPrompt, buildGuidedOpenSystemPrompt } from "./prompts";

export type MistralAnalyzerConfig = MistralFetchConfig & { model: string };

/** Shared by `analyze` and `analyzeGuided` below: send one chat-completion request and parse
 * its content as JSON, degrading to `{}` on anything that is not valid JSON at all (the actual
 * lenient field-by-field validation happens one level up, in `validateAnalysisResult`/
 * `validateGuidedAnalysisResult` - this function's only job is the HTTP request and the outer
 * JSON.parse). Throws a classified `MistralRequestError` when the chat response's own wrapper
 * shape (`{ choices: [{ message: { content } }] }`) fails to parse - a genuinely malformed API
 * response, distinct from the model's own content being malformed JSON. */
async function fetchAnalyzerContent(config: MistralAnalyzerConfig, systemPrompt: string, text: string): Promise<unknown> {
  const json = await mistralFetch(
    "/v1/chat/completions",
    {
      model: config.model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: buildAnalyzerUserPrompt(text) },
      ],
    },
    config,
  );

  const parsed = mistralChatResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new MistralRequestError(MISTRAL_ERROR_CODES.invalidResponse, false, "Mistral chat response failed validation");
  }

  const content = parsed.data.choices[0]?.message.content ?? "";
  try {
    return JSON.parse(content);
  } catch {
    return {};
  }
}

export function createMistralDocumentAnalyzer(config: MistralAnalyzerConfig): DocumentAnalyzer {
  return {
    async analyze({ text, ownCompany }): Promise<AnalysisResult> {
      const raw = await fetchAnalyzerContent(config, buildAnalyzerSystemPrompt(ownCompany), text);

      // `validateAnalysisResult` never throws: an adversarial or malformed model response
      // degrades to every field null, never a processing failure (see that function's own
      // header comment).
      return validateAnalysisResult(raw);
    },

    // Wave 1 of decisions/0036-guided-extraction.md (H-contract.md section 2), NOT yet called
    // by `processDocument` - built additively beside `analyze` above, same request/parse
    // machinery via `fetchAnalyzerContent`, only the system prompt and the validator differ.
    async analyzeGuided({ text, ownCompany, kind, plan }): Promise<GuidedAnalysisResult> {
      const systemPrompt =
        plan.mode === "derived"
          ? buildGuidedDerivedSystemPrompt(ownCompany, kind, plan)
          : buildGuidedOpenSystemPrompt(ownCompany, kind, plan);

      const raw = await fetchAnalyzerContent(config, systemPrompt, text);

      // Same never-throws guarantee as `validateAnalysisResult` - see that function's sibling
      // `validateGuidedAnalysisResult`'s own header comment.
      return validateGuidedAnalysisResult(raw, plan);
    },
  };
}
