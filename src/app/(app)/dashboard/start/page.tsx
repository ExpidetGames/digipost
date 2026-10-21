import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { PERMISSIONS } from "@/platform/access";
import { requireWorkspaceMember } from "@/platform/access/server";
import { countFailedProjection, countOverduePaymentsProjection, countPendingIntakeConfirmationProjection } from "@/modules/documents/server";
import { countOpenSuggestionsProjection, countUnmatchedTransactionsProjection } from "@/modules/payments/server";

type BucketKey = "pendingConfirmation" | "failedProcessing" | "overduePayments" | "unmatchedTransactions" | "openSuggestions";

type Bucket = { key: BucketKey; count: number; href: string };

/**
 * "Start" - the work list: "what do I have to do now", scattered today across the
 * Posteingang and the three finance pages. Every bucket is a real SQL `count(*)` read
 * through the owning module's own `server.ts` entrypoint (`src/modules/documents`,
 * `src/modules/payments`) - this page adds no table, no column, and no state of its own.
 *
 * "Wartet auf Bestätigung"/"Verarbeitung fehlgeschlagen"/"Überfällig" are member-level: a
 * document's own intake/processing/payment status is ordinary document work
 * (`documents.write`, every member already has it) and a document's own payment status is
 * explicitly NOT finance-gated (AGENTS.md's "Finance is admin-only" exception). "Zahlungen
 * ohne Beleg"/"Offene Vorschläge" are admin-only (`finance.read`) - an unmatched transaction
 * or a matching suggestion is finance information (amounts, counterparties), the same gate
 * "Zuordnung" itself uses; a non-admin's page render never even calls those two projections.
 */
export default async function StartPage() {
  const access = await requireWorkspaceMember();
  const workspaceId = access.workspace.id;
  const canReadFinance = access.permissions.includes(PERMISSIONS.financeRead);

  const [t, pendingConfirmationCount, failedCount, overdueCount, financeCounts] = await Promise.all([
    getTranslations("Start"),
    countPendingIntakeConfirmationProjection(workspaceId),
    countFailedProjection(workspaceId),
    countOverduePaymentsProjection(workspaceId),
    canReadFinance
      ? Promise.all([countUnmatchedTransactionsProjection(workspaceId), countOpenSuggestionsProjection(workspaceId)])
      : Promise.resolve(null),
  ]);

  const [unmatchedTransactionsCount, openSuggestionsCount] = financeCounts ?? [0, 0];

  const allBuckets: Bucket[] = [
    { key: "pendingConfirmation", count: pendingConfirmationCount, href: "/dashboard?intakeStatus=pending_confirmation" },
    { key: "failedProcessing", count: failedCount, href: "/dashboard?status=failed" },
    { key: "overduePayments", count: overdueCount, href: "/dashboard?paymentStatus=overdue" },
  ];
  if (canReadFinance) {
    allBuckets.push(
      { key: "unmatchedTransactions", count: unmatchedTransactionsCount, href: "/dashboard/finance/zuordnung" },
      { key: "openSuggestions", count: openSuggestionsCount, href: "/dashboard/finance/zuordnung" },
    );
  }
  const buckets = allBuckets.filter((bucket) => bucket.count > 0);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold text-foreground">{t("heading")}</h1>
        <p className="text-sm text-muted-foreground">{t("description")}</p>
      </div>

      {buckets.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border p-10 text-center">
          <p className="text-sm text-muted-foreground">{t("allDone")}</p>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {buckets.map((bucket) => (
            <li key={bucket.key}>
              <Link
                href={bucket.href}
                className="flex items-center justify-between gap-4 rounded-lg border border-border p-4 hover:bg-muted"
              >
                <div className="flex flex-col gap-0.5">
                  <p className="font-medium text-foreground">{t(`buckets.${bucket.key}.heading`)}</p>
                  <p className="text-sm text-muted-foreground">{t(`buckets.${bucket.key}.hint`)}</p>
                </div>
                <span className="rounded-full bg-muted px-3 py-1 text-sm font-semibold text-foreground">{bucket.count}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
