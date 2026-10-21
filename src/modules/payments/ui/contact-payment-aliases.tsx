"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import { Button } from "@/shared/ui-primitives";

import { deletePaymentAliasAction } from "../actions";
import type { PaymentActionErrorCode } from "../core/error-codes";

/** decisions/0047: the counterparty names the system learned for this contact from confirmed
 * payments (e.g. "max mustermann" for Bauwerk Generalbau). Each one counts as a name match in
 * future matching; a wrong one can be removed here. Finance data, shown only with finance.read. */
export function ContactPaymentAliases({ aliases, canManage }: { aliases: Array<{ id: string; name: string }>; canManage: boolean }) {
  const t = useTranslations("Payments.contactAliases");
  const tErrors = useTranslations("Payments.errors");
  const router = useRouter();
  const [errorCode, setErrorCode] = useState<PaymentActionErrorCode | null>(null);
  const [pending, startTransition] = useTransition();

  const remove = (aliasId: string) => {
    setErrorCode(null);
    startTransition(async () => {
      const result = await deletePaymentAliasAction({ aliasId });
      if (result.status === "error") {
        setErrorCode(result.errorCode);
        return;
      }
      router.refresh();
    });
  };

  return (
    <section className="flex flex-col gap-2 rounded-md border border-border p-4">
      <h2 className="text-sm font-medium text-foreground">{t("heading")}</h2>
      <p className="text-sm text-muted-foreground">{t("description")}</p>
      {aliases.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {aliases.map((alias) => (
            <li key={alias.id} className="flex items-center justify-between gap-2 text-sm">
              <span className="font-mono text-foreground">{alias.name}</span>
              {canManage ? (
                <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => remove(alias.id)}>
                  {t("remove")}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {errorCode ? (
        <p role="alert" className="text-sm text-destructive">
          {tErrors(errorCode)}
        </p>
      ) : null}
    </section>
  );
}
