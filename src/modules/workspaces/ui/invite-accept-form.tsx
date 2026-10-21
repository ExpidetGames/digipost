"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import { Button } from "@/shared/ui-primitives";

import { acceptInvitationAction } from "../actions";
import type { WorkspaceActionErrorCode } from "../core/error-codes";

/** The `/invite/[token]` page's accept button. Only rendered once the preview succeeded
 * (`src/app/(onboarding)/invite/[token]/page.tsx`), so the only errors this can surface are
 * ones that changed between the preview read and the accept write (the invitation was
 * revoked or expired in the meantime, or the signed-in user already joined a workspace in
 * another tab). */
export function InviteAcceptForm({ token }: { token: string }) {
  const t = useTranslations("Invite");
  const router = useRouter();
  const [errorCode, setErrorCode] = useState<WorkspaceActionErrorCode>();
  const [pending, startTransition] = useTransition();

  function handleAccept() {
    setErrorCode(undefined);
    startTransition(async () => {
      const result = await acceptInvitationAction({ token });
      if (result.status === "error") {
        setErrorCode(result.errorCode);
        return;
      }
      router.push("/dashboard");
    });
  }

  return (
    <div className="flex flex-col gap-4">
      {errorCode ? (
        <p role="alert" className="text-sm text-destructive">
          {t(`errors.${errorCode}`)}
        </p>
      ) : null}
      <Button type="button" onClick={handleAccept} disabled={pending} aria-busy={pending}>
        {pending ? t("acceptPending") : t("accept")}
      </Button>
    </div>
  );
}
