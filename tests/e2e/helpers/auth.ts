/**
 * Better Auth e2e helpers (WEBAPP_TEMPLATE_SPEC.md §10.4).
 *
 * 1. Real magic links (auth.spec.ts's main flow): the UI requests the link through
 *    the real login form, mailed through the app's own SMTP config and caught by
 *    the local Mailpit container - `magicLinkFor()` polls Mailpit's API and
 *    extracts the link from the mail's plain-text part. Opening it runs the real
 *    flow end to end: Better Auth's own `/api/auth/magic-link/verify` consumes the
 *    token, sets the session cookie, and redirects to `callbackURL` - there is no
 *    separate callback route.
 *
 * 2. Fast sessions for every other spec: `createTestUser()` inserts a user +
 *    session row directly (owner SQL) and `loginAs()` signs the session-token
 *    cookie the same way Better Auth's `setSignedCookie` does (better-call's
 *    HMAC-SHA256 + base64, percent-encoded - see `signSessionCookieValue` below),
 *    so no HTTP round trip and no rate limit is involved at all.
 */
import { createHmac, randomBytes } from "node:crypto";

import { expect, type BrowserContext, type Page } from "@playwright/test";

import { ownerQuery, uniqueEmail, type DbUser } from "./db";
import { envOr, requireEnv } from "./env";

const MAILPIT_API = envOr("MAILPIT_API_URL", "http://localhost:54344");

