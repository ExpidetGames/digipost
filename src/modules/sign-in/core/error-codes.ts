// Stable error codes (AGENTS.md "Code": `as const` sets, never raw provider text).
// `ui/login-form.tsx` maps these to next-intl message keys under "Login.errors".

/** Codes `actions.ts`'s `requestMagicLinkAction` can return. */
export const REQUEST_ERROR_CODES = ["invalid_email", "rate_limited", "unknown"] as const;
export type RequestErrorCode = (typeof REQUEST_ERROR_CODES)[number];

/**
 * Codes Better Auth's magic-link `verify` endpoint can append to
 * `errorCallbackURL` as `?error=…` (see `src/app/(auth)/login/page.tsx`, which passes
 * `errorCallbackURL: "/login"` when requesting the link). `INVALID_TOKEN` covers
 * both an expired and an already-used link - each token is consumed atomically on
 * first use, so Better Auth cannot tell the two apart.
 */
export const CALLBACK_ERROR_CODES = ["INVALID_TOKEN", "auth_failed"] as const;
export type CallbackErrorCode = (typeof CALLBACK_ERROR_CODES)[number];

/** Maps an arbitrary `?error=` query value to a known callback error code, never
 * echoing unrecognized (or malicious) input back into the page. */
export function resolveCallbackErrorCode(raw: string | undefined | null): CallbackErrorCode | undefined {
  if (!raw) return undefined;
  return (CALLBACK_ERROR_CODES as readonly string[]).includes(raw) ? (raw as CallbackErrorCode) : "auth_failed";
}
