import "server-only";

/**
 * Owner: src/modules/closing (decisions/0066-abschluss-check-and-export.md). Read models for
 * `/dashboard/abschluss` and `GET /api/closing/export`, published through `server.ts` like
 * every other module's `server/read-models.ts`.
 *
 * There is no redaction decision to make here, unlike `@/modules/payments`': the whole
 * Abschluss is admin-only (`finance.read`), so a caller that reaches these functions at all
 * is allowed to see every amount in them. The gate itself lives at the page
 * (`access.permissions.includes(PERMISSIONS.financeRead)` then `notFound()`) and at the
 * route (`workspaceAccess(PERMISSIONS.financeRead)`), exactly like the rest of
 * `/dashboard/finance/**`.
 */
import { getRequestServices } from "@/persistence/composition/request-services";
import type { ClosingDocumentRow, ClosingTransactionRow } from "@/persistence/repositories/contracts";

import type { ClosingPeriod } from "../core/period";
import { buildClosingReport, type ClosingReport } from "../core/report";

/** The completeness check. Not `cache`d per request: there is exactly one call per render,
 * and memoizing would only add a cache-key concern for the period object - the same reason
 * `listDocumentsProjection` is not cached either. */
export async function getClosingReportProjection(workspaceId: string, period: ClosingPeriod): Promise<ClosingReport> {
  const counts = await getRequestServices().closing.getPeriodCounts(workspaceId, period.from, period.to);
  return buildClosingReport(
    period,
    {
      unmatchedTransactions: counts.transactions.unmatched,
      documentsWithoutPayment: counts.documents.openOrOverduePayments,
      pendingConfirmation: counts.documents.pendingIntakeConfirmation,
      failedProcessing: counts.documents.failedProcessing,
      openSuggestions: counts.openSuggestions,
    },
    { documents: counts.documents.total, transactions: counts.transactions.total },
  );
}

export type ClosingExportData = {
  documents: ClosingDocumentRow[];
  transactions: ClosingTransactionRow[];
};

/** Both sheets' source rows. Read in full before the response starts streaming - these are
 * the index, not the payload (the payload is the documents' own bytes, fetched one at a time
 * while the archive streams). */
export async function getClosingExportData(workspaceId: string, period: ClosingPeriod): Promise<ClosingExportData> {
  const closing = getRequestServices().closing;
  const [documents, transactions] = await Promise.all([
    closing.listPeriodDocuments(workspaceId, period.from, period.to),
    closing.listPeriodTransactions(workspaceId, period.from, period.to),
  ]);
  return { documents, transactions };
}

/**
 * The document-file reader the archive pulls through, resolved ONCE before the response
 * starts streaming. `getRequestServices()` is a React `cache()` call and is only reliable
 * inside the request's own render/handler scope, so the use-case object is captured here
 * rather than looked up again from inside the streaming generator.
 *
 * Reuses `DocumentUseCases.getFileForDownload` verbatim (the same read
 * `GET /api/documents/[id]/file` serves): the searchable PDF when processing produced one,
 * otherwise the original upload, and a `findById` scoped to this workspace per file - so a
 * document id that does not belong to the caller's workspace yields nothing, even though
 * every id here came from this module's own period query in the first place.
 */
export function createClosingDocumentFileReader(): (workspaceId: string, documentId: string) => Promise<Uint8Array | null> {
  const documents = getRequestServices().documents;
  return async (workspaceId, documentId) => {
    const file = await documents.getFileForDownload(workspaceId, documentId);
    return file?.bytes ?? null;
  };
}
