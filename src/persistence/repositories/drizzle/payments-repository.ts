// Owner: src/modules/payments (F3b, decisions/0025-payment-matching-wiring.md).
// Encapsulates access only: no validation, no matching logic, no external calls
// (WEBAPP_TEMPLATE_SPEC.md §5.3).
import { and, between, desc, eq, inArray, sql } from "drizzle-orm";

import type { DbExecutor } from "@/persistence/foundation/db-types";
import { documents } from "@/persistence/schema/documents";
import { documentTransactions, paymentAliases, paymentNoDocumentRules, paymentRejections } from "@/persistence/schema/payments";
import { transactions } from "@/persistence/schema/accounts";
import type {
  DocumentTransactionRepository,
  DocumentTransactionWithDetails,
  PaymentAliasRepository,
  PaymentNoDocumentRuleRepository,
  PaymentRejectionRepository,
} from "@/persistence/repositories/contracts/payments-repository";

const detailColumns = {
  ...{
    id: documentTransactions.id,
    workspaceId: documentTransactions.workspaceId,
    documentId: documentTransactions.documentId,
    transactionId: documentTransactions.transactionId,
    status: documentTransactions.status,
    kind: documentTransactions.kind,
    confidence: documentTransactions.confidence,
    reasons: documentTransactions.reasons,
    explanation: documentTransactions.explanation,
    matchedBy: documentTransactions.matchedBy,
    allocatedAmountCents: documentTransactions.allocatedAmountCents,
    arbiterCacheKey: documentTransactions.arbiterCacheKey,
    createdAt: documentTransactions.createdAt,
    decidedAt: documentTransactions.decidedAt,
    decidedByUserId: documentTransactions.decidedByUserId,
  },
  documentOriginalFileName: documents.originalFileName,
  documentTitle: documents.title,
  documentInvoiceNumber: documents.invoiceNumber,
  transactionBookingDate: transactions.bookingDate,
  transactionAmountCents: transactions.amountCents,
  transactionCurrency: transactions.currency,
  transactionCounterpartyName: transactions.counterpartyName,
  transactionRemittanceText: transactions.remittanceText,
};

function withDetailsQuery(db: DbExecutor) {
  return db
    .select(detailColumns)
    .from(documentTransactions)
    .innerJoin(documents, eq(documents.id, documentTransactions.documentId))
    .innerJoin(transactions, eq(transactions.id, documentTransactions.transactionId));
}

