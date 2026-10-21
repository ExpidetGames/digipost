// Owner: src/modules/payments (F3b, decisions/0025-payment-matching-wiring.md). Contracts
// only: no Drizzle import besides type-only schema references.
//
// Every workspace-scoped method takes and filters on `workspaceId` explicitly, same
// convention as every other repository in this repository.
import type { InferSelectModel } from "drizzle-orm";

import type { DocumentTransactionStatus, MatchedBy, MatchKind, MatchReasonCode } from "@/modules/payments";
import type { documentTransactions, paymentAliases, paymentNoDocumentRules, paymentRejections } from "@/persistence/schema/payments";

export type DocumentTransactionRow = InferSelectModel<typeof documentTransactions>;
export type PaymentAliasRow = InferSelectModel<typeof paymentAliases>;
export type PaymentRejectionRow = InferSelectModel<typeof paymentRejections>;
export type PaymentNoDocumentRuleRow = InferSelectModel<typeof paymentNoDocumentRules>;

/** A `document_transactions` row enriched with just enough of its document/transaction to
 * render a suggestion or a matched-transaction line without a second round trip - the
 * "Zuordnung" tab and the document detail payment section both need this shape. Amount/
 * counterparty fields are always populated here; REDACTION for a non-`finance.read` viewer
 * happens in `src/modules/payments/server/read-models.ts`, never in this repository (a
 * repository has no notion of the caller's permissions, WEBAPP_TEMPLATE_SPEC.md §5.3). */
export type DocumentTransactionWithDetails = DocumentTransactionRow & {
  documentOriginalFileName: string;
  documentTitle: string | null;
  documentInvoiceNumber: string | null;
  transactionBookingDate: string;
  transactionAmountCents: number;
  transactionCurrency: string | null;
  transactionCounterpartyName: string | null;
  transactionRemittanceText: string | null;
};

export type CreateDocumentTransactionRow = {
  workspaceId: string;
  documentId: string;
  transactionId: string;
  status: DocumentTransactionStatus;
  kind: MatchKind;
  confidence: number;
  reasons: MatchReasonCode[];
  explanation: string | null;
  matchedBy: MatchedBy;
  allocatedAmountCents: number;
  /** Only ever set on a `kind: "ai"` row - `null` otherwise. See
   * `src/persistence/schema/payments.ts`'s own header comment for the caching rationale. */
  arbiterCacheKey: string | null;
  decidedAt: Date | null;
  decidedByUserId: string | null;
};

export type DecideDocumentTransactionInput = {
  status: Extract<DocumentTransactionStatus, "confirmed" | "rejected">;
  matchedBy: MatchedBy;
  decidedByUserId: string | null;
  /** Only meaningful when confirming - a human may adjust the allocated amount (e.g.
   * confirming a suggestion for less than its full proposed amount is not offered by this
   * phase's UI, but the field stays authoritative here rather than re-deriving it from the
   * suggestion's own `allocatedAmountCents` a second time). Ignored when rejecting. */
  allocatedAmountCents?: number;
};

