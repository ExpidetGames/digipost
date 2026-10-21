"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";

import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label } from "@/shared/ui-primitives";

import { deleteWorkspaceAction } from "../actions";
import type { WorkspaceActionErrorCode } from "../core/error-codes";

/**
 * `/dashboard/settings/company`'s danger zone (F5, decisions/0027-hardening-and-deletion.md):
 * admin-only (the page itself already gates the whole route, `workspaceManage` mirrors that
 * same admin-only shape one level down since this is the single most destructive action in
 * the product). A typed confirmation (re-type the exact workspace name) before the button
 * that actually deletes becomes enabled - the same "type the name to confirm" pattern this
 * kind of irreversible action commonly uses, re-checked server-side regardless
 * (`deleteWorkspaceAction` never trusts this client-side comparison alone). On success the
 * action itself redirects to `/onboarding`, so there is no local "done" state to render here.
 */
export function WorkspaceDangerZone({ workspaceName }: { workspaceName: string }) {
  const t = useTranslations("CompanySettings.dangerZone");
  const [expanded, setExpanded] = useState(false);
  const [confirmName, setConfirmName] = useState("");
  const [errorCode, setErrorCode] = useState<WorkspaceActionErrorCode>();
  const [pending, startTransition] = useTransition();

  const nameMatches = confirmName.trim() === workspaceName.trim() && confirmName.trim().length > 0;

  function handleDelete() {
    setErrorCode(undefined);
    startTransition(async () => {
      const result = await deleteWorkspaceAction({ confirmName });
      // A successful call redirects (throws) inside the action itself; reaching here at all
      // means it returned an error.
      if (result.status === "error") setErrorCode(result.errorCode);
    });
  }

  return (
    <Card className="border-destructive/50">
      <CardHeader>
        <CardTitle className="text-destructive">{t("heading")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {expanded ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              {t("confirmPrompt")} <strong className="text-foreground">{workspaceName}</strong>
            </p>
            <div className="flex max-w-sm flex-col gap-2">
              <Label htmlFor="delete-workspace-confirm">{t("confirmLabel")}</Label>
              <Input
                id="delete-workspace-confirm"
                value={confirmName}
                onChange={(event) => setConfirmName(event.target.value)}
                autoComplete="off"
              />
            </div>
            {errorCode ? (
              <p role="alert" className="text-sm text-destructive">
                {t(`errors.${errorCode}`)}
              </p>
            ) : null}
            <div className="flex gap-2">
              <Button type="button" variant="destructive" disabled={!nameMatches || pending} aria-busy={pending} onClick={handleDelete}>
                {pending ? t("submitPending") : t("submit")}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() => {
                  setExpanded(false);
                  setConfirmName("");
                  setErrorCode(undefined);
                }}
              >
                {t("cancel")}
              </Button>
            </div>
          </div>
        ) : (
          <Button type="button" variant="destructive" className="self-start" onClick={() => setExpanded(true)}>
            {t("start")}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
