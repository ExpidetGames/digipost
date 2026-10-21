"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";

import type { SettlementReportView } from "../core/view-types";

function formatAmount(cents: number | null, currency: string | null): string {
  if (cents === null) return "-";
  return new Intl.NumberFormat("de-DE", { style: "currency", currency: currency ?? "EUR" }).format(cents / 100);
}

function MatchCell({ line, t }: { line: SettlementReportView["lines"][number]; t: ReturnType<typeof useTranslations> }) {
  if (line.type !== "revenue") return <span className="text-xs text-muted-foreground">{t("matchNotApplicable")}</span>;
  if (!line.matchedDocumentId) return <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-xs text-destructive">{t("invoiceMissing")}</span>;
  return (
    <Link href={`/dashboard/documents/${line.matchedDocumentId}`} className="text-xs text-foreground underline">
      {line.matchStatus === "matched" ? t("matchLinked") : t("matchSuggested")}
      {line.matchedDocumentTitle ? ` · ${line.matchedDocumentTitle}` : ""}
    </Link>
  );
}

/**
 * `/dashboard/documents/[id]`'s settlement decomposition (F4, decisions/0026-platform-settlements.md):
 * revenue/fee/refund/payout totals plus every settlement line's own match status - "Rechnung
 * fehlt" for an unmatched revenue line, a link to the matched/suggested document otherwise.
 * Only ever rendered for a `finance.read` viewer (the page itself gates this, same as
 * `PaymentSection`) - every field here is already unredacted.
 */
export function SettlementReportSection({ report }: { report: SettlementReportView }) {
  const t = useTranslations("Payments.settlementReport");

  return (
    <div data-testid="settlement-report-section" className="flex flex-col gap-3 rounded-lg border border-border p-3">
      <h2 className="text-sm font-semibold text-foreground">{t("heading")}</h2>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
        <div className="flex flex-col">
          <dt className="text-xs text-muted-foreground">{t("gross")}</dt>
          <dd className="font-medium text-foreground">{formatAmount(report.decomposition.grossCents, "EUR")}</dd>
        </div>
        <div className="flex flex-col">
          <dt className="text-xs text-muted-foreground">{t("fees")}</dt>
          <dd className="font-medium text-foreground">{formatAmount(-report.decomposition.feeCents, "EUR")}</dd>
        </div>
        <div className="flex flex-col">
          <dt className="text-xs text-muted-foreground">{t("refunds")}</dt>
          <dd className="font-medium text-foreground">{formatAmount(-report.decomposition.refundCents, "EUR")}</dd>
        </div>
        <div className="flex flex-col">
          <dt className="text-xs text-muted-foreground">{t("payout")}</dt>
          <dd className="font-medium text-foreground">{formatAmount(report.decomposition.expectedNetCents, "EUR")}</dd>
        </div>
      </dl>

      {!report.decomposition.balanced ? (
        <p role="alert" className="rounded-lg border border-dashed border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {t("discrepancy", { amount: formatAmount(report.decomposition.discrepancyCents, "EUR") })}
        </p>
      ) : null}

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2">{t("columns.type")}</th>
              <th className="px-3 py-2">{t("columns.bookingDate")}</th>
              <th className="px-3 py-2">{t("columns.customer")}</th>
              <th className="px-3 py-2 text-right">{t("columns.amount")}</th>
              <th className="px-3 py-2">{t("columns.match")}</th>
            </tr>
          </thead>
          <tbody>
            {report.lines.map((line) => (
              <tr key={line.id} className="border-t border-border">
                <td className="px-3 py-2 text-foreground">{t(`lineTypes.${line.type}`)}</td>
                <td className="px-3 py-2 text-foreground">{line.bookingDate ?? "-"}</td>
                <td className="px-3 py-2 text-foreground">{line.customerName ?? "-"}</td>
                <td className="px-3 py-2 text-right font-medium text-foreground">{formatAmount(line.grossCents ?? line.netCents, "EUR")}</td>
                <td className="px-3 py-2">
                  <MatchCell line={line} t={t} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
