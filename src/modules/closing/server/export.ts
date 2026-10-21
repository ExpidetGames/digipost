import "server-only";

/**
 * Owner: src/modules/closing (decisions/0066-abschluss-check-and-export.md). Assembles the
 * export: reads the period's two row sets, decides every document's file name inside the
 * archive ONCE (so the workbook's "Datei" column and the actual entry are the same string by
 * construction), writes `uebersicht.xlsx`, and returns the streaming body.
 *
 * Every German word arrives as a label from the caller (the route handler, which owns
 * next-intl) - this file formats, it does not translate.
 */
import type { ClosingDocumentRow, ClosingTransactionRow, DocumentDirection } from "@/persistence/repositories/contracts";

import { buildClosingCrossReferences, type ClosingAssignment, type ClosingReferenceLabels } from "../core/cross-references";
import { assignBelegFileNames, fileExtensionFor, OVERVIEW_FILE_NAME } from "../core/file-names";
import { closingDocumentName, closingDocumentNameSource, type ClosingNameLabels } from "../core/document-name";
import type { ClosingPeriod } from "../core/period";
import type { ClosingAssignmentSheetRow, ClosingDocumentSheetRow, ClosingTransactionSheetRow } from "../core/types";

import { createClosingArchiveStream, type ClosingArchiveEntry } from "./export-archive";
import { buildClosingOverviewWorkbook, type ClosingSheetColumn } from "./export-workbook";
import { createClosingDocumentFileReader, getClosingExportData } from "./read-models";

export type ClosingExportLabels = {
  documentsSheetName: string;
  transactionsSheetName: string;
  assignmentsSheetName: string;
  documentColumns: Record<keyof ClosingDocumentSheetRow, string>;
  transactionColumns: Record<keyof ClosingTransactionSheetRow, string>;
  assignmentColumns: Record<keyof ClosingAssignmentSheetRow, string>;
  /** How a confirmed counterpart with no "Nr." in this workbook is named
   * (`core/cross-references.ts`). */
  reference: ClosingReferenceLabels;
  /** `DocumentKinds.<kind>`. */
  documentKind: (kind: string) => string;
  /** `Inbox.directionValues.<direction>`; `null` has no label and stays an empty cell. */
  direction: (direction: DocumentDirection) => string;
  /** `Payments.statusValues.<status>`. */
  paymentStatus: (status: string) => string;
  /** The "Buchungen" sheet's own three-valued status column. */
  transactionStatus: { matched: string; noDocumentNeeded: string; open: string };
  /** Everything the generated document name needs (decisions/0059). */
  name: ClosingNameLabels;
};

// The key order of each record below is the sheet's column order.
const DOCUMENT_COLUMN_WIDTHS: Record<keyof ClosingDocumentSheetRow, number> = {
  reference: 8,
  date: 12,
  name: 40,
  counterparty: 30,
  kind: 20,
  direction: 12,
  amount: 14,
  currency: 10,
  invoiceNumber: 20,
  paymentStatus: 18,
  matchedTransactions: 28,
  file: 50,
};

const TRANSACTION_COLUMN_WIDTHS: Record<keyof ClosingTransactionSheetRow, number> = {
  reference: 8,
  date: 12,
  account: 24,
  amount: 14,
  currency: 10,
  counterparty: 30,
  purpose: 50,
  matchedDocuments: 28,
  status: 20,
};

const ASSIGNMENT_COLUMN_WIDTHS: Record<keyof ClosingAssignmentSheetRow, number> = {
  documentReference: 28,
  documentDate: 12,
  document: 40,
  documentAmount: 14,
  currency: 10,
  transactionReference: 28,
  transactionDate: 12,
  transactionAmount: 14,
  allocatedAmount: 16,
};

/** An ISO `YYYY-MM-DD` as a real date. Noon UTC, not midnight: a cell read back in a
 * timezone behind UTC would otherwise show the previous day. */
function isoToDate(iso: string): Date {
  return new Date(`${iso}T12:00:00Z`);
}

function documentColumnType(key: keyof ClosingDocumentSheetRow): ClosingSheetColumn<ClosingDocumentSheetRow>["type"] {
  if (key === "date") return "date";
  if (key === "amount" || key === "matchedTransactions") return "number";
  return "text";
}

