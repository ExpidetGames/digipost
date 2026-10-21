import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { closingPeriodOptions, currentClosingPeriod, parseClosingPeriod } from "@/modules/closing";
import { getClosingReportProjection } from "@/modules/closing/server";
import { PERMISSIONS } from "@/platform/access";
import { requireWorkspaceMember } from "@/platform/access/server";

/** How far back the selector offers to look. Two years of months and four whole years covers
 * every ordinary handover (the current month, last month, last year's closing) without
 * turning the dropdown into a list nobody scrolls. */
const PERIOD_OPTIONS = { months: 24, years: 4 };

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * "Abschluss" (decisions/0066-abschluss-check-and-export.md): is this month (or this year)
 * complete, and can it be handed to the tax advisor? Admin-only end to end
 * (`finance.read`) - a non-admin visiting the URL directly gets `notFound()`, the same
 * pattern `/dashboard/finance/**` and `/dashboard/settings/intake` use.
 *
 * The period lives entirely in the URL (`?period=2026-01` / `?period=2026`), read
 * server-side, so the selector below is a plain `method="get"` form and needs no client JS -
 * exactly like the inbox's filters. An absent or malformed value falls back to the current
 * month rather than erroring on a stale bookmark
 * (decisions/0062-an-empty-search-param-means-absent.md).
 */
export default async function AbschlussPage({ searchParams }: PageProps<"/dashboard/abschluss">) {
  const access = await requireWorkspaceMember();
  if (!access.permissions.includes(PERMISSIONS.financeRead)) notFound();

  const rawParams = await searchParams;
  const todayIso = new Date().toISOString().slice(0, 10);
  const period = parseClosingPeriod(firstParam(rawParams.period)) ?? currentClosingPeriod(todayIso);

  const [t, report] = await Promise.all([getTranslations("Closing"), getClosingReportProjection(access.workspace.id, period)]);

  const options = closingPeriodOptions(todayIso, PERIOD_OPTIONS);
  const monthFormatter = new Intl.DateTimeFormat("de", { month: "long", year: "numeric" });
  const openItems = report.items.filter((item) => !item.clear);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">{t("heading")}</h1>
        <p className="text-sm text-muted-foreground">{t("description")}</p>
      </div>

      <form method="get" className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <label htmlFor="closing-period" className="text-xs text-muted-foreground">
            {t("periodLabel")}
          </label>
          <select
            id="closing-period"
            name="period"
            defaultValue={period.value}
            className="h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none dark:bg-input/30"
          >
            <optgroup label={t("periodMonths")}>
              {options.months.map((option) => (
                <option key={option.value} value={option.value}>
                  {monthFormatter.format(new Date(`${option.value}-01T00:00:00`))}
                </option>
              ))}
            </optgroup>
            <optgroup label={t("periodYears")}>
              {options.years.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.value}
                </option>
              ))}
            </optgroup>
          </select>
        </div>
        <button
          type="submit"
          className="inline-flex h-8 items-center justify-center rounded-lg border border-border bg-background px-3 text-sm font-medium text-foreground hover:bg-muted"
        >
          {t("periodSubmit")}
        </button>
      </form>

      {/* The period's own size, always shown: "keine Lücken" in an empty period says nothing
          at all, and decisions/0066 makes that the one honest guard this check can offer. */}
      <div className="flex flex-col gap-1 rounded-lg border border-border p-4">
        <p className="text-sm font-medium text-foreground">{t("totalsHeading")}</p>
        <p className="text-sm text-muted-foreground">
          {t("totalDocuments", { count: report.totals.documents })} · {t("totalTransactions", { count: report.totals.transactions })}
        </p>
      </div>

      {report.empty ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border p-10 text-center">
          <p className="text-sm text-muted-foreground">{t("emptyPeriod")}</p>
        </div>
      ) : null}

      {!report.empty && report.complete ? (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border p-10 text-center">
          <p className="font-medium text-foreground">{t("completeHeading")}</p>
          <p className="max-w-prose text-sm text-muted-foreground">{t("completeHint")}</p>
        </div>
      ) : null}

      {openItems.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {openItems.map((item) => (
            <li key={item.key}>
              <Link href={item.href} className="flex items-center justify-between gap-4 rounded-lg border border-border p-4 hover:bg-muted">
                <div className="flex flex-col gap-0.5">
                  <p className="font-medium text-foreground">{t(`checks.${item.key}.heading`)}</p>
                  <p className="text-sm text-muted-foreground">{t(`checks.${item.key}.hint`)}</p>
                </div>
                <span className="rounded-full bg-destructive/10 px-3 py-1 text-sm font-semibold text-destructive">{item.count}</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="flex flex-col gap-2 rounded-lg border border-border p-4">
        <a
          href={`/api/closing/export?period=${period.value}`}
          className="inline-flex h-8 w-fit items-center justify-center rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/80"
        >
          {t("download")}
        </a>
        <p className="text-sm text-muted-foreground">{t("downloadHint")}</p>
      </div>
    </div>
  );
}
