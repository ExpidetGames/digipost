"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";

import { Button } from "@/shared/ui-primitives";

import { importFromDocumentAction } from "../actions";
import type { AccountActionErrorCode } from "../core/error-codes";

export type PendingAccountDocumentView = { id: string; originalFileName: string };
export type SelectableAccountView = { id: string; name: string };

const CONTROL_CLASSES =
  "h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none dark:bg-input/30";

/**
 * "Konto zuordnen" (F2's scope item 2, "pending_account state on the document with a small
 * UI"): a confirmed bank-statement document whose statement carries no own-account IBAN
 * (every tabular/CSV source) has nothing to auto-resolve against - a human picks an existing
 * account here. Creating a brand NEW account for one of these documents is a separate step
 * (the "Konto anlegen" section above, which lists every current account here once created) -
 * a deliberate two-step flow kept simple over a combined create-and-import form.
 */
export function PendingAccountsSection({ documents, accounts }: { documents: PendingAccountDocumentView[]; accounts: SelectableAccountView[] }) {
  const t = useTranslations("Finance");
  const router = useRouter();
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [errorByDocument, setErrorByDocument] = useState<Record<string, AccountActionErrorCode>>({});
  const [pendingId, setPendingId] = useState<string>();
  const [, startTransition] = useTransition();

  if (documents.length === 0) return null;

  function handleAssign(documentId: string) {
    const accountId = selected[documentId];
    if (!accountId) return;
    setPendingId(documentId);
    startTransition(async () => {
      const result = await importFromDocumentAction({ documentId, accountId });
      if (result.status === "error") {
        setErrorByDocument((current) => ({ ...current, [documentId]: result.errorCode }));
      }
      setPendingId(undefined);
      router.refresh();
    });
  }

  return (
    <section className="flex flex-col gap-2 rounded-lg border border-border bg-muted/40 p-3">
      <h2 className="text-sm font-semibold text-foreground">{t("pendingAccountsHeading", { count: documents.length })}</h2>
      <p className="text-sm text-muted-foreground">{t("pendingAccountsDescription")}</p>
      <ul className="flex flex-col gap-2">
        {documents.map((doc) => (
          <li key={doc.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-background p-2">
            <span className="text-sm text-foreground">{doc.originalFileName}</span>
            <select
              className={CONTROL_CLASSES}
              value={selected[doc.id] ?? ""}
              onChange={(event) => setSelected((current) => ({ ...current, [doc.id]: event.target.value }))}
            >
              <option value="">{t("selectAccountPlaceholder")}</option>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name}
                </option>
              ))}
            </select>
            <Button type="button" size="sm" disabled={!selected[doc.id] || pendingId === doc.id} onClick={() => handleAssign(doc.id)}>
              {t("assignAccount")}
            </Button>
            {errorByDocument[doc.id] ? <span className="text-sm text-destructive">{t(`form.errors.${errorByDocument[doc.id]}`)}</span> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
