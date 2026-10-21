import { notFound } from "next/navigation";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { PERMISSIONS } from "@/platform/access";
import { requireWorkspaceMember } from "@/platform/access/server";
import { listAccountsOverviewProjection, listPendingAccountDocumentsProjection } from "@/modules/accounts/server";
import { CreateAccountSection, PendingAccountsSection } from "@/modules/accounts/client";

function formatIban(iban: string | null): string {
  if (!iban) return "–";
  return (iban.match(/.{1,4}/g) ?? [iban]).join(" ");
}

function formatAmount(cents: number | null, currency: string): string {
  if (cents === null) return "–";
  return new Intl.NumberFormat("de-DE", { style: "currency", currency }).format(cents / 100);
}

/** decisions/0068-supplier-clearing-accounts.md: a clearing account now has two possible
 * owners, and a contact-owned one means something different from a platform's (a difference
 * still to be explained, not a credit balance at a platform). */
function accountSubtitle(account: { type: string; iban: string | null; contactId: string | null }, t: (key: string) => string): string {
  if (account.type !== "clearing") return formatIban(account.iban);
  return account.contactId !== null ? t("contactClearing.listHint") : t("clearingAccountHint");
}

/**
 * "Finanzen" (F2, decisions/0024-accounts-and-transactions.md): admin-only end to end - 404s
 * for a non-admin visiting the URL directly, same pattern as `/dashboard/settings/company` and
 * `/dashboard/settings/intake`. Accounts overview: latest balance and statement coverage
 * gaps per account, plus the "Konto zuordnen" list for a confirmed bank-statement document
 * whose statement carried no own-account IBAN to auto-resolve against.
 */
export default async function FinancePage() {
  const access = await requireWorkspaceMember();
  if (!access.permissions.includes(PERMISSIONS.financeRead)) notFound();

  const [t, accounts, pendingDocuments] = await Promise.all([
    getTranslations("Finance"),
    listAccountsOverviewProjection(access.workspace.id),
    listPendingAccountDocumentsProjection(access.workspace.id),
  ]);

  const canManage = access.permissions.includes(PERMISSIONS.financeManage);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold text-foreground">{t("heading")}</h1>
          <p className="text-sm text-muted-foreground">{t("description")}</p>
        </div>
        {canManage ? <CreateAccountSection /> : null}
      </div>

      {canManage ? (
        <PendingAccountsSection
          documents={pendingDocuments}
          // F5 review finding (F2 #4, decisions/0027-hardening-and-deletion.md): only a
          // `type: "bank"` account is ever a valid target for a plain bank statement's
          // transactions - a platform's own clearing account (F4) is populated exclusively
          // from a payout/settlement report, never listed here (the use case itself also
          // rejects a clearing-account id defensively, `ACCOUNT_ERROR.notBankAccount`).
          accounts={accounts.filter((a) => a.type === "bank").map((a) => ({ id: a.id, name: a.name }))}
        />
      ) : null}

      {accounts.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border p-10 text-center">
          <p className="text-sm text-muted-foreground">{t("emptyAccounts")}</p>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {accounts.map((account) => (
            <li key={account.id}>
              <Link
                href={`/dashboard/finance/${account.id}`}
                className="flex flex-col gap-1 rounded-lg border border-border p-3 hover:bg-muted sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex flex-col gap-0.5">
                  <div className="flex items-center gap-2">
                    <p className="font-medium text-foreground">{account.name}</p>
                    {account.type === "clearing" ? (
                      <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-foreground">{t("clearingAccountBadge")}</span>
                    ) : null}
                  </div>
                  <p className="text-sm text-muted-foreground">{accountSubtitle(account, t)}</p>
                </div>
                <div className="flex flex-col items-end gap-1 text-sm">
                  <span className="font-medium text-foreground">{formatAmount(account.latestBalanceCents, account.currency)}</span>
                  {!account.balanceIsExact && account.latestBalanceCents !== null ? (
                    <span className="text-xs text-muted-foreground">{t("balanceApprox")}</span>
                  ) : null}
                  {account.coverageGaps.length > 0 ? (
                    <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-xs text-destructive">
                      {t("coverageGapCount", { count: account.coverageGaps.length })}
                    </span>
                  ) : null}
                  {account.hasMixedCurrencyTransactions ? (
                    <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-xs text-destructive">{t("mixedCurrencyWarning")}</span>
                  ) : null}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
