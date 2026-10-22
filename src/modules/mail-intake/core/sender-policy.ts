// Who may send mail into a workspace (decisions/0075-email-intake.md). Pure: no I/O.
//
// `allowlist` (the default) accepts a sender that is either one of the workspace's own members
// (implicitly, so a team can forward its own mail without setting anything up) or matches an
// entry an admin added: a full address (`buchhaltung@lieferant.de`) or a whole domain
// (`lieferant.de`, which also covers its subdomains such as `mail.lieferant.de`). `anyone`
// accepts every sender who knows the address.
//
// A `From:` address alone proves nothing: anyone can put any address there. So under
// `allowlist` a sender must ALSO be authenticated by the receiving side
// (`isSenderAuthenticated`): DMARC `pass`, or, where the sender's domain publishes no DMARC
// policy at all, SPF `pass` AND DKIM `pass`. Under `anyone` nobody is checked, since the
// unguessable address is then the only gate anyway (and the admin can rotate it).
import { emailDomain, extractEmailAddress } from "./address";

export const SENDER_POLICIES = ["allowlist", "anyone"] as const;
export type SenderPolicy = (typeof SENDER_POLICIES)[number];
export const DEFAULT_SENDER_POLICY: SenderPolicy = "allowlist";

export const ALLOWED_SENDER_KINDS = ["email", "domain"] as const;
export type AllowedSenderKind = (typeof ALLOWED_SENDER_KINDS)[number];

export type AllowedSenderEntry = { kind: AllowedSenderKind; value: string };

/** An allowlist has no business being longer than this; a cap keeps one admin form from
 * growing an unbounded table. */
export const MAX_ALLOWED_SENDERS = 200;

const DOMAIN_PATTERN = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const LOCAL_PART_PATTERN = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}$/;

/**
 * What an admin typed into the allowlist field, normalized: `Info@Muster.de` is the address
 * `info@muster.de`; `muster.de`, `@muster.de` and `*@muster.de` are the domain `muster.de`.
 * `null` for anything that is neither.
 */
export function normalizeAllowedSenderEntry(input: string): AllowedSenderEntry | null {
  const value = input.trim().toLowerCase();
  if (value.length === 0 || value.length > 254) return null;

  const domainOnly = value.replace(/^\*?@/, "");
  if (!domainOnly.includes("@")) {
    return DOMAIN_PATTERN.test(domainOnly) ? { kind: "domain", value: domainOnly } : null;
  }

  const address = extractEmailAddress(value);
  if (!address) return null;
  const at = address.lastIndexOf("@");
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  if (!LOCAL_PART_PATTERN.test(local) || !DOMAIN_PATTERN.test(domain)) return null;
  return { kind: "email", value: address };
}

function domainMatches(senderDomain: string, allowedDomain: string): boolean {
  return senderDomain === allowedDomain || senderDomain.endsWith(`.${allowedDomain}`);
}

/**
 * Whether a received mail's `From:` passes the workspace's policy. `memberEmails` are the
 * workspace members' own sign-in addresses, implicitly allowed under `allowlist`.
 */
export function isSenderAllowed(input: {
  policy: SenderPolicy;
  from: string;
  entries: readonly AllowedSenderEntry[];
  memberEmails: readonly string[];
}): boolean {
  if (input.policy === "anyone") return true;

  const sender = extractEmailAddress(input.from);
  if (!sender) return false;
  const senderDomain = emailDomain(sender);

  if (input.memberEmails.some((email) => email.trim().toLowerCase() === sender)) return true;

  return input.entries.some((entry) => {
    if (entry.kind === "email") return entry.value === sender;
    return senderDomain !== null && domainMatches(senderDomain, entry.value);
  });
}

/** SPF/DKIM/DMARC verdicts as the receiving provider reported them, lowercased; `null` when a
 * check was not reported. */
export type SenderAuthentication = { spf: string | null; dkim: string | null; dmarc: string | null };

/**
 * Whether the mail's `From:` is authenticated well enough to trust it for the allowlist.
 * DMARC `pass` is the real proof that the `From:` domain sent the mail (it requires SPF or
 * DKIM to pass AND to align with that domain). DMARC can only be absent or `none` when the
 * sender's domain publishes no DMARC record; then BOTH SPF and DKIM must pass. That fallback
 * is weaker (without DMARC neither check is tied to the `From:` domain itself) and accepted
 * deliberately, because many small senders publish no DMARC record at all
 * (decisions/0075-email-intake.md). Anything else, including no authentication data at all,
 * fails closed.
 */
export function isSenderAuthenticated(authentication: SenderAuthentication | null): boolean {
  if (!authentication) return false;
  const dmarc = authentication.dmarc?.toLowerCase() ?? null;
  if (dmarc === "pass") return true;
  if (dmarc !== null && dmarc !== "none") return false;
  return authentication.spf?.toLowerCase() === "pass" && authentication.dkim?.toLowerCase() === "pass";
}