function transactionColumnType(key: keyof ClosingTransactionSheetRow): ClosingSheetColumn<ClosingTransactionSheetRow>["type"] {
  if (key === "date") return "date";
  if (key === "amount") return "number";
  return "text";
}

function assignmentColumnType(key: keyof ClosingAssignmentSheetRow): ClosingSheetColumn<ClosingAssignmentSheetRow>["type"] {
  if (key === "documentDate" || key === "transactionDate") return "date";
  if (key === "documentAmount" || key === "transactionAmount" || key === "allocatedAmount") return "number";
  return "text";
}

function documentColumns(labels: ClosingExportLabels): ClosingSheetColumn<ClosingDocumentSheetRow>[] {
  return (Object.keys(DOCUMENT_COLUMN_WIDTHS) as (keyof ClosingDocumentSheetRow)[]).map((key) => ({
    header: labels.documentColumns[key],
    width: DOCUMENT_COLUMN_WIDTHS[key],
    type: documentColumnType(key),
    value: (row) => row[key],
  }));
}

function transactionColumns(labels: ClosingExportLabels): ClosingSheetColumn<ClosingTransactionSheetRow>[] {
  return (Object.keys(TRANSACTION_COLUMN_WIDTHS) as (keyof ClosingTransactionSheetRow)[]).map((key) => ({
    header: labels.transactionColumns[key],
    width: TRANSACTION_COLUMN_WIDTHS[key],
    type: transactionColumnType(key),
    value: (row) => row[key],
  }));
}

function assignmentColumns(labels: ClosingExportLabels): ClosingSheetColumn<ClosingAssignmentSheetRow>[] {
  return (Object.keys(ASSIGNMENT_COLUMN_WIDTHS) as (keyof ClosingAssignmentSheetRow)[]).map((key) => ({
    header: labels.assignmentColumns[key],
    width: ASSIGNMENT_COLUMN_WIDTHS[key],
    type: assignmentColumnType(key),
    value: (row) => row[key],
  }));
}

function toDocumentSheetRow(
  document: ClosingDocumentRow,
  reference: string,
  name: string,
  matchedTransactions: string,
  file: string,
  labels: ClosingExportLabels,
): ClosingDocumentSheetRow {
  return {
    reference,
    date: isoToDate(document.effectiveDate),
    // The generated name (decisions/0059), decided once per document and shared with the
    // "Zuordnungen" sheet so one document is never called two different things.
    name,
    counterparty: document.counterpartyName ?? document.sender ?? "",
    kind: labels.documentKind(document.kind),
    direction: document.direction ? labels.direction(document.direction) : "",
    amount: document.totalAmountCents === null ? null : document.totalAmountCents / 100,
    currency: document.totalAmountCents === null ? "" : (document.currency ?? "EUR"),
    invoiceNumber: document.invoiceNumber ?? "",
    paymentStatus: labels.paymentStatus(document.paymentStatus),
    matchedTransactions,
    file,
  };
}

/** "zugeordnet" wins over "kein Beleg nötig": a transaction that actually has a confirmed
 * document is settled, whatever anyone marked earlier. */
function transactionStatus(transaction: ClosingTransactionRow, labels: ClosingExportLabels): string {
  if (transaction.confirmedDocuments.length > 0) return labels.transactionStatus.matched;
  if (transaction.noDocumentNeeded) return labels.transactionStatus.noDocumentNeeded;
  return labels.transactionStatus.open;
}

function toTransactionSheetRow(
  transaction: ClosingTransactionRow,
  reference: string,
  matchedDocuments: string,
  labels: ClosingExportLabels,
): ClosingTransactionSheetRow {
  return {
    reference,
    date: isoToDate(transaction.bookingDate),
    account: transaction.accountName,
    amount: transaction.amountCents / 100,
    currency: transaction.currency,
    counterparty: transaction.counterpartyName ?? "",
    purpose: transaction.remittanceText ?? "",
    matchedDocuments,
    status: transactionStatus(transaction, labels),
  };
}

/** The "Zuordnungen" sheet. `documentName` resolves to `""` for a pairing whose document this
 * workbook does not list - there is no row here to read a name from, and the reference beside
 * it already says which document is meant. */
