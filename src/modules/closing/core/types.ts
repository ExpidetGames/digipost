// Owner: src/modules/closing (decisions/0066-abschluss-check-and-export.md). The two shapes
// the export's workbook is written from. Both are already LOCALIZED and already resolved -
// the German labels, the generated name, and the ZIP path are decided before a row reaches
// the workbook writer, so that writer never needs translations or business rules of its own.

export type ClosingDocumentSheetRow = {
  /** `D-001`, this document's own number inside this workbook - what the "Buchungen" and
   * "Zuordnungen" sheets point at (`core/cross-references.ts`). */
  reference: string;
  /** The effective date (decisions/0058/0060/0061), as a real date so Excel sorts and
   * filters it as one. */
  date: Date;
  /** The generated name (decisions/0059-generated-document-names.md), date half included. */
  name: string;
  counterparty: string;
  /** The document kind, translated ("Eingangsrechnung"). */
  kind: string;
  /** "Eingang"/"Ausgang"/"Unbekannt". */
  direction: string;
  /** In the document's own currency, as a real number so Excel can sum the column. `null`
   * when the document carries no amount at all (an empty cell, never a `0`). */
  amount: number | null;
  currency: string;
  invoiceNumber: string;
  /** The effective payment status, translated. */
  paymentStatus: string;
  /** WHICH bookings settle this document: `B-012, B-031`. A confirmed counterpart with no row
   * in this workbook is named by date and amount instead (decisions/0066); empty when there
   * is no confirmed link at all. */
  matchedTransactions: string;
  /** The path of this document's own file inside the ZIP, exactly as the entry is written:
   * `ausgangsrechnungen/...` for a document the workspace issued, `belege/...` otherwise. */
  file: string;
};

export type ClosingTransactionSheetRow = {
  /** `B-001`. */
  reference: string;
  date: Date;
  account: string;
  /** Signed, in the transaction's currency, as a real number. */
  amount: number;
  currency: string;
  counterparty: string;
  purpose: string;
  /** WHICH documents settle this booking, the mirror of `matchedTransactions` above. */
  matchedDocuments: string;
  /** "zugeordnet" / "kein Beleg nötig" / "offen", already translated. */
  status: string;
};

/** One row of the "Zuordnungen" sheet: one confirmed document-to-booking pairing that touches
 * the period, both sides named, so the pairing can be read without jumping between the other
 * two sheets (decisions/0066). A side with no row in this workbook carries its label
 * ("außerhalb des Zeitraums (14.12.2025, 23,00 EUR)") in place of a "Nr."; its date and
 * amount are real values either way. */
export type ClosingAssignmentSheetRow = {
  documentReference: string;
  documentDate: Date;
  /** The generated document name, empty for a document this workbook does not list (there is
   * no row here to read a name from - the reference beside it says so). */
  document: string;
  documentAmount: number | null;
  currency: string;
  transactionReference: string;
  transactionDate: Date;
  transactionAmount: number;
  /** The portion of the booking this document claims. */
  allocatedAmount: number;
};
