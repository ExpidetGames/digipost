import { notFound } from "next/navigation";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { PERMISSIONS } from "@/platform/access";
import { requireWorkspaceMember } from "@/platform/access/server";
import { listOpenItemsProjection } from "@/modules/payments/server";
import type { OpenItemView } from "@/modules/payments";
import { isDateRangeActive, readDateRange } from "@/shared/date-range";

function formatAmount(cents: number, currency: string): string {
  return new Intl.NumberFormat("de-DE", { style: "currency", currency }).format(cents / 100);
}

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** `2025-01-01` as `01.01.2025`, for the "Zeitraum: ... bis ..." note. The explicit midnight
 * keeps `new Date` from parsing the bare ISO date as UTC and rendering the previous day. */
const RANGE_BOUND_FORMATTER = new Intl.DateTimeFormat("de", { day: "2-digit", month: "2-digit", year: "numeric" });
function formatRangeBound(iso: string): string {
  return RANGE_BOUND_FORMATTER.format(new Date(`${iso}T00:00:00`));
}

/**
 * "Offene Posten" (F3b, decisions/0025-payment-matching-wiring.md): open and overdue invoices
 * sorted by due date, incoming (we owe) and outgoing (owed to us) separated, with a total per
 * bucket. Admin-only, same gate as the rest of `/dashboard/finance`.
 *
 * `?from=`/`?to=` (decisions/0066-abschluss-check-and-export.md) narrow the list to one
 * period by the document's EFFECTIVE date, the same date the Abschluss's "Belege ohne
 * Zahlung" count uses - so that count can be reproduced on the page its link opens.
 */
export default async function OpenItemsPage({ searchParams }: PageProps<"/dashboard/finance/offene-posten">) {
  const access = await requireWorkspaceMember();
  if (!access.permissions.includes(PERMISSIONS.financeRead)) notFound();

  const rawParams = await searchParams;
  const range = readDateRange({ from: firstParam(rawParams.from), to: firstParam(rawParams.to) });

  const [t, tCommon, view] = await Promise.all([
    getTranslations("Payments"),
    getTranslations("Common"),
    listOpenItemsProjection(access.workspace.id, range.from, range.to),
  ]);

  /** The "Zeitraum: ..." note's own text: both bounds, only a lower one, or only an upper
   * one. A named function rather than a nested ternary in the JSX. */
  function dateRangeLabel(): string {
    if (range.from !== undefined && range.to !== undefined) return tCommon("dateRange.label", { from: formatRangeBound(range.from), to: formatRangeBound(range.to) });
    if (range.from !== undefined) return tCommon("dateRange.labelFrom", { from: formatRangeBound(range.from) });
    return tCommon("dateRange.labelTo", { to: formatRangeBound(range.to!) });
  }

  function renderTable(items: OpenItemView[], totalCents: number) {
    if (items.length === 0) return <p className="text-sm text-muted-foreground">{t("openItems.emptyState")}</p>;
    return (
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2">{t("openItems.columns.document")}</th>
              <th className="px-3 py-2">{t("openItems.columns.contact")}</th>
              <th className="px-3 py-2">{t("openItems.columns.dueDate")}</th>
              <th className="px-3 py-2 text-right">{t("openItems.columns.openAmount")}</th>
              <th className="px-3 py-2">{t("openItems.columns.status")}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.documentId} className="border-t border-border">
                <td className="px-3 py-2">
                  <Link href={`/dashboard/documents/${item.documentId}`} className="text-foreground underline">
                    {item.title ?? item.originalFileName}
                  </Link>
                  {item.invoiceNumber ? <span className="ml-1 text-xs text-muted-foreground">({item.invoiceNumber})</span> : null}
                </td>
                <td className="px-3 py-2 text-foreground">{item.contactName ?? "–"}</td>
                <td className="px-3 py-2 text-foreground">{item.dueDate ?? "–"}</td>
                <td className="px-3 py-2 text-right font-medium text-foreground">{formatAmount(item.openAmountCents, item.currency)}</td>
                <td className="px-3 py-2">
                  <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-foreground">{t(`statusValues.${item.paymentStatus}`)}</span>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t border-border font-medium">
              <td className="px-3 py-2 text-foreground" colSpan={3}>
                {t("openItems.totalLabel")}
              </td>
              <td className="px-3 py-2 text-right text-foreground">{formatAmount(totalCents, items[0]?.currency ?? "EUR")}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold text-foreground">{t("openItems.heading")}</h1>

      {/* Why this list is short: the period the user arrived with, spelled out, with a way
          back to the full list (decisions/0066). */}
      {isDateRangeActive(range) ? (
        <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span>{dateRangeLabel()}</span>
          <Link href="/dashboard/finance/offene-posten" className="underline">
            {tCommon("dateRange.clear")}
          </Link>
        </p>
      ) : null}

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold text-foreground">{t("openItems.incomingHeading")}</h2>
        {renderTable(view.incoming, view.incomingOpenTotalCents)}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold text-foreground">{t("openItems.outgoingHeading")}</h2>
        {renderTable(view.outgoing, view.outgoingOpenTotalCents)}
      </section>
    </div>
  );
}
