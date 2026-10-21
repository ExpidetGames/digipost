"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { getAuth } from "@/platform/auth/server";
import { serverEnv } from "@/platform/env/server";

import { safeNextPath } from "./core/safe-next-path";
import { magicLinkEmailSchema } from "./core/schemas";
import type { RequestErrorCode } from "./core/error-codes";

export type RequestMagicLinkState =
  | { status: "idle" }
  | { status: "sent"; email: string }
  | { status: "error"; errorCode: RequestErrorCode; email: string };

/**
 * Requests a magic link. Sign-in is rate-limited (`src/platform/auth/server/auth.ts`,
 * decisions/0005): a rate-limited Better Auth endpoint MUST be called through
 * `getAuth().handler(request)`, built from the incoming request, never
 * `auth.api.signInMagicLink` directly - a direct `.api.*` call bypasses Better
 * Auth's router-level rate limiter entirely (a real bug in a prior project). Runs
 * on the server so `callbackURL` is a trusted, already-sanitized relative path, not
 * something the client could redirect elsewhere.
 */
export async function requestMagicLinkAction(
  _prevState: RequestMagicLinkState,
  formData: FormData,
): Promise<RequestMagicLinkState> {
  const rawEmail = formData.get("email");
  const parsedEmail = magicLinkEmailSchema.safeParse(typeof rawEmail === "string" ? rawEmail : "");
  if (!parsedEmail.success) {
    return { status: "error", errorCode: "invalid_email", email: typeof rawEmail === "string" ? rawEmail : "" };
  }
  const email = parsedEmail.data;

  const next = safeNextPath(formData.get("next"));
  const incomingHeaders = await headers();
  const requestHeaders = new Headers({ "content-type": "application/json" });
  // Forward every IP header `src/platform/auth/server/auth.ts`'s `ipAddressHeaders` checks,
  // in the same trust order (P6 review finding B2) - `getAuth().handler(request)` only sees
  // this freshly built `Request`, not the original incoming one, so a header not forwarded
  // here is invisible to the rate limiter no matter how it is configured.
  for (const name of ["x-vercel-forwarded-for", "x-real-ip", "x-forwarded-for"]) {
    const value = incomingHeaders.get(name);
    if (value) requestHeaders.set(name, value);
  }

  const request = new Request(new URL("/api/auth/sign-in/magic-link", serverEnv().APP_URL), {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify({ email, callbackURL: next, errorCallbackURL: "/login" }),
  });

  let response: Response;
  try {
    response = await getAuth().handler(request);
  } catch (err) {
    console.error("[sign-in] magic link request failed", err instanceof Error ? err.message : err);
    return { status: "error", errorCode: "unknown", email };
  }

  if (response.status === 429) {
    return { status: "error", errorCode: "rate_limited", email };
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    console.error("[sign-in] magic link request failed", response.status, body);
    return { status: "error", errorCode: "unknown", email };
  }

  return { status: "sent", email };
}

/** Not rate-limited, so calling `auth.api.signOut` directly is fine (contrast with
 * `requestMagicLinkAction` above). */
export async function signOutAction(): Promise<void> {
  try {
    await getAuth().api.signOut({ headers: await headers() });
  } catch (err) {
    console.error("[sign-in] sign out failed", err instanceof Error ? err.message : err);
  }
  redirect("/login");
}
