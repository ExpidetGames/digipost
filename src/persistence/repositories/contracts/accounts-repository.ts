// Owner: src/modules/accounts (F2, decisions/0024-accounts-and-transactions.md). Contracts
// only: no Drizzle import besides type-only schema references.
//
// Every workspace-scoped method takes and filters on `workspaceId` explicitly, same
// convention as every other repository in this repository (`documents-repository.ts`'s own
// header comment).
import type { InferSelectModel } from "drizzle-orm";

import type { SettlementPlatform } from "@/modules/intake";
import type { accounts, AccountType, CreditDebitIndicator, importBatches, settlementLines, SettlementLineType, transactions } from "@/persistence/schema/accounts";

export { ACCOUNT_TYPES, CREDIT_DEBIT_INDICATORS, SETTLEMENT_LINE_TYPES } from "@/persistence/schema/accounts";
export type { AccountType, CreditDebitIndicator, SettlementLineType } from "@/persistence/schema/accounts";

export type AccountRow = InferSelectModel<typeof accounts>;
export type TransactionRow = InferSelectModel<typeof transactions>;
export type ImportBatchRow = InferSelectModel<typeof importBatches>;
export type SettlementLineRow = InferSelectModel<typeof settlementLines>;

export type CreateAccountRow = {
  workspaceId: string;
  type: AccountType;
  name: string;
  /** Already normalized by the caller (`@/modules/contacts`'s `normalizeIban`) - this
   * repository never normalizes on its own behalf. */
  iban: string | null;
  bic: string | null;
  currency: string;
  holder: string | null;
  platform: string | null;
  /** decisions/0068-supplier-clearing-accounts.md: the contact that owns this clearing
   * account - omitted or `null` for every other account. Never set together with `platform`
   * (`accounts_clearing_owner_check`). Optional rather than required so every existing
   * caller (and every fixture) keeps reading as "an account nobody owns personally". */
  contactId?: string | null;
};

export type UpdateAccountRow = {
  name: string;
  iban: string | null;
  bic: string | null;
  currency: string;
  holder: string | null;
  platform: string | null;
};

/** One normalized transaction, ready to insert - `idempotencyKey` is taken verbatim from
 * `@/modules/intake`'s own computed value, never recomputed here. */
export type CreateTransactionRow = {
  workspaceId: string;
  accountId: string;
  bookingDate: string;
  valueDate: string | null;
  amountCents: number;
  currency: string | null;
  creditDebit: CreditDebitIndicator;
  counterpartyName: string | null;
  counterpartyIban: string | null;
  counterpartyBic: string | null;
  remittanceText: string | null;
  endToEndId: string | null;
  mandateId: string | null;
  creditorId: string | null;
  bankTxCode: string | null;
  bankReference: string | null;
  idempotencyKey: string;
  importBatchId: string | null;
  sourceDocumentId: string | null;
  raw: unknown;
};

export type TransactionListFilter = {
  /** Case-insensitive substring match over `counterpartyName`/`remittanceText`. */
  q?: string;
  dateFrom?: string;
  dateTo?: string;
  minAmountCents?: number;
  maxAmountCents?: number;
  creditDebit?: CreditDebitIndicator;
  /** 1-based. */
  page: number;
  pageSize: number;
};

export type TransactionListResult = {
  items: TransactionRow[];
  hasMore: boolean;
};

/** F3b (decisions/0025-payment-matching-wiring.md): candidate preselection BEFORE
 * `@/modules/payments`'s own `selectCandidateDocuments`/`selectCandidateTransactions` bound
 * further down to 20 - narrows an otherwise workspace-wide scan using the existing
 * `(workspace_id, booking_date desc)`/`(workspace_id, counterparty_iban)`/
 * `(workspace_id, amount_cents)` indexes. Every filter is optional and additive (AND); a
 * caller with no filter at all gets every non-`no_document_needed` transaction in the
 * workspace within `limit` rows (bounded so a first-ever matching run on a large workspace
 * cannot load everything into memory at once). */
