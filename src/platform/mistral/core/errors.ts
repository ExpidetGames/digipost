// Stable error codes for anything that can go wrong calling Mistral (AGENTS.md "Code").
// `transient` decides retry behavior at the job-queue level:
// `src/persistence/use-cases/documents-use-cases.ts`'s `processDocument` catches
// `MistralRequestError` and rethrows it as `src/platform/jobs`'s `TransientJobError` or
// `PermanentJobError` depending on this flag, so `src/platform/jobs`/`jobs-use-cases.ts`
// never needs to know this owner exists.
export const MISTRAL_ERROR_CODES = {
  authFailed: "ai_auth_failed",
  rateLimited: "ai_rate_limited",
  timeout: "ai_timeout",
  unavailable: "ai_unavailable",
  invalidResponse: "ai_invalid_response",
  notConfigured: "ai_not_configured",
} as const;
export type MistralErrorCode = (typeof MISTRAL_ERROR_CODES)[keyof typeof MISTRAL_ERROR_CODES];

export class MistralRequestError extends Error {
  override readonly name = "MistralRequestError";
  constructor(
    readonly code: MistralErrorCode,
    readonly transient: boolean,
    message?: string,
  ) {
    // Never includes the request body, the response body, or the API key - only a fixed,
    // generic message per code (this owner's "never log document contents" rule extends to
    // the error's own message, not only to explicit logging calls).
    super(message ?? code);
  }
}
