"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";

import { Button } from "@/shared/ui-primitives";

import { leaveWorkspaceAction } from "../actions";
import type { WorkspaceActionErrorCode } from "../core/error-codes";

/**
 * "Arbeitsbereich verlassen" (F5, decisions/0027-hardening-and-deletion.md): rendered on
 * `/dashboard/team` for a non-admin member only (the page passes `isAdmin`, the use case
 * itself also rejects an admin with `cannot_leave_as_admin` - defense in depth, same shape
 * the danger zone/member-removal controls already use). A successful call redirects to
 * `/onboarding` inside the action itself, so there is no local "done" state to render.
 */
export function LeaveWorkspaceButton() {
  const t = useTranslations("Team.leaveWorkspace");
  const tErrors = useTranslations("Team.errors");
  const [confirming, setConfirming] = useState(false);
  const [errorCode, setErrorCode] = useState<WorkspaceActionErrorCode>();
  const [pending, startTransition] = useTransition();

  function confirmLeave() {
    setErrorCode(undefined);
    startTransition(async () => {
      const result = await leaveWorkspaceAction();
      if (result.status === "error") {
        setErrorCode(result.errorCode);
        setConfirming(false);
      }
    });
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
      {confirming ? (
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">{t("confirm")}</span>
          <Button type="button" variant="destructive" size="sm" disabled={pending} aria-busy={pending} onClick={confirmLeave}>
            {t("confirmYes")}
          </Button>
          <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => setConfirming(false)}>
            {t("cancel")}
          </Button>
        </div>
      ) : (
        <Button type="button" variant="destructive" size="sm" className="self-start" onClick={() => setConfirming(true)}>
          {t("start")}
        </Button>
      )}
      {errorCode ? (
        <p role="alert" className="text-sm text-destructive">
          {tErrors(errorCode)}
        </p>
      ) : null}
    </div>
  );
}
