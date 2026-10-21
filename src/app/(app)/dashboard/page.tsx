import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Loader2 } from "lucide-react";

import { PERMISSIONS } from "@/platform/access";
import { requireWorkspaceMember } from "@/platform/access/server";
import { DOCUMENT_KINDS } from "@/modules/intake";
import { documentDisplayName } from "@/modules/documents";
import { resolveDisplayStatus } from "@/modules/payments";
import { DOCUMENT_STATUSES, DOCUMENT_SORTS, documentListQuerySchema, listDocumentsProjection } from "@/modules/documents/server";
import { kickProcessingAction } from "@/modules/documents/actions";
import { ProcessingPoller } from "@/modules/documents/client";
import { getCompanyProfileProjection, isCompanyProfileIncomplete } from "@/modules/workspaces/server";
import { CompanyProfileBanner } from "@/modules/workspaces/client";

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Preserves every other filter while changing only `page` (pagination links). */
function pageHref(rawParams: Record<string, string | string[] | undefined>, page: number): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(rawParams)) {
    if (key === "page") continue;
    const first = firstParam(value);
    if (first) params.set(key, first);
  }
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return query ? `/dashboard?${query}` : "/dashboard";
}

/** `2025-01-01` as `01.01.2025`, for the "Zeitraum: ... bis ..." note. A plain `Date` over
 * the ISO string with an explicit midnight, never `new Date("2025-01-01")` alone, which
 * parses as UTC and can render the previous day west of Greenwich. */
const RANGE_BOUND_FORMATTER = new Intl.DateTimeFormat("de", { day: "2-digit", month: "2-digit", year: "numeric" });
function formatRangeBound(iso: string): string {
  return RANGE_BOUND_FORMATTER.format(new Date(`${iso}T00:00:00`));
}

/** The same URL without the date range (and back on page 1), for the "Zeitraum aufheben"
 * link next to the range note - every OTHER filter the user set stays where it was
 * (decisions/0066-abschluss-check-and-export.md). */
function withoutDateRangeHref(rawParams: Record<string, string | string[] | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(rawParams)) {
    if (key === "from" || key === "to" || key === "page") continue;
    const first = firstParam(value);
    if (first) params.set(key, first);
  }
  const query = params.toString();
  return query ? `/dashboard?${query}` : "/dashboard";
}

/**
 * "Posteingang" (decisions/0015-documents-and-quotas.md): the inbox list, search, status
 * filter, and pagination. Filter state lives entirely in the URL's search params, read here
 * server-side - the filter form below is a plain `method="get"` form, so
 * filtering/searching/paginating never needs client JS.
 */
