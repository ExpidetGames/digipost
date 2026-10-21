// The Better Auth instance (WEBAPP_TEMPLATE_SPEC.md §6.3, decisions/0005). Self-hosted,
// magic link only: `emailAndPassword` stays disabled, no password to hash and no
// password-reset flow to build and secure. The magic-link token is stored hashed
// (`storeToken: "hashed"`), never in plain text.
//
// Rate limiting is database-backed (`rateLimit.storage: "database"`, the `auth.rateLimit`
// table) so limits are shared across serverless instances; the sign-in endpoint gets a
// stricter rule than the (currently unused) global default. Rate limiting only applies
// inside Better Auth's own HTTP router: a caller that invokes `auth.api.*` directly
// bypasses it entirely (a real bug in a prior project, decisions/0005) - callers that
// need the rate limit MUST go through `getAuth().handler(request)`
// (`src/modules/sign-in/actions.ts`'s `requestMagicLinkAction`), never `auth.api.signInMagicLink`.
//
// Cookies stay host-only (no cross-subdomain cookies), `Secure` in production
// (`advanced.useSecureCookies`), `SameSite` at the library default (`Lax`): a
// magic-link click is a cross-site top-level navigation (mail client -> our host).
//
// Built lazily (`getAuth()`, not at module scope): constructing it opens the auth
// database connection and validates `BETTER_AUTH_SECRET`/`APP_URL`, which builds and
// tests that never touch an auth code path should not pay for.
import "server-only";

import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { magicLink } from "better-auth/plugins";

import { getAuthDb, authSchema } from "@/persistence/composition/auth-database";
import { createSmtpMailer } from "@/platform/mailer/server";
import { serverEnv } from "@/platform/env/server";

import { MAGIC_LINK_EMAIL_SUBJECT, renderMagicLinkEmail } from "./emails/magic-link-email";

/** Magic-link token lifetime (WEBAPP_TEMPLATE_SPEC.md §6.3). */
export const MAGIC_LINK_EXPIRES_IN_SECONDS = 15 * 60;

/** Sign-in rate limit: 3 requests per 60s, keyed by IP (decisions/0005). */
const MAGIC_LINK_RATE_LIMIT = { window: 60, max: 3 } as const;

/** Session lifetime, refresh cadence, and cookie cache (WEBAPP_TEMPLATE_SPEC.md §6.3). */
const SESSION_EXPIRES_IN_SECONDS = 30 * 24 * 60 * 60;
const SESSION_UPDATE_AGE_SECONDS = 24 * 60 * 60;
const COOKIE_CACHE_MAX_AGE_SECONDS = 5 * 60;

/**
 * Sends the magic-link mail over our own SMTP (`src/platform/mailer`) using the template
 * in `./emails/magic-link-email.tsx`. Throws on failure so the sign-in endpoint
 * reports a clear error - there is no outbox/retry for this path.
 */
async function sendMagicLink({ email, url }: { email: string; url: string }): Promise<void> {
  const mailer = createSmtpMailer();
  const { html, text } = await renderMagicLinkEmail({
    url,
    expiresInMinutes: MAGIC_LINK_EXPIRES_IN_SECONDS / 60,
  });

  try {
    await mailer.send({ to: email, subject: MAGIC_LINK_EMAIL_SUBJECT, html, text });
  } catch (err) {
    console.error("[auth] sending magic link failed", err instanceof Error ? err.message : err);
    throw err;
  }
}

function buildAuth() {
  const env = serverEnv();

  return betterAuth({
    baseURL: env.APP_URL,
    secret: env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(getAuthDb(), { provider: "pg", schema: authSchema }),
    trustedOrigins: [env.APP_URL],
    emailAndPassword: { enabled: false },
    plugins: [
      magicLink({
        sendMagicLink,
        expiresIn: MAGIC_LINK_EXPIRES_IN_SECONDS,
        storeToken: "hashed",
        rateLimit: MAGIC_LINK_RATE_LIMIT,
      }),
      // Must be last: lets Server Actions (the login form's Server Action) set cookies.
      nextCookies(),
    ],
    rateLimit: {
      enabled: true,
      storage: "database",
      customRules: {
        "/sign-in/magic-link": MAGIC_LINK_RATE_LIMIT,
      },
    },
    advanced: {
      database: { generateId: "uuid" },
      // Checked in order, first match wins (Better Auth's `getIP`, `@better-auth/core`'s
      // `utils/ip.ts`). `x-forwarded-for` alone (P6 review finding B2) is set by nearly any
      // proxy and, on a deployment ever reachable without a trusted proxy in front of it,
      // can be forged directly by the client - this app's magic-link rate limit is keyed by
      // this value, so a forged one lets an attacker split their own requests across
      // arbitrarily many rate-limit buckets. `x-vercel-forwarded-for` is set by Vercel's own
      // edge network and cannot be overridden by a client request; `x-real-ip` is a common
      // second-choice header set by other reverse proxies (nginx etc.). `x-forwarded-for`
      // stays last, as the least trustworthy fallback, for local development and any
      // deployment target that only forwards that header - see
      // `src/platform/auth/README.md`'s "IP address trust" section and
      // decisions/0005-better-auth-magic-link-drizzle-adapter.md for the residual risk this
      // does not remove (a deployment with no trusted proxy in front of it at all).
      ipAddress: { ipAddressHeaders: ["x-vercel-forwarded-for", "x-real-ip", "x-forwarded-for"] },
      useSecureCookies: env.NODE_ENV === "production",
    },
    session: {
      expiresIn: SESSION_EXPIRES_IN_SECONDS,
      updateAge: SESSION_UPDATE_AGE_SECONDS,
      cookieCache: { enabled: true, maxAge: COOKIE_CACHE_MAX_AGE_SECONDS },
    },
  });
}

let instance: ReturnType<typeof buildAuth> | undefined;

/** The shared, lazily built Better Auth instance. */
export function getAuth(): ReturnType<typeof buildAuth> {
  return (instance ??= buildAuth());
}

/** Test hook: drop the memoized instance so a test can rebuild it against a different env. */
export function resetAuthForTests(): void {
  instance = undefined;
}
