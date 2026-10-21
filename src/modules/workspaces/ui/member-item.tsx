"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";

import { Button } from "@/shared/ui-primitives";

import { removeMemberAction } from "../actions";
import type { WorkspaceMemberListItem } from "../core/types";
import type { WorkspaceActionErrorCode } from "../core/error-codes";

export function MemberItem({
  member,
  isSelf,
  canManageMembers,
  onRemoved,
}: {
  member: WorkspaceMemberListItem;
  isSelf: boolean;
  canManageMembers: boolean;
  onRemoved: (id: string) => void;
}) {
  const t = useTranslations("Team.members");
  const tErrors = useTranslations("Team.errors");
  const [confirming, setConfirming] = useState(false);
  const [errorCode, setErrorCode] = useState<WorkspaceActionErrorCode>();
  const [pending, startTransition] = useTransition();

  const formattedDate = new Intl.DateTimeFormat("de", { dateStyle: "medium" }).format(new Date(member.joinedAt));

  function confirmRemove() {
    setErrorCode(undefined);
    startTransition(async () => {
      const result = await removeMemberAction({ memberId: member.id });
      if (result.status === "error") {
        setErrorCode(result.errorCode);
        setConfirming(false);
        return;
      }
      onRemoved(member.id);
    });
  }

  let controls: React.ReactNode = null;
  if (canManageMembers && !isSelf) {
    controls = confirming ? (
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">{t("removeConfirm")}</span>
        <Button type="button" variant="destructive" size="sm" disabled={pending} aria-busy={pending} onClick={confirmRemove}>
          {t("removeConfirmYes")}
        </Button>
        <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => setConfirming(false)}>
          {t("cancel")}
        </Button>
      </div>
    ) : (
      <Button type="button" variant="destructive" size="sm" onClick={() => setConfirming(true)}>
        {t("remove")}
      </Button>
    );
  }

  return (
    <li className="flex flex-col gap-2 rounded-lg border border-border p-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="font-medium text-foreground">
            {member.name}
            {isSelf ? ` (${t("you")})` : ""}
          </p>
          <p className="text-sm text-muted-foreground">{member.email}</p>
          <p className="text-sm text-muted-foreground">
            {member.role === "admin" ? t("roleAdmin") : t("roleMember")} · {t("joinedAt", { date: formattedDate })}
          </p>
        </div>
        {controls}
      </div>
      {errorCode ? (
        <p role="alert" className="text-sm text-destructive">
          {tErrors(errorCode)}
        </p>
      ) : null}
    </li>
  );
}