export type TransactionMatchFilter = {
  dateFrom?: string;
  dateTo?: string;
  minAmountCents?: number;
  maxAmountCents?: number;
  counterpartyIban?: string;
  /** Excludes a specific transaction id - used when preselecting candidates for a document
   * that is itself trying to find its own settling transaction (never proposes matching a
   * transaction against itself, which cannot happen structurally but keeps the query's
   * intent explicit). */
  excludeId?: string;
  limit: number;
};

export type TransactionUnmatchedFilter = {
  /** decisions/0066-abschluss-check-and-export.md: "Zuordnung"'s own date-range filter, and
   * what the Abschluss's "Buchungen ohne Beleg" link carries so the count and the list it
   * opens are the same set. Inclusive ISO `YYYY-MM-DD` bounds on `booking_date` - the very
   * date `countsForPeriod` scopes a transaction by - and either may be absent. */
  from?: string;
  to?: string;
  /** 1-based. */
  page: number;
  pageSize: number;
};

export type UpsertImportBatchRow = {
  workspaceId: string;
  accountId: string;
  sourceDocumentId: string | null;
  statementFrom: string | null;
  statementTo: string | null;
  openingBalanceCents: number | null;
  closingBalanceCents: number | null;
  rowsTotal: number;
  rowsImported: number;
  rowsDuplicate: number;
  balanceMismatch: boolean;
};

export interface AccountRepository {
  create(input: CreateAccountRow): Promise<AccountRow>;
  update(workspaceId: string, id: string, input: UpdateAccountRow): Promise<AccountRow | null>;
  findById(workspaceId: string, id: string): Promise<AccountRow | null>;
  /** `null` when no account in `workspaceId` currently holds this normalized IBAN - the
   * import service's account-resolution step falls through to creating one. */
  findByIban(workspaceId: string, iban: string): Promise<AccountRow | null>;
  /** F4 (decisions/0026-platform-settlements.md): the workspace's ONE `type: "clearing"`
   * account for this platform, or `null` when none exists yet - `importSettlementReport`'s own
   * resolve-or-create step. Unlike `findByIban` (a plain unique-index lookup), a clearing
   * account has no unique constraint on `(workspace_id, platform)`: this phase relies on
   * always resolving through this method before ever creating one, never on a schema-level
   * guarantee (a documented, accepted trade-off - see decisions/0026's "Consequences"). */
  findByPlatform(workspaceId: string, platform: SettlementPlatform): Promise<AccountRow | null>;
  /** decisions/0068-supplier-clearing-accounts.md: the workspace's ONE contact-owned clearing
   * account for this contact, or `null` when none exists yet - the mirror of `findByPlatform`
   * above, and backed by its own partial unique index
   * (`accounts_workspace_contact_clearing_key`), so "resolve first, create second" cannot
   * silently split a supplier's ledger across two accounts. */
  findByContact(workspaceId: string, contactId: string): Promise<AccountRow | null>;
  listForWorkspace(workspaceId: string): Promise<AccountRow[]>;
}

/** The Abschluss's five-item check, transaction half (decisions/0066-abschluss-check-and-export.md). */
export type ClosingTransactionCounts = {
  /** Every transaction booked in the period, clearing accounts included. */
  total: number;
  /** "Buchungen ohne Beleg" - `listUnmatched`'s own conditions, plus the period. */
  unmatched: number;
};

/** One confirmed (transaction -> document) link, the mirror of `ClosingLinkedTransaction`
 * (decisions/0066-abschluss-check-and-export.md). Carries the document's own effective date
 * and amount for the same reason: the document may lie outside the exported period and have
 * no "Nr." in this workbook. */
