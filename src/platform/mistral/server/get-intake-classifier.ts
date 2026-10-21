// Composition-root entry point for `IntakeClassifier` (decisions/0020-universal-intake.md,
// phase F1a), mirroring `get-ai-adapters.ts`'s `getOcrEngine()`/`getDocumentAnalyzer()`
// pattern (env-driven selection, `globalThis` memoization so Next's dev-server HMR does not
// rebuild it on every reload) without editing that file directly: F1a lands while another
// phase is mid-flight on this repository's schema/persistence, so every change here is
// additive-only (new files, or an appended export on `server.ts`/`index.ts`). A future phase
// wiring intake fully into the composition root can fold this into `get-ai-adapters.ts` if
// having two near-identical `resolveMode` copies ever becomes the more annoying option.
import "server-only";

import { createFakeIntakeClassifier, type IntakeClassifier } from "@/modules/intake";
import { serverEnv } from "@/platform/env/server";

import { MISTRAL_ERROR_CODES, MistralRequestError } from "../core/errors";
import { createMistralIntakeClassifier } from "./mistral-intake-classifier";

type IntakeClassifierMode = "mistral" | "fake" | "not_configured";

/** Identical precedence to `get-ai-adapters.ts`'s `resolveMode`: `AI_PROVIDER` explicit beats
 * everything; unset falls back to "mistral" once a key exists, otherwise to "fake" outside
 * production, and to "not_configured" in production. */
function resolveMode(): IntakeClassifierMode {
  const env = serverEnv();
  if (env.AI_PROVIDER === "fake") return "fake";
  if (env.AI_PROVIDER === "mistral") return env.MISTRAL_API_KEY ? "mistral" : "not_configured";
  if (env.MISTRAL_API_KEY) return "mistral";
  return env.NODE_ENV === "production" ? "not_configured" : "fake";
}

function createNotConfiguredIntakeClassifier(): IntakeClassifier {
  return {
    async classify() {
      throw new MistralRequestError(MISTRAL_ERROR_CODES.notConfigured, false, "AI provider is not configured");
    },
  };
}

function buildIntakeClassifier(mode: IntakeClassifierMode): IntakeClassifier {
  if (mode === "fake") return createFakeIntakeClassifier();
  if (mode === "not_configured") return createNotConfiguredIntakeClassifier();
  const env = serverEnv();
  // Reuses MISTRAL_CHAT_MODEL - intake classification is a chat-completion call just like
  // document analysis, and does not need a separate model env var.
  return createMistralIntakeClassifier({ apiKey: env.MISTRAL_API_KEY ?? "", model: env.MISTRAL_CHAT_MODEL ?? "mistral-small-latest" });
}

declare global {
  var __intakeClassifier: IntakeClassifier | undefined;
}

export function getIntakeClassifier(): IntakeClassifier {
  return (globalThis.__intakeClassifier ??= buildIntakeClassifier(resolveMode()));
}

/** Test hook: drop the memoized adapter. */
export function resetIntakeClassifierForTests(): void {
  globalThis.__intakeClassifier = undefined;
}
