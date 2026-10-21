"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";

import { Button } from "@/shared/ui-primitives";

import { importFromDocumentAction } from "../actions";
import type { AccountActionErrorCode } from "../core/error-codes";

/** "Erneut importieren" (F2's scope: import is "re-runnable from the UI") - idempotent, so a
 * re-run against an already-fully-imported batch simply reports zero new rows. */
export function ReimportButton({ documentId, accountId }: { documentId: string; accountId: string }) {
  const t = useTranslations("Finance.detail");
  const router = useRouter();
  const [errorCode, setErrorCode] = useState<AccountActionErrorCode>();
  const [isPending, startTransition] = useTransition();

  function handleClick() {
    setErrorCode(undefined);
    startTransition(async () => {
      const result = await importFromDocumentAction({ documentId, accountId });
      if (result.status === "error") {
        setErrorCode(result.errorCode);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="flex items-center gap-2">
      <Button type="button" variant="outline" size="sm" disabled={isPending} onClick={handleClick}>
        {t("reimport")}
      </Button>
      {errorCode ? <span className="text-sm text-destructive">{t(`errors.${errorCode}`)}</span> : null}
    </div>
  );
}
