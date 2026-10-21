"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import { Button } from "@/shared/ui-primitives";

import { AccountForm, type AccountFieldsView } from "./account-form";

/** The account detail page's "Bearbeiten" toggle - `AccountForm` in `edit` mode, same
 * show/hide convention as `CreateAccountSection`. */
export function EditAccountSection({ accountId, initial }: { accountId: string; initial: AccountFieldsView }) {
  const t = useTranslations("Finance");
  const [open, setOpen] = useState(false);
  const router = useRouter();

  if (!open) {
    return (
      <Button type="button" variant="outline" onClick={() => setOpen(true)}>
        {t("editAccount")}
      </Button>
    );
  }

  return (
    <div className="rounded-lg border border-border p-4">
      <h2 className="mb-3 text-sm font-semibold text-foreground">{t("editAccount")}</h2>
      <AccountForm
        mode="edit"
        accountId={accountId}
        initial={initial}
        onCancel={() => setOpen(false)}
        onSuccess={() => {
          setOpen(false);
          router.refresh();
        }}
      />
    </div>
  );
}
