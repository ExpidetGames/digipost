// Owner: src/modules/closing (decisions/0066-abschluss-check-and-export.md). The export names
// a document exactly the way the inbox does (decisions/0059-generated-document-names.md): the
// generated name, never the file name someone happened to drag in. `documentDisplayName` /
// `documentNameSource` from `@/modules/documents` make that decision; this file only resolves
// the two inputs that depend on the document's own type - the type label (an app-store
// report's platform, a bank statement's kind) and which date the name's second half shows.
//
// Pure: every label and every formatter is injected by the caller, which owns the locale.
import { documentDisplayName, documentNameSource } from "@/modules/documents";
import type { DocumentDirection } from "@/persistence/repositories/contracts";

/** Only the fields a name is built from - a structural subset of the repository's own
 * `ClosingDocumentRow`, so this stays testable with a four-line literal. */
export type ClosingNameableDocument = {
  kind: string;
  platform: string | null;
  direction: DocumentDirection | null;
  counterpartyName: string | null;
  sender: string | null;
  originalFileName: string;
  documentDate: string | null;
  /** decisions/0060-app-store-reports-are-named-by-their-period.md: `YYYY-MM`. */
  reportPeriod: string | null;
  /** decisions/0061-a-statement-is-dated-by-its-last-booking.md: ISO `YYYY-MM-DD`. */
  statementLastBooking: string | null;
  /** The shared effective date (decisions/0058/0060/0061) - the fallback date half for a
   * document that carries no own date, and the date column of its export row. */
  effectiveDate: string;
};

export type ClosingNameLabels = {
  /** "Apple", "Google", ... for a settlement platform. */
  platformLabel: (platform: string) => string;
  /** "Kontoauszug". */
  bankStatementLabel: string;
  /** "Eingang 14.01.2026" - how a document with no own date is dated. */
  receivedOnLabel: (formattedDate: string) => string;
  /** ISO `YYYY-MM-DD` -> "14.01.2026". */
  formatDate: (isoDate: string) => string;
  /** `YYYY-MM` -> "November 2025". */
  formatMonth: (isoMonth: string) => string;
};

type Resolved = { typeLabel: string | null; formattedDate: string };

function resolve(document: ClosingNameableDocument, labels: ClosingNameLabels): Resolved {
  // decisions/0060: an Apple or Google report has no document date and no counterparty - it
  // covers a month, and is named after the platform and that month.
  if (document.platform !== null && document.reportPeriod !== null) {
    return { typeLabel: labels.platformLabel(document.platform), formattedDate: labels.formatMonth(document.reportPeriod) };
  }
  // decisions/0061: a bank statement is named after its kind and dated by its last booking.
  if (document.kind === "bank_statement" && document.statementLastBooking !== null) {
    return { typeLabel: labels.bankStatementLabel, formattedDate: labels.formatDate(document.statementLastBooking) };
  }
  if (document.documentDate) return { typeLabel: null, formattedDate: labels.formatDate(document.documentDate) };
  return { typeLabel: null, formattedDate: labels.receivedOnLabel(labels.formatDate(document.effectiveDate)) };
}

/** The full generated name, date half included: "Bauwerk Generalbau, 14.01.2026". The
 * workbook's "Name" column. */
export function closingDocumentName(document: ClosingNameableDocument, labels: ClosingNameLabels): string {
  const { typeLabel, formattedDate } = resolve(document, labels);
  return documentDisplayName({
    typeLabel,
    counterpartyName: document.counterpartyName,
    sender: document.sender,
    direction: document.direction,
    originalFileName: document.originalFileName,
    formattedDate,
  });
}

/** The name WITHOUT its date half ("Bauwerk Generalbau") - what the ZIP file name is
 * slugified from, since the file name already carries the date as its own first component. */
export function closingDocumentNameSource(document: ClosingNameableDocument, labels: ClosingNameLabels): string {
  const { typeLabel } = resolve(document, labels);
  return documentNameSource({
    typeLabel,
    counterpartyName: document.counterpartyName,
    sender: document.sender,
    direction: document.direction,
    originalFileName: document.originalFileName,
    formattedDate: "",
  });
}
