import { notFound } from "next/navigation";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { PERMISSIONS } from "@/platform/access";
import { requireWorkspaceMember } from "@/platform/access/server";
import { transactionListQuerySchema } from "@/modules/accounts";
import { getAccountOverviewProjection, listImportBatchesProjection, listTransactionsProjection } from "@/modules/accounts/server";
import { EditAccountSection, ReimportButton } from "@/modules/accounts/client";

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function formatIban(iban: string | null): string {
  if (!iban) return "–";
  return (iban.match(/.{1,4}/g) ?? [iban]).join(" ");
}

function formatAmount(cents: number | null, currency: string): string {
  if (cents === null) return "–";
  return new Intl.NumberFormat("de-DE", { style: "currency", currency }).format(cents / 100);
}

function pageHref(accountId: string, rawParams: Record<string, string | string[] | undefined>, page: number): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(rawParams)) {
    if (key === "page") continue;
    const first = firstParam(value);
    if (first) params.set(key, first);
  }
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return query ? `/dashboard/finance/${accountId}?${query}` : `/dashboard/finance/${accountId}`;
}

/**
 * Account detail (F2, decisions/0024-accounts-and-transactions.md): the transaction list
 * (search over counterparty/remittance text, date range, amount filter, credit/debit -
 * filter state lives in the URL, same convention as `/dashboard/contacts`), the import
 * history (duplicate counts, a balance-mismatch warning, and a re-run button), and the
 * manual edit form. 404s for a non-admin or an account id outside this workspace.
 */
