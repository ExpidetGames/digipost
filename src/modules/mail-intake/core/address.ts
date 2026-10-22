// The per-workspace inbound address (decisions/0075-email-intake.md): `post-<token>@<domain>`.
// Pure: no I/O. The token is the ONLY thing that routes a received mail to a workspace, so it
// must be unguessable (>= 80 bits), easy to read aloud or retype (lowercase, no lookalike
// characters), and parsed strictly (a mail to any other local part is simply not ours).

/** Lowercase letters and digits without the lookalikes `i`, `l`, `o`, `u` (and `0`/`1`):
 * 30 symbols, so a 20-character token carries 20 * log2(30) = ~98 bits. */
export const INBOUND_TOKEN_ALPHABET = "abcdefghjkmnpqrstvwxyz23456789";
export const INBOUND_TOKEN_LENGTH = 20;
export const INBOUND_LOCAL_PART_PREFIX = "post-";

const TOKEN_PATTERN = new RegExp(`^[${INBOUND_TOKEN_ALPHABET}]{${INBOUND_TOKEN_LENGTH}}$`);

/**
 * A fresh random token. `randomBytes` is injectable for tests; the default is the Web Crypto
 * CSPRNG. Rejection sampling (bytes >= 240 are discarded) keeps every symbol exactly equally
 * likely, since 256 is not a multiple of 30.
 */
export function generateInboundToken(randomBytes: (length: number) => Uint8Array = defaultRandomBytes): string {
  const limit = Math.floor(256 / INBOUND_TOKEN_ALPHABET.length) * INBOUND_TOKEN_ALPHABET.length;
  let token = "";
  while (token.length < INBOUND_TOKEN_LENGTH) {
    for (const byte of randomBytes(INBOUND_TOKEN_LENGTH * 2)) {
      if (byte >= limit) continue;
      token += INBOUND_TOKEN_ALPHABET[byte % INBOUND_TOKEN_ALPHABET.length];
      if (token.length === INBOUND_TOKEN_LENGTH) break;
    }
  }
  return token;
}

function defaultRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

export function isValidInboundToken(token: string): boolean {
  return TOKEN_PATTERN.test(token);
}

/** Lowercased and stripped of a leading dot, so `INBOX.Example.de` and `inbox.example.de`
 * configure the same domain. */
export function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/^\.+/, "").replace(/\.+$/, "");
}

export function formatInboundAddress(token: string, domain: string): string {
  return `${INBOUND_LOCAL_PART_PREFIX}${token}@${normalizeDomain(domain)}`;
}

/**
 * The bare, lowercased address out of a header-style value: `"Muster GmbH" <Info@Muster.de>`
 * and `info@muster.de` both give `info@muster.de`. `null` when there is no plausible address
 * at all (no `@`, an empty local part or domain).
 */
export function extractEmailAddress(raw: string): string | null {
  const trimmed = raw.trim();
  const angle = /<([^<>]*)>\s*$/.exec(trimmed);
  const candidate = (angle ? angle[1]! : trimmed).trim().toLowerCase();
  const at = candidate.lastIndexOf("@");
  if (at <= 0 || at === candidate.length - 1) return null;
  if (/\s/.test(candidate)) return null;
  return candidate;
}

/** The domain part of an already extracted address, or `null`. */
export function emailDomain(address: string): string | null {
  const at = address.lastIndexOf("@");
  if (at < 0) return null;
  const domain = address.slice(at + 1);
  return domain.length > 0 ? domain : null;
}

/**
 * The workspace token a recipient address carries, or `null` when the address is not one of
 * ours. Deliberately strict (decisions/0075-email-intake.md): the provider forwards EVERY mail
 * the whole account receives, so only a domain equal to `domain` (case-insensitive) and a
 * local part that is exactly `post-<token>` with a well-formed token qualify. No `+tag`, no
 * subdomain, no lookalike.
 */
export function parseInboundRecipient(raw: string, domain: string): string | null {
  const address = extractEmailAddress(raw);
  if (!address) return null;
  const at = address.lastIndexOf("@");
  if (address.slice(at + 1) !== normalizeDomain(domain)) return null;
  const local = address.slice(0, at);
  if (!local.startsWith(INBOUND_LOCAL_PART_PREFIX)) return null;
  const token = local.slice(INBOUND_LOCAL_PART_PREFIX.length);
  return isValidInboundToken(token) ? token : null;
}

/** Every distinct workspace token among all recipient fields of one received mail (To, Cc,
 * Bcc and the envelope's `received_for`), in first-seen order. */
export function collectInboundTokens(recipients: readonly string[], domain: string): string[] {
  const tokens: string[] = [];
  for (const recipient of recipients) {
    const token = parseInboundRecipient(recipient, domain);
    if (token && !tokens.includes(token)) tokens.push(token);
  }
  return tokens;
}
