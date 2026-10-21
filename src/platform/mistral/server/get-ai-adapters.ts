// The composition root's actual entry point (decisions/0016-processing-pipeline-and-ai.md):
// picks between the real Mistral adapters and this application's deterministic fakes by env,
// mirroring `src/platform/object-storage/server/get-object-storage.ts`'s lazy, memoized
// singleton pattern. `create-request-services.ts` calls `getOcrEngine()`/`getDocumentAnalyzer()`
// the same way it calls `getObjectStorage()` - it never chooses between adapters itself.
import "server-only";

import { createFakeDocumentAnalyzer, createFakeOcrEngine, type DocumentAnalyzer, type OcrEngine } from "@/modules/documents";
import { serverEnv } from "@/platform/env/server";

import { MISTRAL_ERROR_CODES, MistralRequestError } from "../core/errors";
import { createMistralDocumentAnalyzer } from "./mistral-analyzer";
import { createMistralOcrEngine } from "./mistral-ocr-engine";

type AiMode = "mistral" | "fake" | "not_configured";

/**
 * `AI_PROVIDER` explicit beats everything; unset falls back to "mistral" once a key exists,
 * otherwise to "fake" outside production, and to "not_configured" in production (a
 * misconfigured production deploy must fail loudly on first use, never silently simulate AI
 * output) - architecture brief / requirement 3 of decisions/0016-processing-pipeline-and-ai.md.
 */
function resolveMode(): AiMode {
  const env = serverEnv();
  if (env.AI_PROVIDER === "fake") return "fake";
  if (env.AI_PROVIDER === "mistral") return env.MISTRAL_API_KEY ? "mistral" : "not_configured";
  if (env.MISTRAL_API_KEY) return "mistral";
  return env.NODE_ENV === "production" ? "not_configured" : "fake";
}

function createNotConfiguredOcrEngine(): OcrEngine {
  return {
    async recognize() {
      throw new MistralRequestError(MISTRAL_ERROR_CODES.notConfigured, false, "AI provider is not configured");
    },
  };
}

function createNotConfiguredAnalyzer(): DocumentAnalyzer {
  return {
    async analyze() {
      throw new MistralRequestError(MISTRAL_ERROR_CODES.notConfigured, false, "AI provider is not configured");
    },
    // Wave 1 of decisions/0036-guided-extraction.md: `analyzeGuided` joined `DocumentAnalyzer`
    // beside `analyze` - this adapter fails exactly the same way for both, unconfigured is
    // unconfigured regardless of which method a future wave-2 caller uses.
    async analyzeGuided() {
      throw new MistralRequestError(MISTRAL_ERROR_CODES.notConfigured, false, "AI provider is not configured");
    },
  };
}

function buildOcrEngine(mode: AiMode): OcrEngine {
  if (mode === "fake") return createFakeOcrEngine();
  if (mode === "not_configured") return createNotConfiguredOcrEngine();
  const env = serverEnv();
  return createMistralOcrEngine({ apiKey: env.MISTRAL_API_KEY ?? "", model: env.MISTRAL_OCR_MODEL ?? "mistral-ocr-latest" });
}

function buildAnalyzer(mode: AiMode): DocumentAnalyzer {
  if (mode === "fake") return createFakeDocumentAnalyzer();
  if (mode === "not_configured") return createNotConfiguredAnalyzer();
  const env = serverEnv();
  return createMistralDocumentAnalyzer({ apiKey: env.MISTRAL_API_KEY ?? "", model: env.MISTRAL_CHAT_MODEL ?? "mistral-small-latest" });
}

declare global {
  // Memoized on `globalThis` so Next's dev-server HMR does not rebuild these on every
  // module reload (same pattern as `getObjectStorage()`/`getMailTransport()`).
  var __ocrEngine: OcrEngine | undefined;
  var __documentAnalyzer: DocumentAnalyzer | undefined;
}

export function getOcrEngine(): OcrEngine {
  return (globalThis.__ocrEngine ??= buildOcrEngine(resolveMode()));
}

export function getDocumentAnalyzer(): DocumentAnalyzer {
  return (globalThis.__documentAnalyzer ??= buildAnalyzer(resolveMode()));
}

/** Whether the fake AI provider is bound - the UI's "Testmodus: KI-Simulation aktiv" hint
 * banner (decisions/0016-processing-pipeline-and-ai.md, requirement 9). */
export function isFakeAiProviderActive(): boolean {
  return resolveMode() === "fake";
}

/** Test hook: drop the memoized adapters. */
export function resetAiAdaptersForTests(): void {
  globalThis.__ocrEngine = undefined;
  globalThis.__documentAnalyzer = undefined;
}
