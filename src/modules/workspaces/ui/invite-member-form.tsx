"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";

import { Button, Input, Label } from "@/shared/ui-primitives";

import { inviteMemberAction } from "../actions";
import type { PendingInvitationListItem } from "../core/types";
import type { WorkspaceActionErrorCode } from "../core/error-codes";

export function InviteMemberForm({ onInvited }: { onInvited: (invitation: PendingInvitationListItem) => void }) {
  const t = useTranslations("Team");
  const [email, setEmail] = useState("");
  const [errorCode, setErrorCode] = useState<WorkspaceActionErrorCode>();
  const [pending, startTransition] = useTransition();

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorCode(undefined);
    startTransition(async () => {
      const result = await inviteMemberAction({ email });
      if (result.status === "error") {
        setErrorCode(result.errorCode);
        return;
      }
      setEmail("");
      onInvited(result.data);
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-2">
      <div className="flex flex-col items-end gap-2 sm:flex-row">
        <div className="flex w-full flex-1 flex-col gap-2">
          <Label htmlFor="invite-email">{t("inviteForm.emailLabel")}</Label>
          <Input
            id="invite-email"
            name="email"
            type="email"
            required
            placeholder={t("inviteForm.emailPlaceholder")}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            aria-invalid={errorCode ? true : undefined}
          />
        </div>
        <Button type="submit" disabled={pending} aria-busy={pending}>
          {pending ? t("inviteForm.submitPending") : t("inviteForm.submit")}
        </Button>
      </div>
      {errorCode ? (
        <p role="alert" className="text-sm text-destructive">
          {t(`errors.${errorCode}`)}
        </p>
      ) : null}
    </form>
  );
}
