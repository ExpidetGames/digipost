"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import { setPaymentAutoConfirmAction } from "../actions";
import { PAYMENT_AUTO_CONFIRM_MODES, type PaymentAutoConfirmMode } from "../core/auto-confirm";
import type { PaymentActionErrorCode } from "../core/error-codes";

/** decisions/0044: the admin's choice of which payment suggestions are confirmed without a
 * human. Saves on change; the server schedules a matching run so the choice also applies to the
 * suggestions already open. */
export function AutoConfirmModeSelect({ mode, canManage }: { mode: PaymentAutoConfirmMode; canManage: boolean }) {
  const t = useTranslations("Payments.autoConfirm");
  const tErrors = useTranslations("Payments.errors");
  const router = useRouter();
  const [current, setCurrent] = useState<PaymentAutoConfirmMode>(mode);
  const [errorCode, setErrorCode] = useState<PaymentActionErrorCode | null>(null);
  const [pending, startTransition] = useTransition();

  const choose = (next: PaymentAutoConfirmMode) => {
    if (next === current || !canManage) return;
    const previous = current;
    setCurrent(next);
    setErrorCode(null);
    startTransition(async () => {
      const result = await setPaymentAutoConfirmAction({ mode: next });
      if (result.status === "error") {
        setCurrent(previous);
        setErrorCode(result.errorCode);
        return;
      }
      router.refresh();
    });
  };

  return (
    <fieldset className="flex flex-col gap-2 rounded-md border border-border p-4" disabled={!canManage || pending}>
      <legend className="px-1 text-sm font-medium text-foreground">{t("heading")}</legend>
      <p className="text-sm text-muted-foreground">{t("description")}</p>
      {PAYMENT_AUTO_CONFIRM_MODES.map((option) => (
        <label key={option} className="flex cursor-pointer items-start gap-2 text-sm">
          <input type="radio" name="payment-auto-confirm" value={option} checked={current === option} onChange={() => choose(option)} className="mt-1" />
          <span>
            <span className="font-medium text-foreground">{t(`modes.${option}.label`)}</span>
            <span className="block text-muted-foreground">{t(`modes.${option}.hint`)}</span>
          </span>
        </label>
      ))}
      {errorCode ? (
        <p role="alert" className="text-sm text-destructive">
          {tErrors(errorCode)}
        </p>
      ) : null}
    </fieldset>
  );
}
