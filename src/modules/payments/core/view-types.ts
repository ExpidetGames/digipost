// Owner: src/modules/payments (F3b, decisions/0025-payment-matching-wiring.md). Plain,
// already-redacted view shapes for the UI - the server read-models
// (`server/read-models.ts`) are the ONLY place that decides whether a viewer's
// `finance.read` permission allows amount/counterparty fields to be populated at all
// (never merely hidden in the UI: an unauthorized viewer must never even receive the
// data in a Server Component's props, since those are serialized to the client bundle).
import type { SettlementLineType } from "@/modules/accounts";
import type { SettlementPlatform } from "@/modules/intake";

import type { DocumentTransactionStatus, MatchedBy, MatchKind, MatchReasonCode, PaymentStatus } from "./types";
import type { SettlementDecomposition } from "./settlement";

/** One matched (confirmed) transaction against a document - `amountCents`/`currency`/
 * `counterpartyName` are `undefined` for a viewer without `finance.read` (a member sees only
 * that a match exists and when it was booked). */
export type MatchedTransactionView = {
  documentTransactionId: string;
  transactionId: string;
  bookingDate: string;
  kind: MatchKind;
  matchedBy: MatchedBy;
  amountCents?: number;
  currency?: string | null;
  counterpartyName?: string | null;
};

/** One suggestion awaiting a decision - only ever populated for a `finance.read` viewer
 * (`getDocumentPaymentSectionProjection` returns an empty array otherwise): reviewing a
 * suggestion inherently means seeing the transaction it proposes, which is exactly the
 * information a member must never receive. */
export type SuggestionView = {
  documentTransactionId: string;
  transactionId: string;
  bookingDate: string;
  amountCents: number;
  currency: string | null;
  counterpartyName: string | null;
  kind: MatchKind;
  confidence: number;
  reasons: MatchReasonCode[];
  explanation: string | null;
};

export type DocumentPaymentSection = {
  paymentStatus: PaymentStatus;
  paidAt: string | null;
  matchedTransactions: MatchedTransactionView[];
  suggestions: SuggestionView[];
  /** The underlying invoice this reminder references is already fully paid - the "Diese
   * Rechnung wurde bereits am ... bezahlt" callout, safe to show to every member (it names a
   * date, never an amount or a counterparty). `null` for a non-`reminder`-kind document, or
   * one whose underlying invoice cannot be resolved or is not yet paid. */
  reminderAlreadyPaidAt: string | null;
  /** `true` when 2+ transactions are confirmed against this document whose allocated amounts
   * together exceed its total - a possible duplicate/accidental double payment. A boolean
   * flag only (never the transactions themselves) is safe to show to every member. */
  possibleDuplicatePayment: boolean;
};

/** One row of "Zuordnung"'s unmatched-transaction list, with its own top suggestions
 * (admin-only page, so no redaction needed here - `finance.read` is already required to reach
 * it at all). */
export type UnmatchedTransactionView = {
  transactionId: string;
  accountId: string;
  bookingDate: string;
  amountCents: number;
  currency: string | null;
  counterpartyName: string | null;
  remittanceText: string | null;
  /** F4 (decisions/0026-platform-settlements.md): the platform this bank transaction's own
   * counterparty name/remittance text names, when any - `@/modules/payments`'s
   * `looksLikePlatformPayout`. Drives "Umbuchung von <Plattform>" instead of the generic
   * "keine Vorschläge" state when a payout has no settlement report yet
   * (decisions/0026's own "period has no report yet" scope note - this is purely informational,
   * never a suggestion a human confirms). */
  platformPayoutHint: SettlementPlatform | null;
  suggestions: Array<{
    documentTransactionId: string;
    documentId: string;
    documentTitle: string | null;
    documentInvoiceNumber: string | null;
    kind: MatchKind;
    confidence: number;
    reasons: MatchReasonCode[];
    explanation: string | null;
    status: DocumentTransactionStatus;
  }>;
  possibleDuplicatePayment: boolean;
};

export type OpenItemView = {
  documentId: string;
  title: string | null;
  originalFileName: string;
  invoiceNumber: string | null;
  contactName: string | null;
  totalAmountCents: number;
  openAmountCents: number;
  currency: string;
  dueDate: string | null;
  paymentStatus: PaymentStatus;
};

export type OpenItemsView = {
  incoming: OpenItemView[];
  outgoing: OpenItemView[];
  incomingOpenTotalCents: number;
  outgoingOpenTotalCents: number;
};

/** F4 (decisions/0026-platform-settlements.md): one settlement line on a `payout_report`/
 * `platform_settlement` document's own decomposition - admin-only surface (`finance.read`),
 * so no redaction branch here (unlike `SuggestionView`/`MatchedTransactionView` above). */
export type SettlementLineView = {
  id: string;
  type: SettlementLineType;
  grossCents: number | null;
  feeCents: number | null;
  netCents: number | null;
  bookingDate: string | null;
  customerName: string | null;
  invoiceId: string | null;
  payoutId: string | null;
  productName: string | null;
  /** `"matched"` (a `confirmed` `document_transactions` row exists for this line's own
   * transaction), `"suggested"` (awaiting a human decision), or `"unmatched"` - only ever
   * meaningful for a `revenue` line ("Rechnung fehlt" is shown for `"unmatched"`); every other
   * line type is always `"unmatched"` here (never matched to a document directly). */
  matchStatus: "matched" | "suggested" | "unmatched";
  matchedDocumentId: string | null;
  matchedDocumentTitle: string | null;
};

export type SettlementReportView = {
  documentId: string;
  platform: SettlementPlatform | null;
  decomposition: SettlementDecomposition;
  lines: SettlementLineView[];
};
