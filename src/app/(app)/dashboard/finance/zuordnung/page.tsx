import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { PERMISSIONS } from "@/platform/access";
import { requireWorkspaceMember } from "@/platform/access/server";
import { getPaymentAutoConfirmModeProjection, listUnmatchedTransactionsProjection } from "@/modules/payments/server";
import { AutoConfirmModeSelect, ZuordnungClient } from "@/modules/payments/client";
import { isDateRangeActive, readDateRange } from "@/shared/date-range";

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
 * "Zuordnung" (F3b, decisions/0025-payment-matching-wiring.md): every unmatched transaction
 * with its own top suggestions, plus bulk "kein Beleg nötig". Admin-only end to end, same
 * `finance.read`/`finance.manage` gate as the rest of `/dashboard/finance`
 * (decisions/0024-accounts-and-transactions.md) - a transaction list is exactly the
 * information a member must never see.
 *
 * `?from=`/`?to=` (decisions/0066-abschluss-check-and-export.md) narrow the list to one
 * period by the transaction's own booking date - the SAME date the Abschluss's "Buchungen
 * ohne Beleg" count is scoped by, which is what makes that count reproducible here. Absent
 * (the ordinary visit), the page lists every unmatched transaction as before.
 */
export default async function ZuordnungPage({ searchParams }: PageProps<"/dashboard/finance/zuordnung">) {
  const access = await requireWorkspaceMember();
  if (!access.permissions.includes(PERMISSIONS.financeRead)) notFound();

  const rawParams = await searchParams;
  const range = readDateRange({ from: firstParam(rawParams.from), to: firstParam(rawParams.to) });

  const [t, tCommon, transactions, autoConfirmMode] = await Promise.all([
    getTranslations("Payments"),
    getTranslations("Common"),
    listUnmatchedTransactionsProjection(access.workspace.id, range.from, range.to),
    getPaymentAutoConfirmModeProjection(access.workspace.id),
  ]);

  /** The "Zeitraum: ..." note's own text: both bounds, only a lower one, or only an upper
   * one. A named function rather than a nested ternary in the JSX. */
  function dateRangeLabel(): string {
    if (range.from !== undefined && range.to !== undefined) return tCommon("dateRange.label", { from: formatRangeBound(range.from), to: formatRangeBound(range.to) });
    if (range.from !== undefined) return tCommon("dateRange.labelFrom", { from: formatRangeBound(range.from) });
    return tCommon("dateRange.labelTo", { to: formatRangeBound(range.to!) });
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">{t("zuordnung.heading")}</h1>
        <p className="text-sm text-muted-foreground">{t("zuordnung.description")}</p>
      </div>

      {/* Why this list is short: the period the user arrived with, spelled out, with a way
          back to the full list (decisions/0066). */}
      {isDateRangeActive(range) ? (
        <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span>{dateRangeLabel()}</span>
          <Link href="/dashboard/finance/zuordnung" className="underline">
            {tCommon("dateRange.clear")}
          </Link>
        </p>
      ) : null}

      <AutoConfirmModeSelect mode={autoConfirmMode} canManage={access.permissions.includes(PERMISSIONS.financeManage)} />

      <ZuordnungClient transactions={transactions} />
    </div>
  );
}