function toAssignmentSheetRow(assignment: ClosingAssignment, documentName: (documentId: string | null) => string): ClosingAssignmentSheetRow {
  return {
    documentReference: assignment.documentReference,
    documentDate: isoToDate(assignment.documentDate),
    document: documentName(assignment.documentRowId),
    documentAmount: assignment.documentAmountCents === null ? null : assignment.documentAmountCents / 100,
    currency: assignment.currency,
    transactionReference: assignment.transactionReference,
    transactionDate: isoToDate(assignment.transactionDate),
    transactionAmount: assignment.transactionAmountCents / 100,
    allocatedAmount: assignment.allocatedAmountCents / 100,
  };
}

/** `abschluss-2026-01.zip` / `abschluss-2026.zip`. */
export function closingExportFileName(period: ClosingPeriod): string {
  return `abschluss-${period.value}.zip`;
}

export type ClosingExport = {
  fileName: string;
  body: ReadableStream<Uint8Array>;
};

export async function createClosingExport(workspaceId: string, period: ClosingPeriod, labels: ClosingExportLabels): Promise<ClosingExport> {
  const { documents, transactions } = await getClosingExportData(workspaceId, period);

  // One decision, two consumers: the sheet's "Datei" column and the archive entry below are
  // both read out of this same map, so they cannot drift apart (decisions/0066). The folder
  // is part of that one decision too (`ausgangsrechnungen/` for a document the workspace
  // issued itself, `belege/` for everything else).
  const filesById = assignBelegFileNames(
    documents.map((document) => ({
      id: document.id,
      direction: document.direction,
      effectiveDate: document.effectiveDate,
      name: closingDocumentNameSource(document, labels.name),
      // A searchable PDF, when one exists, is always a PDF whatever the original was; only
      // the fallback keeps the original upload's own media type (a statement stays .xml or
      // .mt940, an app-store report .csv).
      extension: document.searchablePdfKey ? "pdf" : fileExtensionFor(document.mimeType, document.originalFileName),
    })),
  );

  // Likewise one decision, three consumers: both sheets' cross-reference columns and the
  // "Zuordnungen" sheet are all read out of this one result, so a "Nr." can never mean two
  // different rows (decisions/0066).
  const crossReferences = buildClosingCrossReferences({
    period: { from: period.from, to: period.to },
    documents,
    transactions,
    labels: labels.reference,
  });
  const documentNames = new Map(documents.map((document) => [document.id, closingDocumentName(document, labels.name)]));

  const overview = await buildClosingOverviewWorkbook(
    {
      name: labels.documentsSheetName,
      columns: documentColumns(labels),
      rows: documents.map((document) =>
        toDocumentSheetRow(
          document,
          crossReferences.documentReferences.get(document.id) ?? "",
          documentNames.get(document.id) ?? "",
          crossReferences.transactionsOfDocument.get(document.id) ?? "",
          filesById.get(document.id) ?? "",
          labels,
        ),
      ),
    },
    {
      name: labels.transactionsSheetName,
      columns: transactionColumns(labels),
      rows: transactions.map((transaction) =>
        toTransactionSheetRow(
          transaction,
          crossReferences.transactionReferences.get(transaction.id) ?? "",
          crossReferences.documentsOfTransaction.get(transaction.id) ?? "",
          labels,
        ),
      ),
    },
    {
      name: labels.assignmentsSheetName,
      columns: assignmentColumns(labels),
      rows: crossReferences.assignments.map((assignment) =>
        toAssignmentSheetRow(assignment, (documentId) => (documentId === null ? "" : (documentNames.get(documentId) ?? ""))),
      ),
    },
  );

  // Captured before the response starts streaming - see `createClosingDocumentFileReader`.
  const readDocumentFile = createClosingDocumentFileReader();

  async function* entries(): AsyncIterable<ClosingArchiveEntry> {
    yield { name: OVERVIEW_FILE_NAME, bytes: overview };
    for (const document of documents) {
      const name = filesById.get(document.id);
      if (!name) continue;
      const bytes = await readDocumentFile(workspaceId, document.id);
      // A document whose object has gone missing from storage is skipped rather than
      // failing the whole export - the workbook row still names it, and the advisor can see
      // which file is absent. Nothing else in this product deletes an object behind a row,
      // so this is a corruption guard, not an expected path.
      if (!bytes) continue;
      yield { name, bytes };
    }
  }

  return { fileName: closingExportFileName(period), body: createClosingArchiveStream(entries) };
}
