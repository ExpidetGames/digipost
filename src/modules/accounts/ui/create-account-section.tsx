"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import { Button } from "@/shared/ui-primitives";

import { AccountForm } from "./account-form";

/** The `/dashboard/finance` overview page's "Konto anlegen" toggle - same pattern as
 * `@/modules/contacts`'s `CreateContactSection`. */
export function CreateAccountSection() {
  const t = useTranslations("Finance");
  const [open, setOpen] = useState(false);
  const router = useRouter();

  if (!open) {
    return (
      <Button type="button" onClick={() => setOpen(true)}>
        {t("createAccount")}
      </Button>
    );
  }

  return (
    <div className="rounded-lg border border-border p-4">
      <h2 className="mb-3 text-sm font-semibold text-foreground">{t("createAccountHeading")}</h2>
      <AccountForm
        mode="create"
        onCancel={() => setOpen(false)}
        onSuccess={(id) => {
          setOpen(false);
          router.push(`/dashboard/finance/${id}`);
        }}
      />
    </div>
  );
}