export type ClosingLinkedDocument = {
  id: string;
  /** ISO `YYYY-MM-DD` - the shared effective date (decisions/0058/0060/0061). */
  effectiveDate: string;
  /** The document's own total, a platform report's settlement-line sum included (the same
   * fallback the "Dokumente" sheet uses); `null` when the document carries no amount at all. */
  amountCents: number | null;
  currency: string | null;
  allocatedAmountCents: number;
};

/** One row of the export's "Buchungen" sheet (decisions/0066-abschluss-check-and-export.md). */
export type ClosingTransactionRow = {
  id: string;
  /** ISO `YYYY-MM-DD`. */
  bookingDate: string;
  accountName: string;
  /** Signed, in cents: positive is money in. */
  amountCents: number;
  /** The transaction's own currency, falling back to its account's. */
  currency: string;
  counterpartyName: string | null;
  remittanceText: string | null;
  /** A human's explicit "kein Beleg nötig" marker - the third value of the sheet's own
   * "Status" column, distinct from both "zugeordnet" and "offen". */
  noDocumentNeeded: boolean;
  /** Every document this transaction is settled by, oldest effective date first. `.length > 0`
   * is what the sheet's "Status" column reads as "zugeordnet"; the documents themselves feed
   * the "Zugeordnete Belege" cross references and the "Zuordnungen" sheet. */
  confirmedDocuments: ClosingLinkedDocument[];
};

