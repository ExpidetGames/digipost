"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import { Button, Input, Label } from "@/shared/ui-primitives";

import { createContactClearingAccountAction } from "../actions";
import type { AccountActionErrorCode } from "../core/error-codes";

export type ContactClearingAccountView = { id: string; name: string };

/**
 * "Verrechnungskonto" on `/dashboard/contacts/[id]` (decisions/0068-supplier-clearing-accounts.md):
 * for a supplier whose invoices and bank charges can never pair one to one. Reading is
 * `finance.read` (the page decides whether to render this at all), creating is
 * `finance.manage` - admin-only, like every other finance mutation.
 *
 * The optional payment-name field is what makes the charges findable at all: a supplier
 * settled through a clearing account never produces a confirmed match, so the name its card
 * debits carry ("FACEBK") can never be learned the ordinary way (decisions/0047).
 */
export function ContactClearingAccountSection({
  contactId,
  account,
  canManage,
}: {
  contactId: string;
  account: ContactClearingAccountView | null;
  canManage: boolean;
}) {
  const t = useTranslations("Finance.contactClearing");
  const tErrors = useTranslations("Finance.form.errors");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [paymentName, setPaymentName] = useState("");
  const [errorCode, setErrorCode] = useState<AccountActionErrorCode>();
  const [isPending, startTransition] = useTransition();

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorCode(undefined);
    startTransition(async () => {
      const result = await createContactClearingAccountAction({ contactId, paymentName: paymentName.trim() || undefined });
      if (result.status === "error") {
        setErrorCode(result.errorCode);
        return;
      }
      setOpen(false);
      router.push(`/dashboard/finance/${result.data.accountId}`);
    });
  }

  return (
    <section className="flex flex-col gap-2 rounded-md border border-border p-4">
      <h2 className="text-sm font-medium text-foreground">{t("heading")}</h2>
      {account ? (
        <>
          <p className="text-sm text-muted-foreground">{t("existsDescription")}</p>
          <Link href={`/dashboard/finance/${account.id}`} className="text-sm text-foreground underline">
            {account.name}
          </Link>
        </>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">{t("description")}</p>
          {canManage && !open ? (
            <div>
              <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
                {t("create")}
              </Button>
            </div>
          ) : null}
          {canManage && open ? (
            <form onSubmit={handleSubmit} className="flex flex-col gap-3">
              <div className="flex flex-col gap-1">
                <Label htmlFor="clearing-payment-name">{t("paymentNameLabel")}</Label>
                <Input
                  id="clearing-payment-name"
                  value={paymentName}
                  onChange={(event) => setPaymentName(event.target.value)}
                  placeholder={t("paymentNamePlaceholder")}
                />
                <p className="text-xs text-muted-foreground">{t("paymentNameHint")}</p>
              </div>
              <div className="flex gap-2">
                <Button type="submit" size="sm" disabled={isPending}>
                  {t("create")}
                </Button>
                <Button type="button" variant="outline" size="sm" disabled={isPending} onClick={() => setOpen(false)}>
                  {t("cancel")}
                </Button>
              </div>
              {errorCode ? (
                <p role="alert" className="text-sm text-destructive">
                  {tErrors(errorCode)}
                </p>
              ) : null}
            </form>
          ) : null}
        </>
      )}
    </section>
  );
}