export interface DocumentTransactionRepository {
  /** Upserts by `(document_id, transaction_id)` (`document_transactions_document_transaction_key`):
   * re-running `runMatching` for a pairing already known refreshes its `status: "suggested"`
   * row (confidence/reasons/kind may have changed between runs) rather than creating a
   * duplicate - but NEVER overwrites a row that is already `confirmed`/`rejected` (a human
   * decision always wins over a fresh proposal for the identical pairing; the caller is
   * expected to have already filtered out a pair matching an existing decided row before
   * calling this, `filterRejectedPairs`/checking `findByPair` first - this method's own
   * `ON CONFLICT ... WHERE status = 'suggested'` is the second, authoritative guard). */
  upsertSuggestion(input: CreateDocumentTransactionRow): Promise<DocumentTransactionRow>;
  /** The one-shot "Transaktion manuell verknüpfen"/auto-confirm insert path - always creates a
   * fresh row already `confirmed` (no separate suggest-then-confirm step for a rules-stage
   * auto-confirm or a manual link). */
  createConfirmed(input: CreateDocumentTransactionRow): Promise<DocumentTransactionRow>;
  findById(workspaceId: string, id: string): Promise<DocumentTransactionRow | null>;
  findByPair(workspaceId: string, documentId: string, transactionId: string): Promise<DocumentTransactionRow | null>;
  /** The (at most one, by construction - the arbiter ranks ONE best candidate per
   * transaction) `kind: "ai"` row for this transaction, regardless of `status` - `runMatching`'s
   * AI-stage cache lookup (`arbiterCacheKey`, see `src/persistence/schema/payments.ts`). */
  findAiSuggestionForTransaction(workspaceId: string, transactionId: string): Promise<DocumentTransactionRow | null>;
  decide(workspaceId: string, id: string, input: DecideDocumentTransactionInput): Promise<DocumentTransactionRow | null>;
  /** "Verknüpfung aufheben" - deletes the row entirely (not a status change): a future
   * matching run, or a manual link, may propose/create this exact pairing again. Use
   * `PaymentRejectionRepository.create` alongside this when the intent is instead "never
   * suggest this pairing again". */
  deleteById(workspaceId: string, id: string): Promise<void>;
  listForDocument(workspaceId: string, documentId: string): Promise<DocumentTransactionWithDetails[]>;
  listForTransaction(workspaceId: string, transactionId: string): Promise<DocumentTransactionWithDetails[]>;
  /** Every `suggested` row in the workspace, joined for display - "Zuordnung"'s own list of
   * open suggestions grouped by transaction. */
  listSuggestedForWorkspace(workspaceId: string): Promise<DocumentTransactionWithDetails[]>;
  /** The "Start" work-list page's "Offene Vorschläge" bucket - a real `count(*)`, not
   * `listSuggestedForWorkspace(...).length` (P6 review finding A7). */
  countSuggestedForWorkspace(workspaceId: string): Promise<number>;
  /** Abschluss (decisions/0066-abschluss-check-and-export.md)'s "Offene Zuordnungsvorschläge":
   * the same `suggested` rows as above, narrowed to suggestions whose TRANSACTION was booked
   * inside the period (`from`/`to`, inclusive ISO `YYYY-MM-DD`) - the same date the check's
   * "Buchungen ohne Beleg" item scopes by, so both items describe the same set of bank rows.
   * A real `count(*)`, never a list measured with `.length`. */
  countSuggestedForPeriod(workspaceId: string, from: string, to: string): Promise<number>;
  /** `document_id -> sum(allocated_amount_cents)` over every `confirmed` row for the given
   * documents - `PaymentsUseCases`'s own way of computing `openAmountCents` (total minus this
   * sum) without loading every row into application code. Documents with no confirmed row at
   * all are simply absent from the returned map (treated as `0` by the caller). */
  sumConfirmedAllocatedByDocument(workspaceId: string, documentIds: string[]): Promise<Map<string, number>>;
  /** The same sum keyed by `transaction_id`: how much of each transaction confirmed links
   * already claim. Transactions with no confirmed row are absent from the map. */
  sumConfirmedAllocatedByTransaction(workspaceId: string, transactionIds: string[]): Promise<Map<string, number>>;
}

export interface PaymentAliasRepository {
  /** Upserts by `(workspace_id, counterparty_name_normalized)` - the latest confirmation
   * always wins over an older alias for the same name. */
  upsert(input: { workspaceId: string; counterpartyNameNormalized: string; contactId: string; learnedFromUserId: string | null }): Promise<PaymentAliasRow>;
  listForWorkspace(workspaceId: string): Promise<PaymentAliasRow[]>;
  /** decisions/0047: removes one learned alias, workspace-scoped (a wrong alias would otherwise
   * steer matching forever). */
  deleteById(workspaceId: string, id: string): Promise<void>;
}

export interface PaymentRejectionRepository {
  /** No-ops (does not throw) when the exact pairing was already rejected before -
   * `payment_rejections_document_transaction_key`'s own `ON CONFLICT DO NOTHING`. */
  create(input: { workspaceId: string; documentId: string; transactionId: string; rejectedBy: string | null }): Promise<void>;
  listForWorkspace(workspaceId: string): Promise<PaymentRejectionRow[]>;
}

export interface PaymentNoDocumentRuleRepository {
  upsert(input: { workspaceId: string; counterpartyNameNormalized: string; createdByUserId: string | null }): Promise<PaymentNoDocumentRuleRow>;
  listForWorkspace(workspaceId: string): Promise<PaymentNoDocumentRuleRow[]>;
}