export default async function AccountDetailPage({ params, searchParams }: PageProps<"/dashboard/finance/[accountId]">) {
  const { accountId } = await params;
  const access = await requireWorkspaceMember();
  if (!access.permissions.includes(PERMISSIONS.financeRead)) notFound();

  const account = await getAccountOverviewProjection(access.workspace.id, accountId);
  if (!account) notFound();

  const rawParams = await searchParams;
  const parsed = transactionListQuerySchema.safeParse({
    q: firstParam(rawParams.q),
    dateFrom: firstParam(rawParams.dateFrom),
    dateTo: firstParam(rawParams.dateTo),
    minAmountCents: firstParam(rawParams.minAmountCents),
    maxAmountCents: firstParam(rawParams.maxAmountCents),
    creditDebit: firstParam(rawParams.creditDebit),
    page: firstParam(rawParams.page),
  });
  const query = parsed.success ? parsed.data : { page: 1 as number };

  const [t, transactions, batches] = await Promise.all([
    getTranslations("Finance.detail"),
    listTransactionsProjection(access.workspace.id, accountId, query),
    listImportBatchesProjection(access.workspace.id, accountId),
  ]);

  const canManage = access.permissions.includes(PERMISSIONS.financeManage);
  const hasFilters = Boolean(query.q || query.dateFrom || query.dateTo || query.minAmountCents !== undefined || query.maxAmountCents !== undefined || query.creditDebit);
  const controlClasses = "h-8 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none dark:bg-input/30";

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold text-foreground">{account.name}</h1>
          <p className="text-sm text-muted-foreground">{formatIban(account.iban)}</p>
        </div>
        {canManage ? (
          <EditAccountSection
            accountId={account.id}
            initial={{
              type: account.type,
              name: account.name,
              iban: account.iban ?? "",
              bic: account.bic ?? "",
              currency: account.currency,
              holder: account.holder ?? "",
              platform: account.platform ?? "",
            }}
          />
        ) : null}
      </div>

      {account.contactId !== null ? (
        // decisions/0068-supplier-clearing-accounts.md: the balance of a supplier's clearing
        // account is a difference across the period this workspace happens to hold, not a
        // debt anyone has confirmed - the two 22,00 EUR charges of January 2025 almost
        // certainly settle adverts from a month nobody uploaded. The copy has to say that
        // rather than imply a precision it does not have.
        <section className="flex flex-col gap-1 rounded-lg border border-border bg-muted/30 p-3">
          <p className="text-sm font-medium text-foreground">
            {t("contactClearing.balanceLabel", { amount: formatAmount(account.latestBalanceCents, account.currency) })}
          </p>
          <p className="text-sm text-muted-foreground">{t("contactClearing.balanceExplanation")}</p>
          <p className="text-sm text-muted-foreground">{t("contactClearing.openingBalanceCaveat")}</p>
        </section>
      ) : null}

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold text-foreground">{t("importHistoryHeading")}</h2>
        {batches.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noImports")}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {batches.map((batch) => (
              <li key={batch.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-3">
                <div className="flex flex-col gap-0.5 text-sm">
                  <span className="text-foreground">
                    {batch.statementFrom ?? "?"} - {batch.statementTo ?? "?"}
                  </span>
                  <span className="text-muted-foreground">
                    {t("rowsImported", { count: batch.rowsImported })} · {t("rowsDuplicate", { count: batch.rowsDuplicate })}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  {batch.balanceMismatch ? (
                    <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-xs text-destructive">{t("balanceMismatch")}</span>
                  ) : null}
                  {canManage && batch.sourceDocumentId ? <ReimportButton documentId={batch.sourceDocumentId} accountId={account.id} /> : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-foreground">{t("transactionsHeading")}</h2>
        <form method="get" className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <label htmlFor="tx-q" className="text-xs text-muted-foreground">
              {t("filters.searchLabel")}
            </label>
            <input id="tx-q" name="q" defaultValue={query.q ?? ""} className={controlClasses} />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="tx-dateFrom" className="text-xs text-muted-foreground">
              {t("filters.dateFromLabel")}
            </label>
            <input id="tx-dateFrom" type="date" name="dateFrom" defaultValue={query.dateFrom ?? ""} className={controlClasses} />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="tx-dateTo" className="text-xs text-muted-foreground">
              {t("filters.dateToLabel")}
            </label>
            <input id="tx-dateTo" type="date" name="dateTo" defaultValue={query.dateTo ?? ""} className={controlClasses} />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="tx-minAmountCents" className="text-xs text-muted-foreground">
              {t("filters.minAmountLabel")}
            </label>
            <input id="tx-minAmountCents" type="number" name="minAmountCents" defaultValue={query.minAmountCents ?? ""} className={controlClasses} />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="tx-maxAmountCents" className="text-xs text-muted-foreground">
              {t("filters.maxAmountLabel")}
            </label>
            <input id="tx-maxAmountCents" type="number" name="maxAmountCents" defaultValue={query.maxAmountCents ?? ""} className={controlClasses} />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="tx-creditDebit" className="text-xs text-muted-foreground">
              {t("filters.creditDebitLabel")}
            </label>
            <select id="tx-creditDebit" name="creditDebit" defaultValue={query.creditDebit ?? ""} className={controlClasses}>
              <option value="">{t("filters.allCreditDebit")}</option>
              <option value="credit">{t("filters.credit")}</option>
              <option value="debit">{t("filters.debit")}</option>
            </select>
          </div>
          <button
            type="submit"
            className="inline-flex h-8 items-center justify-center rounded-lg border border-border bg-background px-3 text-sm font-medium text-foreground hover:bg-muted"
          >
            {t("filters.submit")}
          </button>
          {hasFilters ? (
            <Link href={`/dashboard/finance/${accountId}`} className="text-sm text-muted-foreground underline">
              {t("filters.reset")}
            </Link>
          ) : null}
        </form>

        {transactions.items.length === 0 ? (
          <p className="text-sm text-muted-foreground">{hasFilters ? t("emptyFiltered") : t("emptyState")}</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2">{t("columns.bookingDate")}</th>
                  <th className="px-3 py-2">{t("columns.counterparty")}</th>
                  <th className="px-3 py-2">{t("columns.remittanceText")}</th>
                  <th className="px-3 py-2 text-right">{t("columns.amount")}</th>
                </tr>
              </thead>
              <tbody>
                {transactions.items.map((tx) => (
                  <tr key={tx.id} className="border-t border-border">
                    <td className="px-3 py-2 text-foreground">{tx.bookingDate}</td>
                    <td className="px-3 py-2 text-foreground">{tx.counterpartyName ?? "–"}</td>
                    <td className="px-3 py-2 text-muted-foreground">{tx.remittanceText ?? "–"}</td>
                    <td className={`px-3 py-2 text-right font-medium ${tx.creditDebit === "credit" ? "text-brand-positive" : "text-foreground"}`}>
                      {formatAmount(tx.amountCents, tx.currency ?? account.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {transactions.items.length > 0 && (query.page > 1 || transactions.hasMore) ? (
          <div className="flex justify-between">
            {query.page > 1 ? (
              <Link href={pageHref(accountId, rawParams, query.page - 1)} className="text-sm text-foreground underline">
                {t("pagination.previous")}
              </Link>
            ) : (
              <span />
            )}
            {transactions.hasMore ? (
              <Link href={pageHref(accountId, rawParams, query.page + 1)} className="text-sm text-foreground underline">
                {t("pagination.next")}
              </Link>
            ) : (
              <span />
            )}
          </div>
        ) : null}
      </section>
    </div>
  );
}
