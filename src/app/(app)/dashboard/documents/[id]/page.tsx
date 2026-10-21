import { notFound } from "next/navigation";

import { PERMISSIONS } from "@/platform/access";
import { requireWorkspaceMember } from "@/platform/access/server";
import { getDocumentDetailProjection } from "@/modules/documents/server";
import { DocumentDetailClient } from "@/modules/documents/client";
import { kickProcessingAction } from "@/modules/documents/actions";
import { isFakeAiProviderActive } from "@/platform/mistral/server";
import { getDocumentPaymentSectionProjection, getSettlementReportProjection, listUnmatchedTransactionsProjection } from "@/modules/payments/server";
import { PaymentSection, SettlementReportSection, type ManualLinkCandidate } from "@/modules/payments/client";

// F3b (decisions/0025-payment-matching-wiring.md): caps how many unmatched transactions the
// "Transaktion manuell verknüpfen" dropdown offers - a plain recency-bounded slice, not scored
// against this specific document (`@/modules/payments/core/candidates.ts`'s scoring is only
// wired into `runMatching`'s own automatic suggestions in this phase); a documented
// simplification for this phase's UI, not a functional gap (every transaction is still
// reachable via "Zuordnung"'s own confirm/reject flow).
const MANUAL_LINK_CANDIDATE_LIMIT = 100;

/** Document detail: the PDF embedded same-origin from `GET /api/documents/[id]/file`,
 * plus the metadata panel (`DocumentDetailClient`) and, for an invoice-shaped document, the
 * payment section (`PaymentSection`, F3b). 404s for a document id that does not exist in the
 * caller's own workspace - `getDocumentDetailProjection` is already scoped to
 * `access.workspace.id`, never client input. */
export default async function DocumentDetailPage({ params }: PageProps<"/dashboard/documents/[id]">) {
  const { id } = await params;
  const access = await requireWorkspaceMember();
  const canReadFinance = access.permissions.includes(PERMISSIONS.financeRead);
  const canManageFinance = access.permissions.includes(PERMISSIONS.financeManage);

  const document = await getDocumentDetailProjection(access.workspace.id, id);

  if (!document) notFound();

  // `paymentStatus: "not_applicable"` means this is not an invoice-shaped document at all
  // (a plain letter, or one whose direction never resolved) - no payment section to show.
  const isInvoiceShaped = document.paymentStatus !== "not_applicable";
  // F4 (decisions/0026-platform-settlements.md): a confirmed settlement report shows its own
  // decomposition instead of (never alongside) the ordinary payment section - a report is not
  // itself invoice-shaped (no `direction`/`totalAmountCents`), so `isInvoiceShaped` is always
  // `false` for one.
  const isSettlementReport = (document.kind === "payout_report" || document.kind === "platform_settlement") && document.intakeStatus === "confirmed";
  const [paymentSection, manualLinkCandidates, settlementReport] = await Promise.all([
    isInvoiceShaped ? getDocumentPaymentSectionProjection(access.workspace.id, id, canReadFinance) : Promise.resolve(null),
    isInvoiceShaped && canManageFinance ? listUnmatchedTransactionsProjection(access.workspace.id) : Promise.resolve(null),
    isSettlementReport && canReadFinance ? getSettlementReportProjection(access.workspace.id, id) : Promise.resolve(null),
  ]);
  const candidates: ManualLinkCandidate[] | undefined = manualLinkCandidates
    ?.slice(0, MANUAL_LINK_CANDIDATE_LIMIT)
    .map((row) => ({
      transactionId: row.transactionId,
      bookingDate: row.bookingDate,
      amountCents: row.amountCents,
      currency: row.currency,
      counterpartyName: row.counterpartyName,
      remittanceText: row.remittanceText,
    }));

  return (
    <div className="flex flex-col gap-4">
      <DocumentDetailClient
        document={document}
        isFakeAiProvider={isFakeAiProviderActive()}
        kickAction={kickProcessingAction}
      />
      {paymentSection ? (
        <PaymentSection documentId={id} section={paymentSection} canManage={canManageFinance} manualLinkCandidates={candidates} />
      ) : null}
      {settlementReport ? <SettlementReportSection report={settlementReport} /> : null}
    </div>
  );
}
