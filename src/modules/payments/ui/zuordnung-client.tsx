"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import type { SettlementPlatform } from "@/modules/intake";
import { Button } from "@/shared/ui-primitives";

import { confirmSuggestionAction, markNoDocumentNeededAction, rejectSuggestionAction } from "../actions";
import type { PaymentActionErrorCode } from "../core/error-codes";
import type { UnmatchedTransactionView } from "../core/view-types";

function formatAmount(cents: number, currency: string | null): string {
  return new Intl.NumberFormat("de-DE", { style: "currency", currency: currency ?? "EUR" }).format(cents / 100);
}

/** The "keine Vorschläge" cell's own two shapes (F4, decisions/0026-platform-settlements.md):
 * a plain empty state, or - when this transaction looks like an unmatched platform payout - a
 * hint to upload the settlement report instead of the generic "kein Vorschlag" text. Split out
 * as its own component (not a nested ternary inline) per this codebase's lint rule. */
function EmptySuggestionsHint({
  platformPayoutHint,
  t,
  tPlatforms,
}: {
  platformPayoutHint: SettlementPlatform | null;
  t: ReturnType<typeof useTranslations>;
  tPlatforms: ReturnType<typeof useTranslations>;
}) {
  if (platformPayoutHint) {
    return <span className="text-xs text-muted-foreground">{t("platformPayoutHint", { platform: tPlatforms(platformPayoutHint) })}</span>;
  }
  return <span className="text-xs text-muted-foreground">{t("noSuggestions")}</span>;
}

/** `/dashboard/finance/zuordnung` (F3b, decisions/0025-payment-matching-wiring.md): every
 * unmatched transaction with its own top suggestions inline, plus bulk "kein Beleg nötig"
 * (single and, via the checkbox, "für diese Gegenpartei immer"). Admin-only page
 * (`finance.manage`), so every field here is already unredacted by the server read-model. */
export function ZuordnungClient({ transactions }: { transactions: UnmatchedTransactionView[] }) {
  const t = useTranslations("Payments.zuordnung");
  const tPayments = useTranslations("Payments");
  const tReasons = useTranslations("Payments.reasonValues");
  const tPlatforms = useTranslations("SettlementPlatforms");
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [forCounterparty, setForCounterparty] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<PaymentActionErrorCode>();

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function runAction(action: () => Promise<{ status: "success"; data: void } | { status: "error"; errorCode: PaymentActionErrorCode }>) {
    setError(undefined);
    startTransition(async () => {
      const result = await action();
      if (result.status === "error") setError(result.errorCode);
      router.refresh();
    });
  }

  function handleBulkNoDocumentNeeded() {
    if (selected.size === 0) return;
    runAction(async () => {
      const result = await markNoDocumentNeededAction({ transactionIds: [...selected], forCounterparty });
      if (result.status === "success") {
        setSelected(new Set());
        setForCounterparty(false);
      }
      return result;
    });
  }

  return (
    <div className="flex flex-col gap-4">
      {transactions.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("emptyState")}</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed border-border p-3">
            <label className="flex items-center gap-2 text-sm text-foreground">
              <input type="checkbox" checked={forCounterparty} onChange={(e) => setForCounterparty(e.target.checked)} />
              {t("forCounterpartyAlways")}
            </label>
            <Button type="button" size="sm" disabled={pending || selected.size === 0} onClick={handleBulkNoDocumentNeeded}>
              {t("bulkNoDocumentNeeded")} ({selected.size})
            </Button>
          </div>

          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2" />
                  <th className="px-3 py-2">{t("columns.bookingDate")}</th>
                  <th className="px-3 py-2">{t("columns.counterparty")}</th>
                  <th className="px-3 py-2 text-right">{t("columns.amount")}</th>
                  <th className="px-3 py-2">{t("columns.remittanceText")}</th>
                  <th className="px-3 py-2">{t("columns.suggestions")}</th>
                </tr>
              </thead>
              <tbody>
                {transactions.map((tx) => (
                  <tr key={tx.transactionId} className="border-t border-border align-top">
                    <td className="px-3 py-2">
                      <input type="checkbox" checked={selected.has(tx.transactionId)} onChange={() => toggle(tx.transactionId)} />
                    </td>
                    <td className="px-3 py-2 text-foreground">{tx.bookingDate}</td>
                    <td className="px-3 py-2 text-foreground">{tx.counterpartyName ?? "–"}</td>
                    <td className="px-3 py-2 text-right font-medium text-foreground">{formatAmount(tx.amountCents, tx.currency)}</td>
                    <td className="px-3 py-2 text-muted-foreground">{tx.remittanceText ?? "–"}</td>
                    <td className="px-3 py-2">
                      {tx.possibleDuplicatePayment ? <p className="mb-1 text-xs text-destructive">{t("duplicateWarning")}</p> : null}
                      {tx.suggestions.length === 0 ? (
                        <EmptySuggestionsHint platformPayoutHint={tx.platformPayoutHint} t={t} tPlatforms={tPlatforms} />
                      ) : (
                        <ul className="flex flex-col gap-1">
                          {tx.suggestions.map((s) => (
                            <li key={s.documentTransactionId} className="flex flex-col gap-1 rounded-lg border border-border p-2">
                              <span className="text-xs text-foreground">
                                {s.documentTitle ?? s.documentInvoiceNumber ?? s.documentId} ({Math.round(s.confidence * 100)}%)
                              </span>
                              <ul className="flex flex-wrap gap-1">
                                {s.reasons.map((reason) => (
                                  <li key={reason} className="rounded-full bg-muted px-2 py-0.5 text-xs text-foreground">
                                    {tReasons(reason)}
                                  </li>
                                ))}
                              </ul>
                              <div className="flex gap-2">
                                <Button
                                  type="button"
                                  size="sm"
                                  disabled={pending}
                                  onClick={() => runAction(() => confirmSuggestionAction({ documentTransactionId: s.documentTransactionId }))}
                                >
                                  {tPayments("confirm")}
                                </Button>
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  disabled={pending}
                                  onClick={() => runAction(() => rejectSuggestionAction({ documentTransactionId: s.documentTransactionId }))}
                                >
                                  {tPayments("reject")}
                                </Button>
                              </div>
                            </li>
                          ))}
                        </ul>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {tPayments(`errors.${error}`)}
        </p>
      ) : null}
    </div>
  );
}
