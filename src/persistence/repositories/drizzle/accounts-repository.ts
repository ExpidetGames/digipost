// Owner: src/modules/accounts (F2, decisions/0024-accounts-and-transactions.md).
// Encapsulates access only: no validation, no idempotency-key computation, no external calls
// (WEBAPP_TEMPLATE_SPEC.md §5.3).
import { and, asc, between, desc, eq, gte, ilike, inArray, isNull, lte, ne, notExists, or, sql } from "drizzle-orm";

import type { DbExecutor } from "@/persistence/foundation/db-types";
import { accounts, importBatches, settlementLines, transactions } from "@/persistence/schema/accounts";
import { documents } from "@/persistence/schema/documents";
import { documentTransactions } from "@/persistence/schema/payments";
import type {
  AccountRepository,
  ClosingLinkedDocument,
  ImportBatchRepository,
  SettlementLineRepository,
  TransactionRepository,
} from "@/persistence/repositories/contracts/accounts-repository";
import {
  documentCurrency,
  documentEffectiveDate,
  documentTotalAmountCents,
} from "@/persistence/repositories/drizzle/documents-repository";

/** F4's own "amount + date within N days" window for payout-to-bank-deposit pairing
 * (decisions/0026-platform-settlements.md's fixed rule). */
const PAYOUT_PAIRING_WINDOW_DAYS = 3;

/**
 * The four conditions that define "eine Buchung ohne Beleg": no confirmed document link, not
 * marked "kein Beleg nötig" by a human, not on a platform's own clearing account (F4,
 * decisions/0026-platform-settlements.md - a settlement report's ledger entries are matched
 * separately and `fee`/`refund`/`payout` lines never match an invoice at all), and not tied
 * into a clearing account's own booking by a `transfer_group_id`
 * (decisions/0068-supplier-clearing-accounts.md: a supplier charge booked onto that
 * supplier's clearing account IS explained - by the account, not by one document - and
 * `transfer_group_id` is only ever set by such a pairing).
 *
 * One shared builder, used by `listUnmatched`, `countUnmatched` and `countsForPeriod`
 * (decisions/0066-abschluss-check-and-export.md). It was deliberately duplicated between the
 * first two before the Abschluss existed ("each stays a plain, obviously-correct read of its
 * own"); with a third caller whose whole point is to count exactly what "Zuordnung" lists, a
 * single definition is now the thing that keeps them honest.
 */
function unmatchedTransactionConditions(db: DbExecutor) {
  const notConfirmed = notExists(
    db
      .select({ one: sql`1` })
      .from(documentTransactions)
      .where(and(eq(documentTransactions.transactionId, transactions.id), eq(documentTransactions.status, "confirmed"))),
  );
  const notOnClearingAccount = notExists(
    db
      .select({ one: sql`1` })
      .from(accounts)
      .where(and(eq(accounts.id, transactions.accountId), eq(accounts.type, "clearing"))),
  );
  return [eq(transactions.noDocumentNeeded, false), notConfirmed, notOnClearingAccount, isNull(transactions.transferGroupId)];
}

