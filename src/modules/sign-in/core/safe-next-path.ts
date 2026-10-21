// Guards the post-login redirect target against open redirects. The sign-in form
// carries `next` as a hidden field (round-tripped through the Server Action, not
// read from the client at redirect time), so a crafted value must never survive as
// anything but a same-origin, relative path.
const DEFAULT_NEXT_PATH = "/dashboard";

/**
 * Returns `raw` if it is safe to redirect to after sign-in, otherwise
 * `DEFAULT_NEXT_PATH`. Safe means: a string, starting with exactly one `/` (not
 * `//…` or `/\…`, both of which browsers can treat as protocol-relative and follow
 * to a different origin), containing no scheme (`javascript:`, `https:`, …) and no
 * control characters.
 */
export function safeNextPath(raw: FormDataEntryValue | string | null | undefined): string {
  if (typeof raw !== "string") return DEFAULT_NEXT_PATH;
  const value = raw.trim();

  if (!value.startsWith("/")) return DEFAULT_NEXT_PATH;
  if (/[\x00-\x1f]/.test(value)) return DEFAULT_NEXT_PATH;
  // Reject a second leading slash or a backslash right after the first slash: some
  // browsers normalize "//evil.com" or "/\evil.com" to a scheme-relative URL and
  // navigate off-origin. Anything starting with exactly one "/" followed by neither
  // is always a same-origin absolute path - it can never carry a URL scheme, which
  // requires a colon before the first "/".
  if (/^\/[/\\]/.test(value)) return DEFAULT_NEXT_PATH;

  return value;
}
