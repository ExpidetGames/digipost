// Owner: src/modules/closing (decisions/0066-abschluss-check-and-export.md). The link between
// a document and a booking, made readable: who is "D-001", who is "B-012", which of them
// belong together, and how a confirmed counterpart that has no row in this workbook at all is
// named instead of silently dropped.
//
// Pure and synchronous: no I/O, no locale. Every German word arrives as a label from the
// caller, exactly like the rest of this module's core.
//
// Why a counterpart can be missing from the workbook:
//   1. it lies OUTSIDE the exported period - a January booking settling a December invoice is
//      an ordinary, correct pairing, and the December invoice is simply not in this export;
//   2. it lies inside the period but is not a row of this workbook anyway - today only a
//      transaction on a clearing account, which the "Buchungen" sheet deliberately omits (an
//      in-app purchase per 0,79 EUR sale would bury the real bank movements, see
//      `accounts-repository.ts`'s `listForPeriod`).
// Those two are different statements, so they get two different labels. A bare empty cell,
// which is what a plain reference lookup would produce, would be the one wrong answer: it
// would read as "nothing is assigned here".

/** `D-001` on the "Dokumente" sheet. */
export const DOCUMENT_REFERENCE_PREFIX = "D";
/** `B-001` on the "Buchungen" sheet. */
export const TRANSACTION_REFERENCE_PREFIX = "B";

/** Zero-padded to three digits, which covers a small business's year without ever truncating
 * a bigger one: row 1000 is simply `D-1000`. */
export function closingReference(prefix: string, rowIndex: number): string {
  return `${prefix}-${String(rowIndex + 1).padStart(3, "0")}`;
}

/** How several references share one cell. */
const REFERENCE_SEPARATOR = ", ";

export type CrossReferenceCounterpart = {
  /** ISO `YYYY-MM-DD`: the transaction's booking date, or the document's effective date. */
  isoDate: string;
  /** `null` only for a document that carries no amount at all. */
  amountCents: number | null;
  currency: string | null;
};

/** The two ways a counterpart with no "Nr." in this workbook is named. Both are given the
 * counterpart's own date and amount, which is all the advisor needs to find it. */
export type ClosingReferenceLabels = {
  /** Its own date lies outside the exported period. */
  outsidePeriod: (counterpart: CrossReferenceCounterpart) => string;
  /** Its date lies inside the period, but it is not a row of this workbook. */
  notListed: (counterpart: CrossReferenceCounterpart) => string;
};

export type CrossReferenceLinkedTransaction = {
  id: string;
  bookingDate: string;
  amountCents: number;
  currency: string;
  allocatedAmountCents: number;
};

export type CrossReferenceLinkedDocument = {
  id: string;
  effectiveDate: string;
  amountCents: number | null;
  currency: string | null;
  allocatedAmountCents: number;
};

/** The subset of `ClosingDocumentRow` this file reads - a structural subset on purpose, so
 * the whole thing stays testable with a four-line literal. */
export type CrossReferenceDocument = {
  id: string;
  effectiveDate: string;
  totalAmountCents: number | null;
  currency: string | null;
  confirmedTransactions: CrossReferenceLinkedTransaction[];
};

/** The subset of `ClosingTransactionRow` this file reads. */
export type CrossReferenceTransaction = {
  id: string;
  bookingDate: string;
  amountCents: number;
  currency: string;
  confirmedDocuments: CrossReferenceLinkedDocument[];
};

/** One row of the "Zuordnungen" sheet: one confirmed pairing, both sides named. A side with
 * no row in this workbook carries the label instead of a "Nr.", and its own date and amount
 * beside it either way. */
export type ClosingAssignment = {
  documentId: string;
  /** `D-004`, or the label for a document this workbook does not list. */
  documentReference: string;
  /** `null` exactly when the document is not a row of this workbook - the caller has no name
   * for it then. */
  documentRowId: string | null;
  /** ISO. */
  documentDate: string;
  documentAmountCents: number | null;
  transactionId: string;
  transactionReference: string;
  /** ISO. */
  transactionDate: string;
  transactionAmountCents: number;
  /** The currency the pairing is in: the document's own where it has one, else the
   * transaction's (the two agree for every pairing this product can produce). */
  currency: string;
  /** The positive portion of the transaction this document claims. */
  allocatedAmountCents: number;
};