export interface TransactionRepository {
  /** F3b: fetching one transaction to build a `MatchableTransaction` (manual linking, the
   * document-detail payment section, an "existing decision" lookup) - `list` above always
   * needs an `accountId` this caller does not necessarily have in hand. */
  findById(workspaceId: string, id: string): Promise<TransactionRow | null>;
  /** Inserts every row, skipping one whose `(accountId, idempotencyKey)` already exists
   * (`ON CONFLICT ... DO NOTHING`) - the idempotent-reimport guarantee
   * (decisions/0024-accounts-and-transactions.md). Returns only the rows actually inserted,
   * so the caller can report `rowsImported`/`rowsDuplicate` from `rows.length` vs. the
   * returned count without a second query. */
  insertManyIdempotent(rows: CreateTransactionRow[]): Promise<TransactionRow[]>;
  /** Backfills `importBatchId` on exactly the rows this import just inserted - the batch row
   * itself is only created/updated AFTER insertion (its `rowsImported`/`rowsDuplicate` counts
   * depend on how many rows this call actually inserted), so the two writes cannot be a single
   * insert. A no-op for an empty list (the common "re-import found zero new rows" case). */
  assignBatch(transactionIds: string[], importBatchId: string): Promise<void>;
  list(workspaceId: string, accountId: string, filter: TransactionListFilter): Promise<TransactionListResult>;
  /** The account's own running total - used as a fallback "latest balance" for an account
   * with no import batch carrying a closing balance (a tabular/CSV-only import, which never
   * carries balance data at all). F5 review finding (F2 #3, decisions/0027-hardening-and-deletion.md):
   * `amountCents` only ever sums transactions whose own `currency` is `null` (the common case
   * - most imports never record a per-row currency, implicitly meaning "the account's own")
   * or matches `accountCurrency` exactly; a transaction recorded in a genuinely different
   * currency is excluded from the sum rather than added to it nonsensically, and
   * `hasMixedCurrency` reports whether at least one such excluded row exists, so the caller
   * can flag the account's balance as a data-quality concern rather than silently showing a
   * cross-currency total as if it were a real one. */
  sumAmountCents(workspaceId: string, accountId: string, accountCurrency: string): Promise<{ amountCents: number; hasMixedCurrency: boolean }>;
  /** F3b: workspace-wide candidate preselection for payment matching (the GAP
   * decisions/0024-accounts-and-transactions.md's contract for F3b names) - `list` above is
   * scoped to one `(workspace, account)`, this is not. Excludes `no_document_needed: true`
   * rows always (never a plausible payment-matching candidate once a human marked it so). */
  listForMatching(workspaceId: string, filter: TransactionMatchFilter): Promise<TransactionRow[]>;
  /** Every transaction in the workspace with no `confirmed` `document_transactions` row
   * (`@/persistence/schema/payments.ts`) and `no_document_needed: false` - "Zuordnung"'s own
   * unmatched-transactions list. A join against payments' own table (a read, never a write -
   * `src/persistence/README.md`'s "only the owner writes" is about writes; joining another
   * owner's table for a read is the established pattern, e.g. this same repository's
   * `ImportBatchRepository.listPendingAccountDocuments` already joins `documents`). */
  listUnmatched(workspaceId: string, filter: TransactionUnmatchedFilter): Promise<TransactionListResult>;
  /** The "Start" work-list page's "Zahlungen ohne Beleg" bucket - the same criteria as
   * `listUnmatched` above, as a real `count(*)` rather than a page fetched and measured with
   * `.length` (P6 review finding A7). */
  countUnmatched(workspaceId: string): Promise<number>;
  /** Abschluss (decisions/0066-abschluss-check-and-export.md): the period's transaction totals
   * in one round trip. `unmatched` reuses EXACTLY `listUnmatched`'s own three conditions (one
   * shared builder in `repositories/drizzle/accounts-repository.ts`, not a second definition),
   * so "Buchungen ohne Beleg" always means what "Zuordnung" lists; `total` counts every
   * transaction in the period including clearing-account rows, since its only job is to stop
   * an empty check being read as a complete period. `from`/`to` are inclusive ISO
   * `YYYY-MM-DD` dates matched against `booking_date`. */
  countsForPeriod(workspaceId: string, from: string, to: string): Promise<ClosingTransactionCounts>;
  /** Abschluss: every transaction booked in the period, oldest first, in the shape the
   * export's "Buchungen" sheet needs (its account's name resolved, its confirmed-document
   * count counted in SQL). Not paginated - see `DocumentRepository.listForPeriod`. */
  listForPeriod(workspaceId: string, from: string, to: string): Promise<ClosingTransactionRow[]>;
  /** Bulk "kein Beleg nötig" (single id list is also just a length-1 array) - sets
   * `no_document_needed: true` on exactly these transactions, scoped to the workspace. */
  markNoDocumentNeeded(workspaceId: string, transactionIds: string[]): Promise<void>;
  /** F4: resolves EVERY transaction (new or already-known) for a set of idempotency keys on
   * one account - `importSettlementReport`'s own way of finding the transaction id a
   * settlement-line draft's `idempotencyKey` resolved to, whether `insertManyIdempotent` just
   * inserted it or it already existed from a previous import run (that method only returns
   * rows it actually inserted, never one skipped by `ON CONFLICT DO NOTHING`). */
  findByIdempotencyKeys(accountId: string, idempotencyKeys: string[]): Promise<TransactionRow[]>;
  /** F4's payout-to-bank-deposit pairing (decisions/0026): sets the same `transferGroupId` on
   * both the clearing account's `payout` transaction and the matching bank deposit. Always
   * exactly two ids in practice; the array shape (not two separate parameters) mirrors
   * `assignBatch`'s own "a list of ids gets one value" convention. */
  setTransferGroup(transactionIds: string[], transferGroupId: string): Promise<void>;
  /** Every `bank`-type account's transaction in the workspace with `transferGroupId` still
   * `null` and an amount/date in the neighbourhood of `candidate` - the payout-pairing
   * search's own candidate pool, deliberately excluding `clearing` accounts (a payout can never
   * pair against another platform's own ledger transaction). `candidate.amountCents` is the
   * expected BANK-SIDE (positive, credit) magnitude - the caller converts the clearing
   * account's own negative (debit) payout amount before calling this, this repository never
   * flips a sign on the caller's behalf (WEBAPP_TEMPLATE_SPEC.md §5.3: no business logic
   * here). `null` when nothing matches either by `payoutId` appearing in the remittance text
   * or by amount-and-date proximity (decisions/0026's own fixed matching rule: "payout id in
   * remittance text, else amount + date within 3 days"). */
  findUnpairedBankMatch(workspaceId: string, candidate: { amountCents: number; bookingDate: string; payoutId: string | null }): Promise<TransactionRow | null>;
}

