// Owner: src/modules/accounts (F2, decisions/0024-accounts-and-transactions.md). Only
// repositories of this owner write to these tables (§5.7 "only the owner writes").
//
// `accounts`: a workspace's own bank/clearing accounts. `iban` is always stored normalized
// (uppercase, no spaces, `@/modules/contacts`'s `normalizeIban`) and unique per workspace when
// not null - a clearing account (a future platform settlement account, F4) has no IBAN at
// all, only a `platform` label, so `iban` stays nullable and the uniqueness is a partial
// index rather than a plain column constraint.
//
// Since decisions/0068-supplier-clearing-accounts.md a clearing account has two possible
// owners: a settlement `platform` (F4, unchanged) or a `contact_id` (a supplier whose
// invoices and bank charges can never pair one to one). Never both, at most one per owner per
// workspace - see the column and index comments below.
//
// `transactions`: normalized bank transactions imported from a confirmed intake document
// (F1a/F1b, `@/modules/intake`'s `NormalizedTransaction`/`NormalizedBankTransactionFromMapping`).
// `idempotencyKey` is computed by the intake module (sha256 over date/amount/currency/most
// specific reference), never recomputed here - this table only needs it to be unique PER
// ACCOUNT, so re-importing an overlapping statement period inserts nothing for a row already
// known (`ON CONFLICT (account_id, idempotency_key) DO NOTHING`, decisions/0024's "Idempotent
// import" section). `sourceDocumentId` is `on delete set null`: deleting the source document
// (any workspace member's ordinary document-management action) must never delete imported
// financial history, only its provenance link. `transferGroupId` is nullable and unused by
// this phase - reserved for F4's payout-to-bank-deposit pairing (a platform settlement's payout
// and the matching bank deposit share one group id).
//
// `import_batches`: one row per document import (unique on `sourceDocumentId` when not null -
// re-running an import for the same document upserts the same batch row rather than creating a
// second one, decisions/0024). `balanceMismatch` is `true` when the statement's own opening
// balance plus the sum of its transactions does not equal the closing balance (a data-quality
// signal, `@/modules/accounts`'s `computeBalanceMismatch` - never a reason to reject the
// import, mirroring `@/modules/intake`'s `camt053StatementReconciles`/decisions/0022's own
// "never a reason to reject" precedent for the analogous per-statement check).
import { boolean, check, date, index, integer, jsonb, pgTable, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { contacts } from "./contacts";
import { documents } from "./documents";
import { workspaces } from "./workspaces";

export const ACCOUNT_TYPES = ["bank", "clearing"] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

// F4 (decisions/0026-platform-settlements.md): one line of a confirmed `payout_report`/
// `platform_settlement` document, reduced from `@/modules/intake`'s
// `NormalizedSettlementLine` rows by `@/modules/accounts`'s pure `buildSettlementLineDrafts` -
// see that file's own header comment for exactly how one raw report row becomes zero, one, or
// two of these (a charge row commonly yields both a `revenue` line and a `fee` line; a
// `payout` line is synthesized once per distinct `payoutId`, not read directly off any single
// row). `revenue` is a credit on the clearing account, `fee`/`refund`/`payout` are debits -
// the product model this schema encodes (decisions/0026's "Product model" section).
//
// Deliberately defined here rather than imported from `@/modules/accounts` (unlike
// `documents.ts`'s `DOCUMENT_KINDS`/`payments.ts`'s `MATCH_KINDS`, both imported from their
// owning module): `@/modules/accounts/core/schemas.ts` already imports `ACCOUNT_TYPES`/
// `CREDIT_DEBIT_INDICATORS` FROM `@/persistence/repositories/contracts` (which itself
// re-exports from this very file) - a schema-to-module import here would complete a real
// circular import (`schema/accounts.ts` -> `@/modules/accounts` -> `core/schemas.ts` ->
// `@/persistence/repositories/contracts` -> `schema/accounts.ts` again), unlike intake/payments
// whose core modules never import back into `@/persistence/repositories/contracts`. The
// module's own `core/settlement-lines.ts` keeps its own equal, independently-tested literal
// type instead (`SettlementLineDraft.type`) - the same "a pure core file uses its own literal
// union rather than importing the schema's enum" precedent this file's sibling
// `ImportableTransaction.creditDebit: "credit" | "debit"` already sets for `CREDIT_DEBIT_INDICATORS`.
export const SETTLEMENT_LINE_TYPES = ["revenue", "fee", "refund", "payout", "adjustment"] as const;
export type SettlementLineType = (typeof SETTLEMENT_LINE_TYPES)[number];

export const CREDIT_DEBIT_INDICATORS = ["credit", "debit"] as const;
export type CreditDebitIndicator = (typeof CREDIT_DEBIT_INDICATORS)[number];

export const accounts = pgTable(
  "accounts",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    type: text({ enum: ACCOUNT_TYPES }).notNull(),
    name: text().notNull(),
    // Always normalized (uppercase, no spaces) - never displayed formatted from this column,
    // the UI re-groups it into 4-character blocks for display only.
    iban: text(),
    bic: text(),
    currency: text().notNull().default("EUR"),
    holder: text(),
    // Only meaningful for `type: "clearing"` (F4's platform settlement accounts: "stripe",
    // "apple", "google", ...) - `null` for a `type: "bank"` account.
    platform: text(),
    // decisions/0068-supplier-clearing-accounts.md: the OTHER possible owner of a
    // `type: "clearing"` account - a supplier (contact) whose invoices and bank charges can
    // never pair one to one (Meta bills per advert and charges on a spending threshold). The
    // account's existence IS the switch; there is no extra flag on the contact. A clearing
    // account is owned by either a platform or a contact, never both
    // (`accounts_clearing_owner_check` below). `on delete set null`, never cascade: deleting
    // a contact must never delete booked financial history ("nothing is auto-deleted except
    // one thing", AGENTS.md) - the ledger survives, unattributed, for a human to deal with.
    contactId: uuid().references(() => contacts.id, { onDelete: "set null" }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("accounts_type_check", sql`${t.type} in ('bank', 'clearing')`),
    index("accounts_workspace_idx").on(t.workspaceId),
    // Plain (default NULLS DISTINCT) unique index: only two rows both holding the SAME
    // non-null IBAN in the same workspace conflict - any number of `iban: null` clearing
    // accounts may coexist (there is no "global, workspace_id null" row shape here that would
    // call for `nullsNotDistinct()`).
    unique("accounts_workspace_iban_key").on(t.workspaceId, t.iban),
    // F5 review finding (F4 leftover (c), decisions/0027-hardening-and-deletion.md):
    // `findByPlatform`/`importSettlementReportDocument` (accounts-use-cases.ts) both assume
    // "one clearing account per platform per workspace" (decisions/0026-platform-settlements.md's
    // own product model) but nothing enforced it at the database level before this - two
    // concurrent settlement-report imports for a platform with no clearing account yet could
    // both find none and both create one, silently splitting that platform's ledger across two
    // accounts. A partial unique index (only `type = 'clearing'` rows participate; any number
    // of `platform: null` bank accounts, or `type: 'bank'` accounts with a `platform` value
    // that should never occur in practice, are unaffected) closes this at the schema level.
    uniqueIndex("accounts_workspace_platform_clearing_key")
      .on(t.workspaceId, t.platform)
      .where(sql`${t.type} = 'clearing'`),
    // decisions/0068-supplier-clearing-accounts.md: "at most one clearing account per contact
    // per workspace", enforced the same partial-index way the platform rule above already is
    // (two concurrent creations for the same contact would otherwise both see "none yet").
    uniqueIndex("accounts_workspace_contact_clearing_key")
      .on(t.workspaceId, t.contactId)
      .where(sql`${t.type} = 'clearing'`),
    // "A clearing account is owned by either a platform or a contact, never both"
    // (decisions/0068) - and a `type: "bank"` account is owned by neither.
    check("accounts_clearing_owner_check", sql`${t.platform} is null or ${t.contactId} is null`),
  ],
);

export const transactions = pgTable(
  "transactions",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    accountId: uuid()
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    bookingDate: date({ mode: "string" }).notNull(),
    valueDate: date({ mode: "string" }),
    // Signed: positive for a credit (money in), negative for a debit (money out) - same
    // convention as `@/modules/intake`'s `NormalizedTransaction.amountCents`.
    amountCents: integer().notNull(),
    currency: text(),
    creditDebit: text({ enum: CREDIT_DEBIT_INDICATORS }).notNull(),
    counterpartyName: text(),
    counterpartyIban: text(),
    counterpartyBic: text(),
    remittanceText: text(),
    endToEndId: text(),
    mandateId: text(),
    creditorId: text(),
    bankTxCode: text(),
    bankReference: text(),
    // From `@/modules/intake` (sha256 over booking date/amount/currency/most specific
    // reference) - unique per account, the idempotent-reimport key
    // (decisions/0024-accounts-and-transactions.md).
    idempotencyKey: text().notNull(),
    importBatchId: uuid().references(() => importBatches.id, { onDelete: "set null" }),
    sourceDocumentId: uuid().references(() => documents.id, { onDelete: "set null" }),
    // F4 (payout-to-bank pairing): a platform settlement's payout row and the matching bank
    // deposit row share one group id once F4's matching logic assigns it - always `null` in
    // this phase.
    transferGroupId: uuid(),
    // The intake module's own normalized row/transaction object, verbatim - an audit trail
    // independent of the typed columns above, and a stable source to re-derive from if a
    // future phase needs a field this table does not carry a column for yet.
    raw: jsonb(),
    // F3b (decisions/0025-payment-matching-wiring.md): "kein Beleg nötig" (single/bulk, and
    // "für diese Gegenpartei immer" via `payment_no_document_rules`,
    // `src/persistence/schema/payments.ts`) - a human's explicit marker that this transaction
    // will never have a matching document (an internal transfer, a bank fee, a payroll run
    // handled outside this app). `payments`'s matching/candidate-preselection queries exclude
    // `true` rows entirely; owned by THIS table (not `document_transactions`) because it is a
    // property of the transaction itself, independent of any particular document pairing.
    noDocumentNeeded: boolean().notNull().default(false),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("transactions_credit_debit_check", sql`${t.creditDebit} in ('credit', 'debit')`),
    unique("transactions_account_idempotency_key").on(t.accountId, t.idempotencyKey),
    index("transactions_workspace_booking_date_idx").on(t.workspaceId, t.bookingDate.desc()),
    index("transactions_account_booking_date_idx").on(t.accountId, t.bookingDate.desc()),
    index("transactions_workspace_counterparty_iban_idx").on(t.workspaceId, t.counterpartyIban),
    index("transactions_workspace_amount_idx").on(t.workspaceId, t.amountCents),
  ],
);