export function createDrizzleDocumentTransactionRepository(db: DbExecutor): DocumentTransactionRepository {
  return {
    async upsertSuggestion(input) {
      const [row] = await db
        .insert(documentTransactions)
        .values(input)
        .onConflictDoUpdate({
          target: [documentTransactions.documentId, documentTransactions.transactionId],
          // Only ever overwrites a row that is STILL `suggested` - a `confirmed`/`rejected`
          // row (a human decision) is never silently replaced by a fresh matching-run
          // proposal for the identical pairing.
          set: {
            kind: input.kind,
            confidence: input.confidence,
            reasons: input.reasons,
            explanation: input.explanation,
            arbiterCacheKey: input.arbiterCacheKey,
          },
          setWhere: eq(documentTransactions.status, "suggested"),
        })
        .returning();
      if (row) return row;
      // The conflict target existed but its `setWhere` did not match (an already-decided
      // row) - `onConflictDoUpdate` with a non-matching `setWhere` returns nothing rather
      // than the untouched row; re-read it so the caller still gets a row back.
      const [existing] = await db
        .select()
        .from(documentTransactions)
        .where(and(eq(documentTransactions.documentId, input.documentId), eq(documentTransactions.transactionId, input.transactionId)))
        .limit(1);
      if (!existing) throw new Error("upsert into document_transactions returned no row");
      return existing;
    },

    async createConfirmed(input) {
      const [row] = await db
        .insert(documentTransactions)
        .values(input)
        .onConflictDoUpdate({
          target: [documentTransactions.documentId, documentTransactions.transactionId],
          set: {
            status: input.status,
            kind: input.kind,
            confidence: input.confidence,
            reasons: input.reasons,
            explanation: input.explanation,
            matchedBy: input.matchedBy,
            allocatedAmountCents: input.allocatedAmountCents,
            arbiterCacheKey: input.arbiterCacheKey,
            decidedAt: input.decidedAt,
            decidedByUserId: input.decidedByUserId,
          },
        })
        .returning();
      if (!row) throw new Error("insert into document_transactions returned no row");
      return row;
    },

    async findById(workspaceId, id) {
      const [row] = await db
        .select()
        .from(documentTransactions)
        .where(and(eq(documentTransactions.id, id), eq(documentTransactions.workspaceId, workspaceId)))
        .limit(1);
      return row ?? null;
    },

    async findAiSuggestionForTransaction(workspaceId, transactionId) {
      const [row] = await db
        .select()
        .from(documentTransactions)
        .where(
          and(
            eq(documentTransactions.workspaceId, workspaceId),
            eq(documentTransactions.transactionId, transactionId),
            eq(documentTransactions.kind, "ai"),
          ),
        )
        .limit(1);
      return row ?? null;
    },

    async findByPair(workspaceId, documentId, transactionId) {
      const [row] = await db
        .select()
        .from(documentTransactions)
        .where(
          and(
            eq(documentTransactions.workspaceId, workspaceId),
            eq(documentTransactions.documentId, documentId),
            eq(documentTransactions.transactionId, transactionId),
          ),
        )
        .limit(1);
      return row ?? null;
    },

    async decide(workspaceId, id, input) {
      const [row] = await db
        .update(documentTransactions)
        .set({
          status: input.status,
          matchedBy: input.matchedBy,
          decidedAt: new Date(),
          decidedByUserId: input.decidedByUserId,
          ...(input.allocatedAmountCents !== undefined ? { allocatedAmountCents: input.allocatedAmountCents } : {}),
        })
        .where(and(eq(documentTransactions.id, id), eq(documentTransactions.workspaceId, workspaceId)))
        .returning();
      return row ?? null;
    },

    async deleteById(workspaceId, id) {
      await db.delete(documentTransactions).where(and(eq(documentTransactions.id, id), eq(documentTransactions.workspaceId, workspaceId)));
    },

    async listForDocument(workspaceId, documentId) {
      return withDetailsQuery(db)
        .where(and(eq(documentTransactions.workspaceId, workspaceId), eq(documentTransactions.documentId, documentId)))
        .orderBy(desc(documentTransactions.confidence)) as Promise<DocumentTransactionWithDetails[]>;
    },

    async listForTransaction(workspaceId, transactionId) {
      return withDetailsQuery(db)
        .where(and(eq(documentTransactions.workspaceId, workspaceId), eq(documentTransactions.transactionId, transactionId)))
        .orderBy(desc(documentTransactions.confidence)) as Promise<DocumentTransactionWithDetails[]>;
    },

    async listSuggestedForWorkspace(workspaceId) {
      return withDetailsQuery(db)
        .where(and(eq(documentTransactions.workspaceId, workspaceId), eq(documentTransactions.status, "suggested")))
        .orderBy(desc(documentTransactions.confidence)) as Promise<DocumentTransactionWithDetails[]>;
    },

    async countSuggestedForWorkspace(workspaceId) {
      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(documentTransactions)
        .where(and(eq(documentTransactions.workspaceId, workspaceId), eq(documentTransactions.status, "suggested")));
      return row?.count ?? 0;
    },

    async countSuggestedForPeriod(workspaceId, from, to) {
      // Abschluss (decisions/0066-abschluss-check-and-export.md): a suggestion belongs to a
      // period by the BOOKING DATE of the transaction it proposes, which is also what the
      // "Buchungen ohne Beleg" item above counts by - the two items of the check then always
      // talk about the same set of bank rows.
      //
      // DISTINCT on the transaction, not a count of suggestion rows: the item links to
      // "Zuordnung", which lists TRANSACTIONS, and one transaction can carry several open
      // suggestions. Counting rows would print a number nobody can reproduce on the page it
      // points at, which is the whole failure this check exists to avoid.
      const [row] = await db
        .select({ count: sql<number>`count(distinct ${documentTransactions.transactionId})::int` })
        .from(documentTransactions)
        .innerJoin(transactions, eq(transactions.id, documentTransactions.transactionId))
        .where(
          and(
            eq(documentTransactions.workspaceId, workspaceId),
            eq(documentTransactions.status, "suggested"),
            between(transactions.bookingDate, from, to),
          ),
        );
      return row?.count ?? 0;
    },

    async sumConfirmedAllocatedByDocument(workspaceId, documentIds) {
      if (documentIds.length === 0) return new Map();
      const rows = await db
        .select({ documentId: documentTransactions.documentId, sum: sql<number>`coalesce(sum(${documentTransactions.allocatedAmountCents}), 0)::int` })
        .from(documentTransactions)
        .where(
          and(
            eq(documentTransactions.workspaceId, workspaceId),
            eq(documentTransactions.status, "confirmed"),
            inArray(documentTransactions.documentId, documentIds),
          ),
        )
        .groupBy(documentTransactions.documentId);
      return new Map(rows.map((r) => [r.documentId, r.sum]));
    },

    async sumConfirmedAllocatedByTransaction(workspaceId, transactionIds) {
      if (transactionIds.length === 0) return new Map();
      const rows = await db
        .select({ transactionId: documentTransactions.transactionId, sum: sql<number>`coalesce(sum(${documentTransactions.allocatedAmountCents}), 0)::int` })
        .from(documentTransactions)
        .where(
          and(
            eq(documentTransactions.workspaceId, workspaceId),
            eq(documentTransactions.status, "confirmed"),
            inArray(documentTransactions.transactionId, transactionIds),
          ),
        )
        .groupBy(documentTransactions.transactionId);
      return new Map(rows.map((r) => [r.transactionId, r.sum]));
    },
  };
}

