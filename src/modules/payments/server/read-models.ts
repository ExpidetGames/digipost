// Owner: src/modules/payments (F3b, decisions/0025-payment-matching-wiring.md). Read models
// for the document detail payment section and `/dashboard/finance`'s "Zuordnung"/"Offene
// Posten" tabs, published through `server.ts` like every other module's `server/read-models.ts`.
//
// This file is where "does this viewer get to see amounts and counterparties" is actually
// decided - never in the use case (which has no notion of a caller's permissions) and never
// only in the UI (a Server Component's props are serialized into the client bundle regardless
// of what is rendered, so an unauthorized viewer must never even RECEIVE the data).
import "server-only";

import { cache } from "react";

import {
  decomposeSettlement,
  looksLikePlatformPayout,
  resolveDisplayStatus,
  type DocumentPaymentSection,
  type MatchReasonCode,
  type OpenItemsView,
  type SettlementLine,
  type SettlementReportView,
  type UnmatchedTransactionView,
} from "@/modules/payments";
import { getRequestServices } from "@/persistence/composition/request-services";

function toReasons(raw: unknown): MatchReasonCode[] {
  return Array.isArray(raw) ? (raw as MatchReasonCode[]) : [];
}

/**
 * `revealFinanceDetails` must be the caller's own `finance.read` check
 * (`access.permissions.includes(PERMISSIONS.financeRead)`) - `false` for every ordinary
 * workspace member, `true` only for an admin. `false` returns `paymentStatus`/`paidAt` and the
 * two safe boolean/date callouts, but `matchedTransactions` carry no amount/currency/
 * counterparty and `suggestions` is always empty - reviewing a suggestion inherently means
 * seeing the transaction it proposes.
 */
export const getDocumentPaymentSectionProjection = cache(async function getDocumentPaymentSectionProjection(
  workspaceId: string,
  documentId: string,
  revealFinanceDetails: boolean,
): Promise<DocumentPaymentSection | null> {
  const data = await getRequestServices().payments.getDocumentPaymentSection(workspaceId, documentId);
  if (!data) return null;

  return {
    paymentStatus: data.paymentStatus,
    paidAt: data.paidAt ? data.paidAt.toISOString() : null,
    matchedTransactions: data.matchedTransactions.map((row) => ({
      documentTransactionId: row.id,
      transactionId: row.transactionId,
      bookingDate: row.transactionBookingDate,
      kind: row.kind as MatchedTransactionKind,
      matchedBy: row.matchedBy as MatchedByValue,
      ...(revealFinanceDetails
        ? { amountCents: row.transactionAmountCents, currency: row.transactionCurrency, counterpartyName: row.transactionCounterpartyName }
        : {}),
    })),
    suggestions: revealFinanceDetails
      ? data.suggestions.map((row) => ({
          documentTransactionId: row.id,
          transactionId: row.transactionId,
          bookingDate: row.transactionBookingDate,
          amountCents: row.transactionAmountCents,
          currency: row.transactionCurrency,
          counterpartyName: row.transactionCounterpartyName,
          kind: row.kind as MatchedTransactionKind,
          confidence: row.confidence,
          reasons: toReasons(row.reasons),
          explanation: row.explanation,
        }))
      : [],
    reminderAlreadyPaidAt: data.reminderAlreadyPaidAt ? data.reminderAlreadyPaidAt.toISOString() : null,
    possibleDuplicatePayment: data.possibleDuplicatePayment,
  };
});

// Narrow local aliases so this file does not need to import `MatchKind`/`MatchedBy` just to
// cast a drizzle `text()` column's widened type back to its own literal union.
type MatchedTransactionKind = DocumentPaymentSection["matchedTransactions"][number]["kind"];
type MatchedByValue = DocumentPaymentSection["matchedTransactions"][number]["matchedBy"];