/** Session token cookie, without the `__Secure-` prefix Better Auth adds over https. */
export const SESSION_COOKIE = "better-auth.session_token";
/** Prefix of every Better Auth cookie (session token, session data cache, …). */
export const AUTH_COOKIE_RE = /^(?:__Secure-)?better-auth\./;

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Session cookie signing (mirrors better-call's `signCookieValue`, used
// internally by Better Auth's `setSessionCookie` - see src/platform/auth/server/auth.ts)
// ---------------------------------------------------------------------------

/** `<value>.<base64 HMAC-SHA256 signature>`, percent-encoded (matches better-call's `signCookieValue`). */
function signSessionCookieValue(value: string, secret: string): string {
  const signature = createHmac("sha256", secret).update(value).digest("base64");
  return encodeURIComponent(`${value}.${signature}`);
}

// ---------------------------------------------------------------------------
// Fast sessions: user + session row inserted directly, cookie signed locally
// ---------------------------------------------------------------------------

export type TestUser = DbUser & { sessionToken: string };

/**
 * Creates a fresh user and a session for it directly in the database (no HTTP round trip,
 * no rate limit). `email` defaults to a generated unique address for `label`; pass one
 * explicitly when the caller needs the row's real email to match something specific (e.g.
 * `tests/e2e/invitation.spec.ts` signing an invitee in as the exact address a workspace
 * invitation was sent to - the row's actual DB email is what `acceptInvitationAction`
 * checks, not any value assigned to the returned object afterward).
 */
export async function createTestUser(label: string, email: string = uniqueEmail(label)): Promise<TestUser> {
  const [user] = await ownerQuery<{ id: string }>(
    `insert into auth."user" (name, email, "emailVerified") values ($1, $2, true) returning id`,
    [`e2e ${label}`, email],
  );
  if (!user) throw new Error(`createTestUser(${label}) returned no user row`);

  const sessionToken = randomBytes(32).toString("hex");
  // "updatedAt" has no column default (only "createdAt" does) - set explicitly.
  await ownerQuery(
    `insert into auth.session (token, "userId", "expiresAt", "updatedAt") values ($1, $2, $3, now())`,
    [sessionToken, user.id, new Date(Date.now() + 30 * DAY_MS)],
  );

  return { id: user.id, email, sessionToken };
}

/**
 * Puts the user's signed session cookie into the browser context, like the app
 * sets it (host-only, HttpOnly, SameSite=Lax). `secure` mirrors
 * `src/platform/auth/server/auth.ts`'s `useSecureCookies: env.NODE_ENV === "production"` -
 * NOT the baseURL's protocol: `playwright.config.ts`'s `webServer` runs
 * `next build && next start`, which Next always runs with `NODE_ENV=production`
 * regardless of the parent shell, so the real app always sends `Secure`-flagged,
 * `__Secure-`-prefixed cookies here, even over the plain `http://localhost`
 * baseURL - Chromium's "potentially trustworthy" exception for `localhost` accepts
 * and returns them anyway. Both cookie variants are set: the `__Secure-` one for
 * that production server (and the Docker test stack), the plain one for a reused
 * `next dev` server (`NODE_ENV=development`, `useSecureCookies: false`). The app
 * reads only the name it expects, so the other cookie is inert - the same helper
 * works in both modes without detecting which one it is running in.
 */
export async function loginAs(context: BrowserContext, user: TestUser, baseURL: string): Promise<void> {
  const value = signSessionCookieValue(user.sessionToken, requireEnv("BETTER_AUTH_SECRET"));
  const base = {
    value,
    domain: new URL(baseURL).hostname,
    path: "/",
    httpOnly: true,
    sameSite: "Lax" as const,
    expires: Math.floor((Date.now() + 30 * DAY_MS) / 1000),
  };
  await context.addCookies([
    { ...base, name: `__Secure-${SESSION_COOKIE}`, secure: true },
    { ...base, name: SESSION_COOKIE, secure: false },
  ]);
}

// ---------------------------------------------------------------------------
// Magic links (real flow, via Mailpit)
// ---------------------------------------------------------------------------

/** Fills the login form and requests the link, waiting for the "check your inbox" state
 * (German copy, decisions/0013-german-ui-language.md: `src/i18n/messages/de.json`'s `Login` namespace). */
export async function requestMagicLink(page: Page, email: string): Promise<void> {
  await page.getByLabel("E-Mail-Adresse").fill(email);
  await page.getByRole("button", { name: "Anmeldelink senden" }).click();
  await expect(page.getByRole("heading", { name: "Bitte prüfen Sie Ihr Postfach" })).toBeVisible({ timeout: 20_000 });
}

type MailpitSummary = { ID: string; To: { Address: string }[]; Subject: string };
type MailpitMessage = { Text: string };

async function messageText(id: string): Promise<string> {
  const res = await fetch(`${MAILPIT_API}/api/v1/message/${id}`);
  if (!res.ok) throw new Error(`Mailpit /message failed: ${res.status}`);
  const data = (await res.json()) as MailpitMessage;
  return data.Text;
}

/**
 * Polls Mailpit for a mail to `address` whose plain-text part contains a URL matching
 * `linkPattern`, and returns that URL. A user can receive more than one mail during a
 * spec (e.g. an invitation mail followed later by a magic-link mail,
 * `tests/e2e/invitation.spec.ts`); checking every candidate message's actual content -
 * rather than assuming whichever mail arrived first or last is the right one - keeps
 * `magicLinkFor`/`invitationLinkFor` correct regardless of arrival order.
 */
async function waitForLinkInMailTo(address: string, linkPattern: RegExp, timeoutMs = 20_000): Promise<string> {
  const lower = address.toLowerCase();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await fetch(`${MAILPIT_API}/api/v1/messages?limit=200`);
    if (res.ok) {
      const data = (await res.json()) as { messages: MailpitSummary[] };
      const candidates = data.messages.filter((m) => m.To?.some((t) => t.Address.toLowerCase() === lower));
      for (const candidate of candidates) {
        const text = await messageText(candidate.ID);
        const match = linkPattern.exec(text);
        if (match) return match[0];
      }
    }
    if (Date.now() > deadline) throw new Error(`no mail to ${address} contained a link matching ${linkPattern}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/**
 * Waits for the magic-link mail Mailpit just caught for `email` and returns the
 * verify URL it contains (`src/platform/auth/server/emails/magic-link-email.tsx` puts
 * the raw link in the plain-text part, on its own line).
 */
export async function magicLinkFor(email: string): Promise<string> {
  return waitForLinkInMailTo(email, /https?:\/\/\S*\/api\/auth\/magic-link\/verify\?\S+/);
}

/**
 * Waits for the workspace invitation mail Mailpit just caught for `email` and returns
 * the `/invite/<token>` URL it contains
 * (`src/modules/workspaces/server/emails/invitation-email.tsx`).
 */
export async function invitationLinkFor(email: string): Promise<string> {
  return waitForLinkInMailTo(email, /https?:\/\/\S*\/invite\/\S+/);
}

/**
 * Waits for any mail to `address` whose Subject contains `substring` - used to prove a
 * notification e-mail arrived without needing to extract a link from it (the document
 * assignment mail, `src/modules/documents/server/emails/assignment-email.tsx`,
 * decisions/0016-processing-pipeline-and-ai.md).
 */
export async function waitForMailSubjectContaining(address: string, substring: string, timeoutMs = 20_000): Promise<void> {
  const lower = address.toLowerCase();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await fetch(`${MAILPIT_API}/api/v1/messages?limit=200`);
    if (res.ok) {
      const data = (await res.json()) as { messages: MailpitSummary[] };
      const found = data.messages.some(
        (m) => m.To?.some((t) => t.Address.toLowerCase() === lower) && m.Subject.includes(substring),
      );
      if (found) return;
    }
    if (Date.now() > deadline) {
      throw new Error(`no mail to ${address} with subject containing "${substring}" arrived within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