function shiftIsoDate(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function createDrizzleAccountRepository(db: DbExecutor): AccountRepository {
  return {
    async create(input) {
      const [row] = await db.insert(accounts).values(input).returning();
      if (!row) throw new Error("insert into accounts returned no row");
      return row;
    },

    async update(workspaceId, id, input) {
      const [row] = await db
        .update(accounts)
        .set({ ...input, updatedAt: new Date() })
        .where(and(eq(accounts.id, id), eq(accounts.workspaceId, workspaceId)))
        .returning();
      return row ?? null;
    },

    async findById(workspaceId, id) {
      const [row] = await db
        .select()
        .from(accounts)
        .where(and(eq(accounts.id, id), eq(accounts.workspaceId, workspaceId)))
        .limit(1);
      return row ?? null;
    },

    async findByIban(workspaceId, iban) {
      const [row] = await db
        .select()
        .from(accounts)
        .where(and(eq(accounts.workspaceId, workspaceId), eq(accounts.iban, iban)))
        .limit(1);
      return row ?? null;
    },

    async findByPlatform(workspaceId, platform) {
      const [row] = await db
        .select()
        .from(accounts)
        .where(and(eq(accounts.workspaceId, workspaceId), eq(accounts.type, "clearing"), eq(accounts.platform, platform)))
        .limit(1);
      return row ?? null;
    },

    async findByContact(workspaceId, contactId) {
      const [row] = await db
        .select()
        .from(accounts)
        .where(and(eq(accounts.workspaceId, workspaceId), eq(accounts.type, "clearing"), eq(accounts.contactId, contactId)))
        .limit(1);
      return row ?? null;
    },

    listForWorkspace: (workspaceId) => db.select().from(accounts).where(eq(accounts.workspaceId, workspaceId)).orderBy(asc(accounts.name)),
  };
}

export function createDrizzleTransactionRepository(db: DbExecutor): TransactionRepository {
  return {
    async findById(workspaceId, id) {
      const [row] = await db
        .select()
        .from(transactions)
        .where(and(eq(transactions.id, id), eq(transactions.workspaceId, workspaceId)))
        .limit(1);
      return row ?? null;
    },

    async insertManyIdempotent(rows) {
      if (rows.length === 0) return [];
      return db
        .insert(transactions)
        .values(rows)
        .onConflictDoNothing({ target: [transactions.accountId, transactions.idempotencyKey] })
        .returning();
    },

    async assignBatch(transactionIds, importBatchId) {
      if (transactionIds.length === 0) return;
      await db.update(transactions).set({ importBatchId }).where(inArray(transactions.id, transactionIds));
    },

    async list(workspaceId, accountId, filter) {
      const conditions = [eq(transactions.workspaceId, workspaceId), eq(transactions.accountId, accountId)];
      if (filter.dateFrom) conditions.push(gte(transactions.bookingDate, filter.dateFrom));
      if (filter.dateTo) conditions.push(lte(transactions.bookingDate, filter.dateTo));
      if (filter.minAmountCents !== undefined) conditions.push(gte(transactions.amountCents, filter.minAmountCents));
      if (filter.maxAmountCents !== undefined) conditions.push(lte(transactions.amountCents, filter.maxAmountCents));
      if (filter.creditDebit) conditions.push(eq(transactions.creditDebit, filter.creditDebit));
      const q = filter.q?.trim();
      if (q) {
        // F5 review finding (F2 #5, decisions/0027-hardening-and-deletion.md): a leading-`%`
        // `ilike` cannot use a plain B-tree index, and no trigram/tsvector index exists for
        // `counterparty_name`/`remittance_text` - accepted as a documented limitation for
        // this product's scale (a small business's own transaction history, not a
        // multi-tenant analytics workload) rather than adding a new Postgres extension
        // (`pg_trgm`) for it; see that ADR's "Transaction search" section for the reasoning
        // and the revisit trigger.
        const needle = `%${q}%`;
        conditions.push(or(ilike(transactions.counterpartyName, needle), ilike(transactions.remittanceText, needle))!);
      }

      const offset = (filter.page - 1) * filter.pageSize;
      const limit = filter.pageSize + 1;

      const rows = await db
        .select()
        .from(transactions)
        .where(and(...conditions))
        .orderBy(desc(transactions.bookingDate), desc(transactions.id))
        .limit(limit)
        .offset(offset);

      const hasMore = rows.length > filter.pageSize;
      return { items: hasMore ? rows.slice(0, filter.pageSize) : rows, hasMore };
    },

    async sumAmountCents(workspaceId, accountId, accountCurrency) {
      const [row] = await db
        .select({
          sum: sql<number>`coalesce(sum(case when ${transactions.currency} is null or ${transactions.currency} = ${accountCurrency} then ${transactions.amountCents} else 0 end), 0)::int`,
          mixed: sql<boolean>`bool_or(${transactions.currency} is not null and ${transactions.currency} <> ${accountCurrency})`,
        })
        .from(transactions)
        .where(and(eq(transactions.workspaceId, workspaceId), eq(transactions.accountId, accountId)));
      return { amountCents: row?.sum ?? 0, hasMixedCurrency: row?.mixed ?? false };
    },

    async listForMatching(workspaceId, filter) {
      // F4 (decisions/0026-platform-settlements.md): a `clearing`-account transaction (a
      // settlement report's own revenue/fee/refund/payout ledger entries) is never a candidate
      // for the ordinary three-stage engine - `revenue` lines are matched separately via
      // `PaymentsUseCases.matchSettlementReport` (`@/modules/payments`'s
      // `decomposeSettlement`/`matchSettlementLinesToDocuments`), and `fee`/`refund`/`payout`
      // lines never match an invoice directly at all (decisions/0023's own product decision).
      const notOnClearingAccount = notExists(
        db
          .select({ one: sql`1` })
          .from(accounts)
          .where(and(eq(accounts.id, transactions.accountId), eq(accounts.type, "clearing"))),
      );
      const conditions = [eq(transactions.workspaceId, workspaceId), eq(transactions.noDocumentNeeded, false), notOnClearingAccount];
      if (filter.dateFrom) conditions.push(gte(transactions.bookingDate, filter.dateFrom));
      if (filter.dateTo) conditions.push(lte(transactions.bookingDate, filter.dateTo));
      if (filter.minAmountCents !== undefined) conditions.push(gte(transactions.amountCents, filter.minAmountCents));
      if (filter.maxAmountCents !== undefined) conditions.push(lte(transactions.amountCents, filter.maxAmountCents));
      if (filter.counterpartyIban) conditions.push(eq(transactions.counterpartyIban, filter.counterpartyIban));
      if (filter.excludeId) conditions.push(sql`${transactions.id} != ${filter.excludeId}`);

      return db
        .select()
        .from(transactions)
        .where(and(...conditions))
        .orderBy(desc(transactions.bookingDate))
        .limit(filter.limit);
    },

    async listUnmatched(workspaceId, filter) {
      const conditions = [eq(transactions.workspaceId, workspaceId), ...unmatchedTransactionConditions(db)];
      // decisions/0066: the SAME `booking_date` bound `countsForPeriod` uses, added to the
      // SAME shared conditions - so "N Buchungen ohne Beleg" for a period and the list that
      // number links to can never disagree.
      if (filter.from !== undefined) conditions.push(gte(transactions.bookingDate, filter.from));
      if (filter.to !== undefined) conditions.push(lte(transactions.bookingDate, filter.to));

      const offset = (filter.page - 1) * filter.pageSize;
      const limit = filter.pageSize + 1;

      const rows = await db
        .select()
        .from(transactions)
        .where(and(...conditions))
        .orderBy(desc(transactions.bookingDate), desc(transactions.id))
        .limit(limit)
        .offset(offset);

      const hasMore = rows.length > filter.pageSize;
      return { items: hasMore ? rows.slice(0, filter.pageSize) : rows, hasMore };
    },

    async countUnmatched(workspaceId) {
      // Exactly `listUnmatched`'s own conditions, from the one shared builder above.
      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(transactions)
        .where(and(eq(transactions.workspaceId, workspaceId), ...unmatchedTransactionConditions(db)));
      return row?.count ?? 0;
    },

    // --- Abschluss (decisions/0066-abschluss-check-and-export.md). A transaction belongs to a
    // period by its own `booking_date`, nothing derived. ---

    async countsForPeriod(workspaceId, from, to) {
      const inPeriod = and(eq(transactions.workspaceId, workspaceId), between(transactions.bookingDate, from, to));
      const [row] = await db
        .select({
          // Every transaction in the period, clearing accounts included - the "an empty check
          // is not an empty period" total. The `unmatched` count beside it deliberately does
          // NOT include them, because "Buchungen ohne Beleg" means exactly what "Zuordnung"
          // lists (see `unmatchedTransactionConditions`).
          total: sql<number>`count(*)::int`,
          unmatched: sql<number>`(count(*) filter (where ${and(...unmatchedTransactionConditions(db))}))::int`,
        })
        .from(transactions)
        .where(inPeriod);
      return { total: row?.total ?? 0, unmatched: row?.unmatched ?? 0 };
    },

    async listForPeriod(workspaceId, from, to) {
      return db
        .select({
          id: transactions.id,
          bookingDate: transactions.bookingDate,
          accountName: accounts.name,
          amountCents: transactions.amountCents,
          // An account's own currency when the transaction did not record one (every camt.053
          // row does, a mapped tabular row may not).
          currency: sql<string>`coalesce(${transactions.currency}, ${accounts.currency})`,
          counterpartyName: transactions.counterpartyName,
          remittanceText: transactions.remittanceText,
          noDocumentNeeded: transactions.noDocumentNeeded,
          // WHICH documents settle this transaction, not how many (decisions/0066): the
          // workbook's "Zugeordnete Belege" column names them ("D-007") and the "Zuordnungen"
          // sheet pairs them off, while `.length > 0` still decides the row's "Status". A
          // correlated subquery aggregating to JSON rather than a second join, which would
          // multiply this row.
          //
          // `documentEffectiveDate`/`documentTotalAmountCents`/`documentCurrency` are the
          // SAME expressions the "Dokumente" sheet reads (shared, never copied - a linked
          // document must not show one date here and another there). They are safe inside
          // this joined query precisely because they name `documents.<column>` explicitly;
          // `documents` is joined unaliased below for that reason.
          confirmedDocuments: sql<ClosingLinkedDocument[]>`coalesce((
            select json_agg(json_build_object(
              'id', documents.id,
              'effectiveDate', to_char(${documentEffectiveDate}, 'YYYY-MM-DD'),
              'amountCents', ${documentTotalAmountCents},
              'currency', ${documentCurrency},
              'allocatedAmountCents', dt.allocated_amount_cents
            ) order by ${documentEffectiveDate}, documents.id)
            from document_transactions dt
            join documents on documents.id = dt.document_id
            where dt.transaction_id = ${transactions.id} and dt.status = 'confirmed'
          ), '[]'::json)`,
        })
        .from(transactions)
        .innerJoin(accounts, eq(accounts.id, transactions.accountId))
        // decisions/0066: bank accounts only. A clearing account's rows are individual in-app
        // purchases (1015 of the owner's 1158 bookings in 2025, one per 0,79 EUR sale) and the
        // monthly report that aggregates them is already its own row in the Dokumente sheet.
        // Listing both would bury the 143 real bank movements, and it is the same exclusion
        // "Buchungen ohne Beleg" already makes.
        .where(and(eq(transactions.workspaceId, workspaceId), between(transactions.bookingDate, from, to), ne(accounts.type, "clearing")))
        .orderBy(asc(transactions.bookingDate), asc(transactions.id));
    },

    async markNoDocumentNeeded(workspaceId, transactionIds) {
      if (transactionIds.length === 0) return;
      await db
        .update(transactions)
        .set({ noDocumentNeeded: true })
        .where(and(eq(transactions.workspaceId, workspaceId), inArray(transactions.id, transactionIds)));
    },

    async findByIdempotencyKeys(accountId, idempotencyKeys) {
      if (idempotencyKeys.length === 0) return [];
      return db
        .select()
        .from(transactions)
        .where(and(eq(transactions.accountId, accountId), inArray(transactions.idempotencyKey, idempotencyKeys)));
    },

    async setTransferGroup(transactionIds, transferGroupId) {
      if (transactionIds.length === 0) return;
      await db.update(transactions).set({ transferGroupId }).where(inArray(transactions.id, transactionIds));
    },

    async findUnpairedBankMatch(workspaceId, candidate) {
      const conditions = [
        eq(transactions.workspaceId, workspaceId),
        eq(accounts.type, "bank"),
        isNull(transactions.transferGroupId),
      ];

      if (candidate.payoutId) {
        const [byReference] = await db
          .select({ tx: transactions })
          .from(transactions)
          .innerJoin(accounts, eq(accounts.id, transactions.accountId))
          .where(and(...conditions, ilike(transactions.remittanceText, `%${candidate.payoutId}%`)))
          .limit(1);
        if (byReference) return byReference.tx;
      }

      const [byAmountAndDate] = await db
        .select({ tx: transactions })
        .from(transactions)
        .innerJoin(accounts, eq(accounts.id, transactions.accountId))
        .where(
          and(
            ...conditions,
            eq(transactions.amountCents, candidate.amountCents),
            between(transactions.bookingDate, shiftIsoDate(candidate.bookingDate, -PAYOUT_PAIRING_WINDOW_DAYS), shiftIsoDate(candidate.bookingDate, PAYOUT_PAIRING_WINDOW_DAYS)),
          ),
        )
        .limit(1);
      return byAmountAndDate?.tx ?? null;
    },
  };
}

export function createDrizzleSettlementLineRepository(db: DbExecutor): SettlementLineRepository {
  return {
    async insertManyIdempotent(rows) {
      if (rows.length === 0) return [];
      return db
        .insert(settlementLines)
        .values(rows)
        .onConflictDoNothing({ target: [settlementLines.sourceDocumentId, settlementLines.externalLineId] })
        .returning();
    },

    listForDocument: (workspaceId, documentId) =>
      db
        .select()
        .from(settlementLines)
        .where(and(eq(settlementLines.workspaceId, workspaceId), eq(settlementLines.sourceDocumentId, documentId)))
        .orderBy(asc(settlementLines.bookingDate)),

    async sumFeeCentsForAccountAndPeriod(clearingAccountId, monthStart, monthEnd) {
      const [row] = await db
        .select({ sum: sql<number>`coalesce(sum(${settlementLines.feeCents}), 0)::int` })
        .from(settlementLines)
        .where(
          and(
            eq(settlementLines.clearingAccountId, clearingAccountId),
            eq(settlementLines.type, "fee"),
            between(settlementLines.bookingDate, monthStart, monthEnd),
          ),
        );
      return row?.sum ?? 0;
    },

    async listUnpairedPayoutLines(workspaceId) {
      const rows = await db
        .select({
          settlementLineId: settlementLines.id,
          transactionId: transactions.id,
          amountCents: transactions.amountCents,
          bookingDate: transactions.bookingDate,
          payoutId: settlementLines.payoutId,
        })
        .from(settlementLines)
        .innerJoin(transactions, eq(transactions.id, settlementLines.transactionId))
        .where(and(eq(settlementLines.workspaceId, workspaceId), eq(settlementLines.type, "payout"), isNull(transactions.transferGroupId)));
      return rows.map((row) => ({ ...row, transactionId: row.transactionId }));
    },
  };
}

export function createDrizzleImportBatchRepository(db: DbExecutor): ImportBatchRepository {
  return {
    async upsertForDocument(input) {
      if (input.sourceDocumentId === null) {
        const [row] = await db.insert(importBatches).values(input).returning();
        if (!row) throw new Error("insert into import_batches returned no row");
        return row;
      }

      const [row] = await db
        .insert(importBatches)
        .values(input)
        .onConflictDoUpdate({
          target: [importBatches.sourceDocumentId],
          set: {
            accountId: input.accountId,
            statementFrom: input.statementFrom,
            statementTo: input.statementTo,
            openingBalanceCents: input.openingBalanceCents,
            closingBalanceCents: input.closingBalanceCents,
            rowsTotal: input.rowsTotal,
            rowsImported: input.rowsImported,
            rowsDuplicate: input.rowsDuplicate,
            balanceMismatch: input.balanceMismatch,
          },
        })
        .returning();
      if (!row) throw new Error("upsert into import_batches returned no row");
      return row;
    },

    listForAccount: (workspaceId, accountId) =>
      db
        .select()
        .from(importBatches)
        .where(and(eq(importBatches.workspaceId, workspaceId), eq(importBatches.accountId, accountId)))
        .orderBy(desc(importBatches.statementTo), desc(importBatches.createdAt)),

    async findBySourceDocumentId(workspaceId, sourceDocumentId) {
      const [row] = await db
        .select()
        .from(importBatches)
        .where(and(eq(importBatches.workspaceId, workspaceId), eq(importBatches.sourceDocumentId, sourceDocumentId)))
        .limit(1);
      return row ?? null;
    },

    async listPendingAccountDocuments(workspaceId) {
      const rows = await db
        .select({ id: documents.id, originalFileName: documents.originalFileName, createdAt: documents.createdAt })
        .from(documents)
        .leftJoin(importBatches, eq(importBatches.sourceDocumentId, documents.id))
        .where(
          and(
            eq(documents.workspaceId, workspaceId),
            eq(documents.kind, "bank_statement"),
            eq(documents.intakeStatus, "confirmed"),
            sql`${importBatches.id} is null`,
          ),
        )
        .orderBy(desc(documents.createdAt));
      return rows;
    },
  };
}