/** "Zuordnung" - admin-only page (`finance.read`), so no redaction is needed here at all.
 *
 * `from`/`to` (decisions/0066-abschluss-check-and-export.md) are the page's optional date
 * range, inclusive ISO `YYYY-MM-DD` bounds on the transaction's own booking date - the same
 * date the Abschluss's "Buchungen ohne Beleg" count is scoped by, which is what lets that
 * count and this list agree. Passed as two primitives rather than one object so `cache()`'s
 * argument comparison (identity, not deep equality) actually dedupes repeated calls. */
export const listUnmatchedTransactionsProjection = cache(async function listUnmatchedTransactionsProjection(
  workspaceId: string,
  from?: string,
  to?: string,
): Promise<UnmatchedTransactionView[]> {
  const rows = await getRequestServices().payments.listUnmatchedTransactions(workspaceId, { from, to });
  return rows.map(({ transaction, suggestions }) => ({
    transactionId: transaction.id,
    accountId: transaction.accountId,
    bookingDate: transaction.bookingDate,
    amountCents: transaction.amountCents,
    currency: transaction.currency,
    counterpartyName: transaction.counterpartyName,
    remittanceText: transaction.remittanceText,
    platformPayoutHint: looksLikePlatformPayout({ counterpartyName: transaction.counterpartyName, remittanceText: transaction.remittanceText }),
    suggestions: suggestions
      .filter((s) => s.status === "suggested")
      .map((s) => ({
        documentTransactionId: s.id,
        documentId: s.documentId,
        documentTitle: s.documentTitle,
        documentInvoiceNumber: s.documentInvoiceNumber,
        kind: s.kind as MatchedTransactionKind,
        confidence: s.confidence,
        reasons: toReasons(s.reasons),
        explanation: s.explanation,
        status: s.status,
      })),
    possibleDuplicatePayment: suggestions.filter((s) => s.status === "confirmed").length > 1,
  }));
});

/** "Offene Posten" - admin-only page, incoming/outgoing separated, sorted by due date
 * (`listOpenItems`' own `listInvoiceCandidates` query already orders by due date).
 *
 * `from`/`to` are the same optional date range as above, here against the shared document
 * effective date (decisions/0066) - the date the Abschluss's "Belege ohne Zahlung" count
 * uses. Two primitives, for `cache()`'s sake, same as above. */
export const listOpenItemsProjection = cache(async function listOpenItemsProjection(
  workspaceId: string,
  from?: string,
  to?: string,
): Promise<OpenItemsView> {
  const rows = await getRequestServices().payments.listOpenItems(workspaceId, { from, to });
  const incoming = rows.filter((r) => r.document.direction === "incoming");
  const outgoing = rows.filter((r) => r.document.direction === "outgoing");

  const todayIso = new Date().toISOString().slice(0, 10);

  function toView(row: (typeof rows)[number]) {
    return {
      documentId: row.document.id,
      title: row.document.title,
      originalFileName: row.document.originalFileName,
      invoiceNumber: row.document.invoiceNumber,
      contactName: row.contact?.name ?? null,
      totalAmountCents: Math.abs(row.document.totalAmountCents ?? 0),
      openAmountCents: row.openAmountCents,
      currency: row.document.currency ?? "EUR",
      dueDate: row.document.dueDate,
      // Upgraded to `overdue` for display purely from the due date, same as the inbox's own
      // filter (`resolveDisplayStatus`'s own header comment explains why the stored column is
      // not kept live-updated by a clock).
      paymentStatus: resolveDisplayStatus(row.document.paymentStatus, row.document.dueDate, todayIso),
    };
  }

  return {
    incoming: incoming.map(toView),
    outgoing: outgoing.map(toView),
    incomingOpenTotalCents: incoming.reduce((sum, r) => sum + r.openAmountCents, 0),
    outgoingOpenTotalCents: outgoing.reduce((sum, r) => sum + r.openAmountCents, 0),
  };
});

/** F4 (decisions/0026-platform-settlements.md): a `payout_report`/`platform_settlement`
 * document's own decomposition (revenue/fee/refund/payout, via `@/modules/payments`'s
 * `decomposeSettlement`) plus every settlement line's match status - the document detail
 * page's "Importierte Daten" equivalent for a settlement report. Admin-only surface
 * (`finance.read` gates the whole document-detail payment area already), so this returns full
 * data unconditionally - the caller only renders it when `finance.read` is true. `null` for a
 * document that is not a confirmed settlement report at all. */