export const importBatches = pgTable(
  "import_batches",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    accountId: uuid()
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    // `on delete set null`: deleting the source document keeps the batch itself
    // (decisions/0024-accounts-and-transactions.md) - a financial import record is worth
    // keeping even after its source document is gone, same tradeoff
    // decisions/0019-contacts.md's `contact_change_proposals.document_id` already makes.
    sourceDocumentId: uuid().references(() => documents.id, { onDelete: "set null" }),
    statementFrom: date({ mode: "string" }),
    statementTo: date({ mode: "string" }),
    openingBalanceCents: integer(),
    closingBalanceCents: integer(),
    rowsTotal: integer().notNull(),
    rowsImported: integer().notNull(),
    rowsDuplicate: integer().notNull(),
    balanceMismatch: boolean().notNull().default(false),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("import_batches_workspace_account_idx").on(t.workspaceId, t.accountId),
    // One batch per source document (when it has one) - re-running an import for the same
    // document upserts this same row rather than creating a second one.
    unique("import_batches_source_document_key").on(t.sourceDocumentId),
  ],
);

// F4 (decisions/0026-platform-settlements.md): `externalLineId` is computed by
// `@/persistence/use-cases/accounts-use-cases.ts`'s `importSettlementReport` (never by this
// schema or the repository) as `"<type>:row<rowNumber>"` for a `revenue`/`fee`/`refund` line
// (deterministic per source row, so a reimport of the identical document never duplicates)
// and `"payout:<payoutId>"` for a synthesized `payout` line (one per distinct payout id in the
// report, not per row) - `unique (source_document_id, external_line_id)` is what makes
// re-running the import idempotent, mirroring `transactions`'s own `(account_id,
// idempotency_key)` guarantee. `transactionId` points at the corresponding ledger row this
// same import created on the clearing account (`null` only transiently is never observed by a
// reader - the use case always inserts both in the same import call, `transactions` first).
export const settlementLines = pgTable(
  "settlement_lines",
  {
    id: uuid().primaryKey().defaultRandom(),
    workspaceId: uuid()
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    clearingAccountId: uuid()
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    sourceDocumentId: uuid()
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    transactionId: uuid().references(() => transactions.id, { onDelete: "set null" }),
    type: text({ enum: SETTLEMENT_LINE_TYPES }).notNull(),
    externalLineId: text().notNull(),
    grossCents: integer(),
    feeCents: integer(),
    netCents: integer(),
    currency: text(),
    bookingDate: date({ mode: "string" }),
    payoutId: text(),
    chargeId: text(),
    invoiceId: text(),
    customerName: text(),
    customerEmail: text(),
    productName: text(),
    countryOfSale: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("settlement_lines_type_check", sql`${t.type} in ('revenue', 'fee', 'refund', 'payout', 'adjustment')`),
    unique("settlement_lines_document_external_key").on(t.sourceDocumentId, t.externalLineId),
    index("settlement_lines_workspace_idx").on(t.workspaceId),
    index("settlement_lines_clearing_account_idx").on(t.clearingAccountId),
    index("settlement_lines_workspace_type_idx").on(t.workspaceId, t.type),
    // Fee-invoice reconciliation's own period-sum query (decisions/0026): every fee line for
    // this platform's clearing account within a calendar month.
    index("settlement_lines_account_type_booking_date_idx").on(t.clearingAccountId, t.type, t.bookingDate),
  ],
);
