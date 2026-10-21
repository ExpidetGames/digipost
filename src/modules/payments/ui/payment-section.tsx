"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import { Button } from "@/shared/ui-primitives";

import {
  confirmSuggestionAction,
  linkManuallyAction,
  markSettledWithoutPaymentAction,
  rejectSuggestionAction,
  unlinkTransactionAction,
} from "../actions";
import type { PaymentActionErrorCode } from "../core/error-codes";
import type { DocumentPaymentSection } from "../core/view-types";

export type ManualLinkCandidate = {
  transactionId: string;
  bookingDate: string;
  amountCents: number;
  currency: string | null;
  counterpartyName: string | null;
  remittanceText: string | null;
};

function formatAmount(cents: number, currency: string | null): string {
  return new Intl.NumberFormat("de-DE", { style: "currency", currency: currency ?? "EUR" }).format(cents / 100);
}

const NO_ACTION_STATUSES = new Set(["paid", "settled", "no_document_needed", "not_applicable"]);

/**
 * `/dashboard/documents/[id]`'s payment section (F3b, decisions/0025-payment-matching-wiring.md):
 * status/paid-date/reminder-callout/duplicate-warning are visible to every member; matched
 * transactions with amount+counterparty, suggestions, and every mutating action other than
 * "ohne Zahlung erledigt" only render at all when `canManage` (`finance.manage`) - the SERVER
 * read-model (`server/read-models.ts`) already omitted that data entirely for a member, this
 * component's `canManage` check is a second, redundant guard against ever showing an empty
 * `suggestions`/redacted `matchedTransactions` array as if it meant something.
 */
