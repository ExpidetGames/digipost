"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";

import { Button } from "@/shared/ui-primitives";

import { revokeInvitationAction } from "../actions";
import type { PendingInvitationListItem } from "../core/types";
import type { WorkspaceActionErrorCode } from "../core/error-codes";

export function InvitationItem({
  invitation,
  canManageMembers,
  onRevoked,
}: {
  invitation: PendingInvitationListItem;
  canManageMembers: boolean;
  onRevoked: (id: string) => void;
}) {
  const t = useTranslations("Team.invitations");
  const tErrors = useTranslations("Team.errors");
  const [errorCode, setErrorCode] = useState<WorkspaceActionErrorCode>();
  const [pending, startTransition] = useTransition();

  const formattedDate = new Intl.DateTimeFormat("de", { dateStyle: "medium" }).format(new Date(invitation.expiresAt));

  function handleRevoke() {
    setErrorCode(undefined);
    startTransition(async () => {
      const result = await revokeInvitationAction({ invitationId: invitation.id });
      if (result.status === "error") {
        setErrorCode(result.errorCode);
        return;
      }
      onRevoked(invitation.id);
    });
  }

  return (
    <li className="flex flex-col gap-2 rounded-lg border border-border p-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="font-medium text-foreground">{invitation.email}</p>
          <p className="text-sm text-muted-foreground">{t("expiresAt", { date: formattedDate })}</p>
        </div>
        {canManageMembers ? (
          <Button type="button" variant="outline" size="sm" disabled={pending} aria-busy={pending} onClick={handleRevoke}>
            {t("revoke")}
          </Button>
        ) : null}
      </div>
      {errorCode ? (
        <p role="alert" className="text-sm text-destructive">
          {tErrors(errorCode)}
        </p>
      ) : null}
    </li>
  );
}