export default async function DashboardPage({ searchParams }: PageProps<"/dashboard">) {
  const access = await requireWorkspaceMember();
  const rawParams = await searchParams;

  const parsed = documentListQuerySchema.safeParse({
    q: firstParam(rawParams.q),
    status: firstParam(rawParams.status),
    direction: firstParam(rawParams.direction),
    kind: firstParam(rawParams.kind),
    paymentStatus: firstParam(rawParams.paymentStatus),
    sort: firstParam(rawParams.sort),
    // The "Start" work-list page's "Wartet auf Bestätigung" link.
    intakeStatus: firstParam(rawParams.intakeStatus),
    // decisions/0066-abschluss-check-and-export.md: the inbox's own date range, and what the
    // Abschluss's "Wartet auf Bestätigung"/"Verarbeitung fehlgeschlagen" links carry.
    from: firstParam(rawParams.from),
    to: firstParam(rawParams.to),
    page: firstParam(rawParams.page),
  });
  const query = parsed.success ? parsed.data : { page: 1 as number, sort: "documentDate" as const };

  const canManageCompanyProfile = access.permissions.includes(PERMISSIONS.companyProfileManage);

  const [t, tCommon, tKinds, tPayments, tPlatforms, list, companyProfile] = await Promise.all([
    getTranslations("Inbox"),
    // The "Zeitraum: ... bis ..." note below the filters.
    getTranslations("Common"),
    // F1b (decisions/0022-intake-wiring.md): the inbox kind filter's option labels.
    getTranslations("DocumentKinds"),
    // F3b (decisions/0025-payment-matching-wiring.md): the status chip's labels.
    getTranslations("Payments"),
    // decisions/0060-app-store-reports-are-named-by-their-period.md: "Apple", "Google".
    getTranslations("SettlementPlatforms"),
    listDocumentsProjection(access.workspace.id, {
      q: query.q,
      status: query.status,
      direction: query.direction,
      kind: query.kind,
      paymentStatus: query.paymentStatus,
      sort: query.sort,
      intakeStatus: query.intakeStatus,
      from: query.from,
      to: query.to,
      page: query.page,
    }),
    // Only the admin can act on an incomplete company profile - a member sees no banner
    // (`canManageCompanyProfile` below), so skip the lookup for anyone else entirely.
    canManageCompanyProfile ? getCompanyProfileProjection(access.workspace.id) : Promise.resolve(null),
  ]);
  const showCompanyProfileBanner = canManageCompanyProfile && isCompanyProfileIncomplete(companyProfile);

  const hasFilters = Boolean(
    query.q || query.status || query.direction || query.kind || query.paymentStatus || query.intakeStatus || query.from || query.to,
  );
  // decisions/0021-extraction-direction-and-invoice-fields.md: the inbox shows the extracted
  // amount when present, formatted in the document's own currency (falling back to EUR - the
  // product's only currency for launch - when the analyzer found an amount but no currency).
  function formatAmount(totalAmountCents: number, currency: string | null): string {
    return new Intl.NumberFormat("de-DE", { style: "currency", currency: currency ?? "EUR" }).format(totalAmountCents / 100);
  }
  const dateFormatter = new Intl.DateTimeFormat("de", { dateStyle: "medium" });
  // decisions/0060: a report's period is a month, so it is written as one ("November 2025").
  const monthFormatter = new Intl.DateTimeFormat("de", { month: "long", year: "numeric" });
  const todayIso = new Date().toISOString().slice(0, 10);
  // decisions/0059-generated-document-names.md. The date half is formatted here (the locale
  // and the "Eingang" label for a document with no own date live in the UI layer,
  // decisions/0058-inbox-sorts-by-the-document-s-own-date.md); `documentDisplayName` only
  // decides which name to file it under.
  function displayName(doc: (typeof list.items)[number]): string {
    // decisions/0060-app-store-reports-are-named-by-their-period.md: an Apple or Google report
    // has no document date and no counterparty, it covers a month. It is named after the
    // platform and that month ("Apple, November 2025").
    const isReport = doc.platform !== null && doc.reportPeriod !== null;
    // decisions/0061-a-statement-is-dated-by-its-last-booking.md: a bank statement has no
    // counterparty and no date of its own either. It is named after its kind and dated by the
    // last booking it contains ("Kontoauszug, 21.09.2026").
    const isStatement = doc.kind === "bank_statement" && doc.statementLastBooking !== null;
    function formatDateHalf(): string {
      if (isReport) return monthFormatter.format(new Date(`${doc.reportPeriod}-01T00:00:00`));
      if (isStatement) return dateFormatter.format(new Date(`${doc.statementLastBooking}T00:00:00`));
      if (doc.documentDate) return dateFormatter.format(new Date(`${doc.documentDate}T00:00:00`));
      return t("receivedOn", { date: dateFormatter.format(new Date(doc.createdAt)) });
    }
    function typeLabel(): string | null {
      if (isReport) return tPlatforms(doc.platform!);
      if (isStatement) return tKinds("bank_statement");
      return null;
    }
    const formattedDate = formatDateHalf();
    return documentDisplayName({
      typeLabel: typeLabel(),
      counterpartyName: doc.counterpartyName,
      sender: doc.sender,
      direction: doc.direction,
      originalFileName: doc.originalFileName,
      formattedDate,
    });
  }
  /** The "Zeitraum: ..." note's own text: both bounds, only a lower one, or only an upper
   * one. A named function rather than a nested ternary in the JSX. */
  function dateRangeLabel(): string {
    if (query.from !== undefined && query.to !== undefined) return tCommon("dateRange.label", { from: formatRangeBound(query.from), to: formatRangeBound(query.to) });
    if (query.from !== undefined) return tCommon("dateRange.labelFrom", { from: formatRangeBound(query.from) });
    return tCommon("dateRange.labelTo", { to: formatRangeBound(query.to!) });
  }

  const controlClasses = "h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none dark:bg-input/30";
  const hasProcessingDocuments = list.items.some((doc) => doc.status === "uploaded" || doc.status === "processing");

  return (
    <div className="flex flex-col gap-6">
      <ProcessingPoller active={hasProcessingDocuments} kickAction={kickProcessingAction} />

      {showCompanyProfileBanner ? <CompanyProfileBanner /> : null}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold text-foreground">{t("heading")}</h1>
        <Link
          href="/dashboard/scan"
          className="inline-flex h-8 items-center justify-center rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/80"
        >
          {t("scanCta")}
        </Link>
      </div>

      {/* Search is the primary control and gets its own full-width row above the filters:
          full text over every document beats narrowing by kind or status for almost every
          question a user actually has. */}
      <form method="get" className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <label htmlFor="inbox-q" className="text-xs text-muted-foreground">
            {t("filters.searchLabel")}
          </label>
          <input
            id="inbox-q"
            name="q"
            defaultValue={query.q ?? ""}
            placeholder={t("filters.searchPlaceholder")}
            className="h-10 w-full rounded-lg border border-input bg-transparent px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
          />
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <label htmlFor="inbox-status" className="text-xs text-muted-foreground">
              {t("filters.statusLabel")}
            </label>
            <select id="inbox-status" name="status" defaultValue={query.status ?? ""} className={controlClasses}>
              <option value="">{t("filters.allStatuses")}</option>
              {DOCUMENT_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {t(`statusValues.${status}`)}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="inbox-direction" className="text-xs text-muted-foreground">
              {t("filters.directionLabel")}
            </label>
            <select id="inbox-direction" name="direction" defaultValue={query.direction ?? ""} className={controlClasses}>
              <option value="">{t("filters.allDirections")}</option>
              <option value="incoming">{t("directionValues.incoming")}</option>
              <option value="outgoing">{t("directionValues.outgoing")}</option>
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="inbox-kind" className="text-xs text-muted-foreground">
              {t("filters.kindLabel")}
            </label>
            <select id="inbox-kind" name="kind" defaultValue={query.kind ?? ""} className={controlClasses}>
              <option value="">{t("filters.allKinds")}</option>
              {DOCUMENT_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {tKinds(kind)}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="inbox-payment-status" className="text-xs text-muted-foreground">
              {t("filters.paymentStatusLabel")}
            </label>
            <select id="inbox-payment-status" name="paymentStatus" defaultValue={query.paymentStatus ?? ""} className={controlClasses}>
              <option value="">{t("filters.allPaymentStatuses")}</option>
              <option value="open">{t("paymentStatusValues.open")}</option>
              <option value="overdue">{t("paymentStatusValues.overdue")}</option>
              <option value="paid">{t("paymentStatusValues.paid")}</option>
            </select>
          </div>
          {/* decisions/0066-abschluss-check-and-export.md: the date range the Abschluss's
              check links carry, as two ordinary filter fields - a user who lands here from
              such a link sees exactly which period narrowed the list, and can widen or clear
              it with the same controls as every other filter. */}
          <div className="flex flex-col gap-1">
            <label htmlFor="inbox-from" className="text-xs text-muted-foreground">
              {t("filters.fromLabel")}
            </label>
            <input id="inbox-from" type="date" name="from" defaultValue={query.from ?? ""} className={controlClasses} />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="inbox-to" className="text-xs text-muted-foreground">
              {t("filters.toLabel")}
            </label>
            <input id="inbox-to" type="date" name="to" defaultValue={query.to ?? ""} className={controlClasses} />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="inbox-sort" className="text-xs text-muted-foreground">
              {t("filters.sortLabel")}
            </label>
            <select id="inbox-sort" name="sort" defaultValue={query.sort} className={controlClasses}>
              {DOCUMENT_SORTS.map((sort) => (
                <option key={sort} value={sort}>
                  {t(`sortValues.${sort}`)}
                </option>
              ))}
            </select>
          </div>
          <button
            type="submit"
            className="inline-flex h-8 items-center justify-center rounded-lg border border-border bg-background px-3 text-sm font-medium text-foreground hover:bg-muted"
          >
            {t("filters.submit")}
          </button>
          {hasFilters ? (
            <Link href="/dashboard" className="text-sm text-muted-foreground underline">
              {t("filters.reset")}
            </Link>
          ) : null}
        </div>
      </form>

      {/* Why this list is short: the period the user arrived with, spelled out, with its own
          way out that keeps every other filter (decisions/0066). */}
      {query.from || query.to ? (
        <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span>{dateRangeLabel()}</span>
          <Link href={withoutDateRangeHref(rawParams)} className="underline">
            {tCommon("dateRange.clear")}
          </Link>
        </p>
      ) : null}

      {list.items.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border p-10 text-center">
          <p className="text-sm text-muted-foreground">{hasFilters ? t("emptyFiltered") : t("emptyState")}</p>
          {hasFilters ? null : (
            <Link
              href="/dashboard/scan"
              className="inline-flex h-8 items-center justify-center rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/80"
            >
              {t("scanCta")}
            </Link>
          )}
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {list.items.map((doc) => (
            <li key={doc.id}>
              <Link
                href={`/dashboard/documents/${doc.id}`}
                className="flex flex-col gap-1 rounded-lg border border-border p-3 hover:bg-muted sm:flex-row sm:items-center sm:justify-between"
              >
                {/* decisions/0059-generated-document-names.md: a name this application
                    generates from the counterparty and the document's own date, never the
                    file name someone happened to drag in. The subject line below it is the
                    analyzer's title, and only when it says something the name does not. */}
                <div className="min-w-0">
                  <p className="font-medium text-foreground">{displayName(doc)}</p>
                  {doc.title ? <p className="truncate text-sm text-muted-foreground">{doc.title}</p> : null}
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2 text-sm text-muted-foreground">
                  {doc.totalAmountCents !== null ? <span>{formatAmount(doc.totalAmountCents, doc.currency)}</span> : null}
                  {/* Only states that ask something of the reader are shown. The ordinary ones
                      ("Rechnung", "Eingang", "Bezahlt", "Verarbeitet") were noise on every row
                      and are reachable through the filters above. */}
                  {doc.intakeStatus === "pending_confirmation" ? (
                    <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
                      {t("intakePendingChip")}
                    </span>
                  ) : null}
                  {doc.paymentStatus !== "not_applicable" &&
                  resolveDisplayStatus(doc.paymentStatus, doc.dueDate, todayIso) === "overdue" ? (
                    <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
                      {tPayments("statusValues.overdue")}
                    </span>
                  ) : null}
                  {doc.status === "failed" ? (
                    <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
                      {t("statusValues.failed")}
                    </span>
                  ) : null}
                  {doc.status === "uploaded" || doc.status === "processing" ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs text-foreground">
                      <Loader2 aria-hidden className="size-3 animate-spin" />
                      {t(`statusValues.${doc.status}`)}
                    </span>
                  ) : null}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {list.items.length > 0 && (query.page > 1 || list.hasMore) ? (
        <div className="flex justify-between">
          {query.page > 1 ? (
            <Link href={pageHref(rawParams, query.page - 1)} className="text-sm text-foreground underline">
              {t("pagination.previous")}
            </Link>
          ) : (
            <span />
          )}
          {list.hasMore ? (
            <Link href={pageHref(rawParams, query.page + 1)} className="text-sm text-foreground underline">
              {t("pagination.next")}
            </Link>
          ) : (
            <span />
          )}
        </div>
      ) : null}
    </div>
  );
}
