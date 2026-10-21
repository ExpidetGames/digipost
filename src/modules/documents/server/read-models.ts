import "server-only";

import { cache } from "react";

import type { DocumentKind } from "@/modules/intake";
import { getRequestServices } from "@/persistence/composition/request-services";
import type { DocumentDirection, DocumentStatus } from "@/persistence/repositories/contracts";

import { DOCUMENTS_PAGE_SIZE, type DocumentSort } from "../core/schemas";
import type { DocumentDetailView, DocumentListItem, DocumentListView, IntakeFingerprintOption } from "../core/types";

export type ListDocumentsParams = {
  q?: string;
  status?: DocumentStatus;
  direction?: DocumentDirection;
  /** decisions/0022-intake-wiring.md's inbox kind filter. */
  kind?: DocumentKind;
  /** F3b (decisions/0025-payment-matching-wiring.md): "offen/überfällig/bezahlt". */
  paymentStatus?: "open" | "overdue" | "paid";
  /** decisions/0058-inbox-sorts-by-the-document-s-own-date.md. */
  sort?: DocumentSort;
  /** The "Start" work-list page's "Wartet auf Bestätigung" link. */
  intakeStatus?: "pending_confirmation";
  /** decisions/0066-abschluss-check-and-export.md: the inbox's date range, inclusive ISO
   * `YYYY-MM-DD` bounds on the document's EFFECTIVE date (the same date the list is sorted
   * by and the Abschluss counts by). Either may be absent. */
  from?: string;
  to?: string;
  page: number;
};

/** The `/dashboard` (Posteingang) read model. Not `cache`d per request the way the other
 * read models here are: the same page renders this with different search-param-derived
 * filters within one request only in theory (there is exactly one call per request in
 * practice), so memoizing would add a cache key concern for no real benefit. */
export async function listDocumentsProjection(workspaceId: string, params: ListDocumentsParams): Promise<DocumentListView> {
  const result = await getRequestServices().documents.list(workspaceId, {
    q: params.q,
    status: params.status,
    direction: params.direction,
    kind: params.kind,
    paymentStatus: params.paymentStatus,
    sort: params.sort,
    intakeStatus: params.intakeStatus,
    from: params.from,
    to: params.to,
    page: params.page,
    pageSize: DOCUMENTS_PAGE_SIZE,
  });

  const items: DocumentListItem[] = result.items.map((doc) => ({
    id: doc.id,
    title: doc.title,
    originalFileName: doc.originalFileName,
    sender: doc.sender,
    counterpartyName: doc.counterpartyName,
    reportPeriod: doc.reportPeriod,
    statementLastBooking: doc.statementLastBooking,
    platform: doc.platform,
    status: doc.status,
    createdAt: doc.createdAt.toISOString(),
    documentDate: doc.documentDate,
    direction: doc.direction,
    totalAmountCents: doc.totalAmountCents,
    currency: doc.currency,
    kind: doc.kind,
    intakeStatus: doc.intakeStatus,
    dueDate: doc.dueDate,
    paymentStatus: doc.paymentStatus,
    paidAt: doc.paidAt ? doc.paidAt.toISOString() : null,
  }));

  return { items, hasMore: result.hasMore, page: params.page };
}

/** `null` when the document does not exist in this workspace - the `[id]` page 404s. */
export const getDocumentDetailProjection = cache(
  async (workspaceId: string, id: string): Promise<DocumentDetailView | null> => {
    const services = getRequestServices();
    const doc = await services.documents.getById(workspaceId, id);
    if (!doc) return null;
    const contacts = await services.documents.getLinkedContacts(workspaceId, id);
    const possibleDuplicateOf = await services.documents.getPossibleDuplicateInvoice(workspaceId, id);
    return {
      id: doc.id,
      title: doc.title,
      originalFileName: doc.originalFileName,
      mimeType: doc.mimeType,
      sender: doc.sender,
      documentDate: doc.documentDate,
      createdAt: doc.createdAt.toISOString(),
      uploadedByEmail: doc.uploadedByEmail,
      status: doc.status,
      errorCode: doc.errorCode,
      ocrText: doc.ocrText,
      summary: doc.summary,
      direction: doc.direction,
      invoiceNumber: doc.invoiceNumber,
      totalAmountCents: doc.totalAmountCents,
      currency: doc.currency,
      dueDate: doc.dueDate,
      paymentIban: doc.paymentIban,
      paymentReference: doc.paymentReference,
      paidNote: doc.paidNote,
      contacts,
      kind: doc.kind,
      platform: doc.platform,
      intakeStatus: doc.intakeStatus,
      intakeResult: doc.intakeResult,
      possibleDuplicateOf,
      paymentStatus: doc.paymentStatus,
      paidAt: doc.paidAt ? doc.paidAt.toISOString() : null,
    };
  },
);

/** `/dashboard/settings/intake`'s admin-only list (F1b). */
export const listIntakeFingerprintsProjection = cache(async (workspaceId: string): Promise<IntakeFingerprintOption[]> => {
  const rows = await getRequestServices().documents.listIntakeFingerprints(workspaceId);
  return rows.map((row) => ({
    id: row.id,
    documentKind: row.documentKind as DocumentKind,
    platform: row.platform,
    confirmedAt: row.confirmedAt.toISOString(),
    lastUsedAt: row.lastUsedAt.toISOString(),
    useCount: row.useCount,
  }));
});

/** The confirmation UI's own read model - identical to `getDocumentDetailProjection` today,
 * kept as a distinct named export so the confirmation panel's data dependency is explicit and
 * can diverge later without touching the general detail view. */
export const getDocumentIntakeConfirmationProjection = getDocumentDetailProjection;

// --- The "Start" work-list page's own bucket counts (member-level: every member sees these
// three, no `finance.read` gate). Each is a real SQL `count(*)`, not `list(...).items.length`
// (P6 review finding A7, `DocumentRepository.countByWorkspace`'s own header comment). ---

export const countPendingIntakeConfirmationProjection = cache(async (workspaceId: string): Promise<number> => {
  return getRequestServices().documents.countPendingIntakeConfirmation(workspaceId);
});

export const countFailedProjection = cache(async (workspaceId: string): Promise<number> => {
  return getRequestServices().documents.countFailed(workspaceId);
});

export const countOverduePaymentsProjection = cache(async (workspaceId: string): Promise<number> => {
  return getRequestServices().documents.countOverduePayments(workspaceId);
});