export function PaymentSection({
  documentId,
  section,
  canManage,
  manualLinkCandidates,
}: {
  documentId: string;
  section: DocumentPaymentSection;
  canManage: boolean;
  manualLinkCandidates?: ManualLinkCandidate[];
}) {
  const t = useTranslations("Payments");
  const router = useRouter();
  const [error, setError] = useState<PaymentActionErrorCode>();
  const [pending, startTransition] = useTransition();
  const [manualLinkOpen, setManualLinkOpen] = useState(false);
  const [manualLinkQuery, setManualLinkQuery] = useState("");
  const [confirmingSettle, setConfirmingSettle] = useState(false);

  const formattedPaidAt = section.paidAt ? new Intl.DateTimeFormat("de", { dateStyle: "medium" }).format(new Date(section.paidAt)) : null;
  const formattedReminderPaidAt = section.reminderAlreadyPaidAt
    ? new Intl.DateTimeFormat("de", { dateStyle: "medium" }).format(new Date(section.reminderAlreadyPaidAt))
    : null;

  function runAction(action: () => Promise<{ status: "success"; data: void } | { status: "error"; errorCode: PaymentActionErrorCode }>) {
    setError(undefined);
    startTransition(async () => {
      const result = await action();
      if (result.status === "error") setError(result.errorCode);
      router.refresh();
    });
  }

  const filteredCandidates = (manualLinkCandidates ?? []).filter((c) => {
    if (!manualLinkQuery.trim()) return true;
    const needle = manualLinkQuery.trim().toLowerCase();
    return (
      (c.counterpartyName ?? "").toLowerCase().includes(needle) ||
      (c.remittanceText ?? "").toLowerCase().includes(needle) ||
      formatAmount(c.amountCents, c.currency).toLowerCase().includes(needle)
    );
  });

  return (
    <div data-testid="payment-section" className="flex flex-col gap-3 rounded-lg border border-border p-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-foreground">{t("sectionHeading")}</h2>
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-foreground">{t(`statusValues.${section.paymentStatus}`)}</span>
      </div>

      {formattedPaidAt ? <p className="text-sm text-muted-foreground">{t("paidAt", { date: formattedPaidAt })}</p> : null}

      {formattedReminderPaidAt ? (
        <p role="status" className="rounded-lg border border-dashed border-border bg-muted px-3 py-2 text-sm text-foreground">
          {t("reminderAlreadyPaid", { date: formattedReminderPaidAt })}
        </p>
      ) : null}

      {section.possibleDuplicatePayment ? (
        <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {t("duplicateWarning")}
        </p>
      ) : null}

      {section.matchedTransactions.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold text-muted-foreground">{t("matchedHeading")}</h3>
          <ul className="flex flex-col gap-1">
            {section.matchedTransactions.map((tx) => {
              const formattedDate = new Intl.DateTimeFormat("de", { dateStyle: "medium" }).format(new Date(tx.bookingDate));
              return (
                <li key={tx.documentTransactionId} className="flex items-center justify-between gap-2 text-sm">
                  <span className="text-foreground">
                    {tx.amountCents !== undefined ? `${formatAmount(tx.amountCents, tx.currency ?? null)} · ${tx.counterpartyName ?? "–"} · ` : ""}
                    {t("matchedDateOnly", { date: formattedDate })}
                  </span>
                  {canManage ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={pending}
                      onClick={() => runAction(() => unlinkTransactionAction({ documentTransactionId: tx.documentTransactionId }))}
                    >
                      {t("unlink")}
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {canManage && section.suggestions.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold text-muted-foreground">{t("suggestionsHeading")}</h3>
          <ul className="flex flex-col gap-2">
            {section.suggestions.map((suggestion) => {
              const formattedDate = new Intl.DateTimeFormat("de", { dateStyle: "medium" }).format(new Date(suggestion.bookingDate));
              return (
                <li key={suggestion.documentTransactionId} className="flex flex-col gap-1 rounded-lg border border-border p-2 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-foreground">
                      {formatAmount(suggestion.amountCents, suggestion.currency)} · {suggestion.counterpartyName ?? "–"} · {formattedDate}
                    </span>
                    <div className="flex gap-2">
                      <Button
                        type="button"
                        size="sm"
                        disabled={pending}
                        onClick={() => runAction(() => confirmSuggestionAction({ documentTransactionId: suggestion.documentTransactionId }))}
                      >
                        {t("confirm")}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={pending}
                        onClick={() => runAction(() => rejectSuggestionAction({ documentTransactionId: suggestion.documentTransactionId }))}
                      >
                        {t("reject")}
                      </Button>
                    </div>
                  </div>
                  {suggestion.explanation ? <p className="text-muted-foreground">{suggestion.explanation}</p> : null}
                  <ul className="flex flex-wrap gap-1">
                    {suggestion.reasons.map((reason) => (
                      <li key={reason} className="rounded-full bg-muted px-2 py-0.5 text-xs text-foreground">
                        {t(`reasonValues.${reason}`)}
                      </li>
                    ))}
                  </ul>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {canManage && manualLinkCandidates ? (
        <div className="flex flex-col gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => setManualLinkOpen((open) => !open)}>
            {t("manualLink.toggle")}
          </Button>
          {manualLinkOpen ? (
            <div className="flex flex-col gap-2 rounded-lg border border-border p-2">
              <input
                value={manualLinkQuery}
                onChange={(e) => setManualLinkQuery(e.target.value)}
                placeholder={t("manualLink.searchPlaceholder")}
                aria-label={t("manualLink.searchLabel")}
                className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none dark:bg-input/30"
              />
              {filteredCandidates.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t("manualLink.empty")}</p>
              ) : (
                <ul className="flex max-h-48 flex-col gap-1 overflow-y-auto">
                  {filteredCandidates.map((c) => (
                    <li key={c.transactionId} className="flex items-center justify-between gap-2 text-sm">
                      <span className="text-foreground">
                        {c.bookingDate} · {formatAmount(c.amountCents, c.currency)} · {c.counterpartyName ?? "–"}
                      </span>
                      <Button
                        type="button"
                        size="sm"
                        disabled={pending}
                        onClick={() =>
                          runAction(() => {
                            setManualLinkOpen(false);
                            return linkManuallyAction({ documentId, transactionId: c.transactionId });
                          })
                        }
                      >
                        {t("manualLink.link")}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}
        </div>
      ) : null}

      {!NO_ACTION_STATUSES.has(section.paymentStatus) ? (
        <div className="flex flex-col gap-2">
          {confirmingSettle ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-muted-foreground">{t("markSettledConfirm")}</span>
              <Button
                type="button"
                size="sm"
                disabled={pending}
                onClick={() => {
                  setConfirmingSettle(false);
                  runAction(() => markSettledWithoutPaymentAction({ documentId }));
                }}
              >
                {t("markSettledYes")}
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={() => setConfirmingSettle(false)}>
                {t("cancel")}
              </Button>
            </div>
          ) : (
            <Button type="button" variant="outline" size="sm" onClick={() => setConfirmingSettle(true)}>
              {t("markSettled")}
            </Button>
          )}
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {t(`errors.${error}`)}
        </p>
      ) : null}
    </div>
  );
}