/** One normalized settlement line, ready to insert - `@/modules/accounts`'s
 * `SettlementLineDraft` mapped onto its own row shape by `importSettlementReport`, with
 * `transactionId` filled in from the ledger transaction the same import call just resolved
 * (`TransactionRepository.findByIdempotencyKeys`). */
export type CreateSettlementLineRow = {
  workspaceId: string;
  clearingAccountId: string;
  sourceDocumentId: string;
  transactionId: string | null;
  type: SettlementLineType;
  externalLineId: string;
  grossCents: number | null;
  feeCents: number | null;
  netCents: number | null;
  currency: string | null;
  bookingDate: string | null;
  payoutId: string | null;
  chargeId: string | null;
  invoiceId: string | null;
  customerName: string | null;
  customerEmail: string | null;
  productName: string | null;
  countryOfSale: string | null;
};

export interface SettlementLineRepository {
  /** Inserts every row, skipping one whose `(source_document_id, external_line_id)` already
   * exists (`ON CONFLICT ... DO NOTHING`) - the idempotent-reimport guarantee for a settlement
   * report, mirroring `TransactionRepository.insertManyIdempotent`. Returns only the rows
   * actually inserted. */
  insertManyIdempotent(rows: CreateSettlementLineRow[]): Promise<SettlementLineRow[]>;
  /** Every settlement line this document produced - the report detail page's own decomposition
   * (revenue/fee/refund/payout) and "Rechnung fehlt" list (F4). */
  listForDocument(workspaceId: string, documentId: string): Promise<SettlementLineRow[]>;
  /** The sum of every `fee` line's `feeCents` for this clearing account within
   * `[monthStart, monthEnd]` (inclusive, both ISO `YYYY-MM-DD`) - the fee-invoice
   * reconciliation's own period sum (decisions/0026). `0` when there are none. */
  sumFeeCentsForAccountAndPeriod(clearingAccountId: string, monthStart: string, monthEnd: string): Promise<number>;
  /** Every `payout`-type line whose own ledger transaction has no `transferGroupId` yet -
   * "the bank line arrives later" call-back point (decisions/0026): a bank-statement import
   * calls this after inserting its own new transactions, to retry pairing every
   * still-unpaired payout in the workspace, not only ones from the document just imported. */
  listUnpairedPayoutLines(workspaceId: string): Promise<Array<{ settlementLineId: string; transactionId: string; amountCents: number; bookingDate: string | null; payoutId: string | null }>>;
}

export interface ImportBatchRepository {
  /** Upserts by `sourceDocumentId` (when not `null`): re-running an import for the same
   * document replaces this batch's own stats rather than creating a second row
   * (decisions/0024-accounts-and-transactions.md's "one batch per document" design). A
   * `sourceDocumentId: null` batch (should not happen in this phase - every import always has
   * a source document - but the type allows it for forward compatibility) always inserts a
   * new row instead. */
  upsertForDocument(input: UpsertImportBatchRow): Promise<ImportBatchRow>;
  listForAccount(workspaceId: string, accountId: string): Promise<ImportBatchRow[]>;
  findBySourceDocumentId(workspaceId: string, sourceDocumentId: string): Promise<ImportBatchRow | null>;
  /** Every confirmed `bank_statement` document in `workspaceId` that has no import batch yet -
   * the "Konto zuordnen" pending-account list
   * (decisions/0024-accounts-and-transactions.md's "Pending account" section). A read-only
   * join against `documents` (this repository never writes to that table, §5.7 "only the
   * owner writes" - `src/modules/documents` still owns it). */
  listPendingAccountDocuments(workspaceId: string): Promise<{ id: string; originalFileName: string; createdAt: Date }[]>;
}