export function createDrizzlePaymentAliasRepository(db: DbExecutor): PaymentAliasRepository {
  return {
    async upsert(input) {
      const [row] = await db
        .insert(paymentAliases)
        .values(input)
        .onConflictDoUpdate({
          target: [paymentAliases.workspaceId, paymentAliases.counterpartyNameNormalized],
          set: { contactId: input.contactId, learnedFromUserId: input.learnedFromUserId },
        })
        .returning();
      if (!row) throw new Error("upsert into payment_aliases returned no row");
      return row;
    },

    listForWorkspace: (workspaceId) => db.select().from(paymentAliases).where(eq(paymentAliases.workspaceId, workspaceId)),

    async deleteById(workspaceId, id) {
      await db.delete(paymentAliases).where(and(eq(paymentAliases.workspaceId, workspaceId), eq(paymentAliases.id, id)));
    },
  };
}

export function createDrizzlePaymentRejectionRepository(db: DbExecutor): PaymentRejectionRepository {
  return {
    async create(input) {
      await db.insert(paymentRejections).values(input).onConflictDoNothing({ target: [paymentRejections.documentId, paymentRejections.transactionId] });
    },

    listForWorkspace: (workspaceId) => db.select().from(paymentRejections).where(eq(paymentRejections.workspaceId, workspaceId)),
  };
}

export function createDrizzlePaymentNoDocumentRuleRepository(db: DbExecutor): PaymentNoDocumentRuleRepository {
  return {
    async upsert(input) {
      const [row] = await db
        .insert(paymentNoDocumentRules)
        .values(input)
        .onConflictDoUpdate({
          target: [paymentNoDocumentRules.workspaceId, paymentNoDocumentRules.counterpartyNameNormalized],
          set: { createdByUserId: input.createdByUserId },
        })
        .returning();
      if (!row) throw new Error("upsert into payment_no_document_rules returned no row");
      return row;
    },

    listForWorkspace: (workspaceId) => db.select().from(paymentNoDocumentRules).where(eq(paymentNoDocumentRules.workspaceId, workspaceId)),
  };
}
