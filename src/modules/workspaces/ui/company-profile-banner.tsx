"use client";

import { useSyncExternalStore } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";

const DISMISS_SESSION_KEY = "digipost:company-profile-banner-dismissed";

// `useSyncExternalStore` (not `useState`+`useEffect`): reading `sessionStorage` during render
// would mismatch between the server (no `sessionStorage` at all) and the client's first paint
// (`sessionStorage` may already say "dismissed"), and setting that state from inside an effect
// trips this repository's lint rule against synchronous `setState` calls in an effect body
// (cascading renders). `useSyncExternalStore`'s `getServerSnapshot` gives React the correct
// "not dismissed" value for the server/first-paint render, and its subscription model is the
// intended way to read a value that can legitimately differ between server and client.
// `sessionStorage` itself is same-tab, so a plain module-level listener set - not a real
// `storage` event, which only fires for OTHER tabs/windows - is enough to notify this
// component after `dismiss()` writes the key.
let listeners: Array<() => void> = [];
function subscribe(onStoreChange: () => void): () => void {
  listeners = [...listeners, onStoreChange];
  return () => {
    listeners = listeners.filter((listener) => listener !== onStoreChange);
  };
}

function getSnapshot(): boolean {
  try {
    return sessionStorage.getItem(DISMISS_SESSION_KEY) === "1";
  } catch {
    return false;
  }
}

function getServerSnapshot(): boolean {
  return false;
}

function dismiss(): void {
  try {
    sessionStorage.setItem(DISMISS_SESSION_KEY, "1");
  } catch {
    // Best-effort only (a private window or blocked site data): the banner still disappears
    // for the rest of this render, it just cannot be remembered for the next navigation.
  }
  for (const listener of listeners) listener();
}

/**
 * The dashboard's "please complete your company profile" banner (C2,
 * decisions/0021-extraction-direction-and-invoice-fields.md's onboarding scope) - only
 * rendered by the caller (`/dashboard`) when `isCompanyProfileIncomplete` is true AND the
 * caller has `companyProfileManage` (only the admin can act on it; showing it to a member
 * would just be noise they cannot resolve). Dismissible per session via `sessionStorage` -
 * never shared between viewers, never persisted across browser sessions or devices.
 */
export function CompanyProfileBanner() {
  const t = useTranslations("Inbox.companyProfileBanner");
  const dismissed = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  if (dismissed) return null;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted px-4 py-3 text-sm text-foreground">
      <p>{t("message")}</p>
      <div className="flex items-center gap-3">
        <Link href="/dashboard/settings/company" className="font-medium underline">
          {t("cta")}
        </Link>
        <button type="button" onClick={dismiss} className="text-muted-foreground underline">
          {t("dismiss")}
        </button>
      </div>
    </div>
  );
}