export const getSettlementReportProjection = cache(async function getSettlementReportProjection(workspaceId: string, documentId: string): Promise<SettlementReportView | null> {
  const services = getRequestServices();
  const doc = await services.documents.getById(workspaceId, documentId);
  if (!doc || (doc.kind !== "payout_report" && doc.kind !== "platform_settlement") || doc.intakeStatus !== "confirmed") return null;

  const lines = await services.accounts.listSettlementLinesForDocument(workspaceId, documentId);
  const transactionIds = lines.map((l) => l.transactionId).filter((id): id is string => id !== null);
  const matchStatuses = await services.payments.getTransactionMatchStatuses(workspaceId, transactionIds);

  // `decomposeSettlement` expects one line per original sale/refund event (its own `feeCents`
  // already riding along) - only `revenue`/`refund` type rows carry that shape here; the
  // separately exploded `fee` lines would double-count the same fee if included too.
  const decompositionInput: SettlementLine[] = lines
    .filter((l) => l.type === "revenue" || l.type === "refund")
    .map((l) => ({
      grossCents: l.grossCents ?? 0,
      feeCents: l.feeCents ?? 0,
      netCents: l.netCents ?? 0,
      invoiceNumber: l.invoiceId,
      description: null,
      customerName: l.customerName,
      bookingDate: l.bookingDate,
    }));
  const payoutCents = lines.filter((l) => l.type === "payout").reduce((sum, l) => sum + (l.netCents ?? 0), 0);
  const decomposition = decomposeSettlement(decompositionInput, payoutCents);

  return {
    documentId,
    platform: doc.platform,
    decomposition,
    lines: lines.map((line) => {
      const match = line.transactionId ? matchStatuses.get(line.transactionId) : undefined;
      let matchStatus: "matched" | "suggested" | "unmatched" = "unmatched";
      if (match) matchStatus = match.status === "confirmed" ? "matched" : "suggested";
      return {
        id: line.id,
        type: line.type,
        grossCents: line.grossCents,
        feeCents: line.feeCents,
        netCents: line.netCents,
        bookingDate: line.bookingDate,
        customerName: line.customerName,
        invoiceId: line.invoiceId,
        payoutId: line.payoutId,
        productName: line.productName,
        matchStatus,
        matchedDocumentId: match?.documentId ?? null,
        matchedDocumentTitle: match?.documentTitle ?? null,
      };
    }),
  };
});

/** The "Start" work-list page's "Zahlungen ohne Beleg" bucket - admin-only (`finance.read`),
 * the same gate "Zuordnung" itself uses; the page only ever calls this for a caller that
 * already passed that check. A real `count(*)` (`countUnmatchedTransactions`), not
 * `listUnmatchedTransactionsProjection(...).length` (P6 review finding A7). */
export const countUnmatchedTransactionsProjection = cache(async function countUnmatchedTransactionsProjection(workspaceId: string): Promise<number> {
  return getRequestServices().payments.countUnmatchedTransactions(workspaceId);
});

/** The "Start" work-list page's "Offene Vorschläge" bucket - admin-only (`finance.read`). */
export const countOpenSuggestionsProjection = cache(async function countOpenSuggestionsProjection(workspaceId: string): Promise<number> {
  return getRequestServices().payments.countOpenSuggestions(workspaceId);
});

/** decisions/0044: the auto-confirm mode shown on "Zuordnung". */
export const getPaymentAutoConfirmModeProjection = cache(async function getPaymentAutoConfirmModeProjection(workspaceId: string) {
  return getRequestServices().payments.getAutoConfirmMode({ workspaceId });
});

/** decisions/0047: names learned for a contact from confirmed payments (finance data). */
export const listContactPaymentAliasesProjection = cache(async function listContactPaymentAliasesProjection(workspaceId: string, contactId: string) {
  return getRequestServices().payments.listAliasesForContact({ workspaceId, contactId });
});
