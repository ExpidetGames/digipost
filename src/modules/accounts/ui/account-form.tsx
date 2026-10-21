"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";

import { Button, Input, Label } from "@/shared/ui-primitives";

import { createAccountAction, updateAccountAction } from "../actions";
import type { AccountActionErrorCode } from "../core/error-codes";

export type AccountFieldsView = {
  type: "bank" | "clearing";
  name: string;
  iban: string;
  bic: string;
  currency: string;
  holder: string;
  platform: string;
};

export const EMPTY_ACCOUNT_FIELDS: AccountFieldsView = {
  type: "bank",
  name: "",
  iban: "",
  bic: "",
  currency: "EUR",
  holder: "",
  platform: "",
};

const CONTROL_CLASSES =
  "h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30";

/**
 * Manual account create/edit form (F2's scope item 3: "manual account creation/edit"). Only
 * `name`/`type` are required - `iban` is validated (mod-97 checksum) when given, matching
 * `manualAccountCreateSchema`/`manualAccountUpdateSchema` (`@/modules/accounts`).
 */
export function AccountForm({
  mode,
  accountId,
  initial = EMPTY_ACCOUNT_FIELDS,
  onCancel,
  onSuccess,
}: {
  mode: "create" | "edit";
  accountId?: string;
  initial?: AccountFieldsView;
  onCancel: () => void;
  onSuccess: (accountId: string) => void;
}) {
  const t = useTranslations("Finance.form");
  const [fields, setFields] = useState<AccountFieldsView>(initial);
  const [errorCode, setErrorCode] = useState<AccountActionErrorCode>();
  const [isPending, startTransition] = useTransition();

  function set<K extends keyof AccountFieldsView>(key: K, value: AccountFieldsView[K]) {
    setFields((current) => ({ ...current, [key]: value }));
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorCode(undefined);
    startTransition(async () => {
      const payload = {
        type: fields.type,
        name: fields.name,
        iban: fields.iban || undefined,
        bic: fields.bic || undefined,
        currency: fields.currency || undefined,
        holder: fields.holder || undefined,
        platform: fields.platform || undefined,
      };
      const result =
        mode === "create" ? await createAccountAction(payload) : await updateAccountAction({ ...payload, accountId: accountId! });
      if (result.status === "error") {
        setErrorCode(result.errorCode);
        return;
      }
      onSuccess(result.data.accountId);
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor="account-type">{t("type")}</Label>
          <select
            id="account-type"
            className={CONTROL_CLASSES}
            value={fields.type}
            onChange={(event) => set("type", event.target.value as AccountFieldsView["type"])}
          >
            <option value="bank">{t("typeValues.bank")}</option>
            <option value="clearing">{t("typeValues.clearing")}</option>
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="account-name">{t("name")}</Label>
          <Input id="account-name" required maxLength={200} value={fields.name} onChange={(event) => set("name", event.target.value)} />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="account-iban">{t("iban")}</Label>
          <Input id="account-iban" maxLength={34} value={fields.iban} onChange={(event) => set("iban", event.target.value)} />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="account-bic">{t("bic")}</Label>
          <Input id="account-bic" maxLength={11} value={fields.bic} onChange={(event) => set("bic", event.target.value)} />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="account-currency">{t("currency")}</Label>
          <Input id="account-currency" maxLength={3} value={fields.currency} onChange={(event) => set("currency", event.target.value)} />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="account-holder">{t("holder")}</Label>
          <Input id="account-holder" maxLength={200} value={fields.holder} onChange={(event) => set("holder", event.target.value)} />
        </div>
        {fields.type === "clearing" ? (
          <div className="flex flex-col gap-1">
            <Label htmlFor="account-platform">{t("platform")}</Label>
            <Input id="account-platform" maxLength={60} value={fields.platform} onChange={(event) => set("platform", event.target.value)} />
          </div>
        ) : null}
      </div>

      {errorCode ? <p className="text-sm text-destructive">{t(`errors.${errorCode}`)}</p> : null}

      <div className="flex gap-2">
        <Button type="submit" disabled={isPending}>
          {t("submit")}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel} disabled={isPending}>
          {t("cancel")}
        </Button>
      </div>
    </form>
  );
}
