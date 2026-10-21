// The one place a Mistral HTTP request is actually made: plain `fetch` (no SDK,
// WEBAPP_TEMPLATE_SPEC.md's Mistral OCR facts), a timeout via `AbortSignal.timeout`, and
// error classification (401/403 permanent `ai_auth_failed`; 429/5xx/timeout transient).
// `fetchImpl` is always injectable so tests never touch the network (WEBAPP_TEMPLATE_SPEC.md
// §10.2). Never logs the request or response body: only HTTP status codes ever appear in an
// error message, never document content or the API key.
import "server-only";

import { MISTRAL_ERROR_CODES, MistralRequestError } from "../core/errors";

const MISTRAL_API_BASE_URL = "https://api.mistral.ai";
const DEFAULT_TIMEOUT_MS = 60_000;

export type MistralFetchConfig = {
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export async function mistralFetch(path: string, body: unknown, config: MistralFetchConfig): Promise<unknown> {
  const fetchImpl = config.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await fetchImpl(`${MISTRAL_API_BASE_URL}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      throw new MistralRequestError(MISTRAL_ERROR_CODES.timeout, true, "Mistral request timed out");
    }
    throw new MistralRequestError(MISTRAL_ERROR_CODES.unavailable, true, "Mistral request could not be sent");
  }

  if (response.status === 401 || response.status === 403) {
    throw new MistralRequestError(MISTRAL_ERROR_CODES.authFailed, false, `Mistral rejected the request (${response.status})`);
  }
  if (response.status === 429) {
    throw new MistralRequestError(MISTRAL_ERROR_CODES.rateLimited, true, "Mistral rate-limited the request");
  }
  if (response.status >= 500) {
    throw new MistralRequestError(MISTRAL_ERROR_CODES.unavailable, true, `Mistral server error (${response.status})`);
  }
  if (!response.ok) {
    throw new MistralRequestError(MISTRAL_ERROR_CODES.invalidResponse, false, `Mistral request failed (${response.status})`);
  }

  try {
    return await response.json();
  } catch {
    throw new MistralRequestError(MISTRAL_ERROR_CODES.invalidResponse, false, "Mistral response was not valid JSON");
  }
}