export type ClosingCrossReferences = {
  /** Document id -> `D-001`, for every document this workbook lists. */
  documentReferences: Map<string, string>;
  /** Transaction id -> `B-001`, for every transaction this workbook lists. */
  transactionReferences: Map<string, string>;
  /** Document id -> the "Zugeordnete Buchungen" cell: `B-012, B-031`, a label for a
   * counterpart with no row here, or `""` when the document has no confirmed link at all. */
  transactionsOfDocument: Map<string, string>;
  /** Transaction id -> the "Zugeordnete Belege" cell. */
  documentsOfTransaction: Map<string, string>;
  /** Every confirmed pairing that touches the period, documents' sheet order first, then the
   * pairings only the transactions' side knows about (their document is not listed here). */
  assignments: ClosingAssignment[];
};

export type ClosingPeriodBounds = { from: string; to: string };

function isInPeriod(isoDate: string, period: ClosingPeriodBounds): boolean {
  return isoDate >= period.from && isoDate <= period.to;
}

function describe(counterpart: CrossReferenceCounterpart, period: ClosingPeriodBounds, labels: ClosingReferenceLabels): string {
  return isInPeriod(counterpart.isoDate, period) ? labels.notListed(counterpart) : labels.outsidePeriod(counterpart);
}

export function buildClosingCrossReferences(input: {
  period: ClosingPeriodBounds;
  documents: CrossReferenceDocument[];
  transactions: CrossReferenceTransaction[];
  labels: ClosingReferenceLabels;
}): ClosingCrossReferences {
  const { period, documents, transactions, labels } = input;

  const documentReferences = new Map(documents.map((document, index) => [document.id, closingReference(DOCUMENT_REFERENCE_PREFIX, index)]));
  const transactionReferences = new Map(
    transactions.map((transaction, index) => [transaction.id, closingReference(TRANSACTION_REFERENCE_PREFIX, index)]),
  );

  const transactionsOfDocument = new Map<string, string>();
  const documentsOfTransaction = new Map<string, string>();
  const assignments: ClosingAssignment[] = [];
  const seen = new Set<string>();

  for (const document of documents) {
    const cells = document.confirmedTransactions.map(
      (link) =>
        transactionReferences.get(link.id) ??
        describe({ isoDate: link.bookingDate, amountCents: link.amountCents, currency: link.currency }, period, labels),
    );
    transactionsOfDocument.set(document.id, cells.join(REFERENCE_SEPARATOR));

    document.confirmedTransactions.forEach((link, index) => {
      seen.add(`${document.id}|${link.id}`);
      assignments.push({
        documentId: document.id,
        documentReference: documentReferences.get(document.id)!,
        documentRowId: document.id,
        documentDate: document.effectiveDate,
        documentAmountCents: document.totalAmountCents,
        transactionId: link.id,
        transactionReference: cells[index]!,
        transactionDate: link.bookingDate,
        transactionAmountCents: link.amountCents,
        currency: document.currency ?? link.currency,
        allocatedAmountCents: link.allocatedAmountCents,
      });
    });
  }

  for (const transaction of transactions) {
    const cells = transaction.confirmedDocuments.map(
      (link) =>
        documentReferences.get(link.id) ??
        describe({ isoDate: link.effectiveDate, amountCents: link.amountCents, currency: link.currency }, period, labels),
    );
    documentsOfTransaction.set(transaction.id, cells.join(REFERENCE_SEPARATOR));

    transaction.confirmedDocuments.forEach((link, index) => {
      // Already emitted from the document's own side, with the same two ids.
      if (seen.has(`${link.id}|${transaction.id}`)) return;
      seen.add(`${link.id}|${transaction.id}`);
      assignments.push({
        documentId: link.id,
        documentReference: cells[index]!,
        documentRowId: documentReferences.has(link.id) ? link.id : null,
        documentDate: link.effectiveDate,
        documentAmountCents: link.amountCents,
        transactionId: transaction.id,
        transactionReference: transactionReferences.get(transaction.id)!,
        transactionDate: transaction.bookingDate,
        transactionAmountCents: transaction.amountCents,
        currency: link.currency ?? transaction.currency,
        allocatedAmountCents: link.allocatedAmountCents,
      });
    });
  }

  return { documentReferences, transactionReferences, transactionsOfDocument, documentsOfTransaction, assignments };
}
