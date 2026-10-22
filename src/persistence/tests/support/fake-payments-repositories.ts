// Typed in-memory fakes for `DocumentTransactionRepository`/`PaymentAliasRepository`/
// `PaymentRejectionRepository`/`PaymentNoDocumentRuleRepository`/
// `PaymentArbiterAnswerRepository` (WEBAPP_TEMPLATE_SPEC.md
// §10.2): unit tests for `createPaymentsUseCases` inject these instead of mocking with
// `vi.fn()`/`as never` casts.
import type {
  CreateDocumentTransactionRow,
  DocumentTransactionRepository,
  DocumentTransactionRow,
  DocumentTransactionWithDetails,
  PaymentAliasRepository,
  PaymentAliasRow,
  PaymentArbiterAnswerRepository,
  PaymentArbiterAnswerRow,
  PaymentNoDocumentRuleRepository,
  PaymentNoDocumentRuleRow,
  PaymentRejectionRepository,
  PaymentRejectionRow,
} from "@/persistence/repositories/contracts";

export function documentTransactionRow(
  overrides: Partial<DocumentTransactionRow> & Pick<DocumentTransactionRow, "workspaceId" | "documentId" | "transactionId">,
): DocumentTransactionRow {
  return {
    id: crypto.randomUUID(),
    status: "suggested",
    kind: "exact",
    confidence: 0.5,
    reasons: [],
    explanation: null,
    matchedBy: "auto",
    allocatedAmountCents: 0,
    arbiterCacheKey: null,
    createdAt: new Date(0),
    decidedAt: null,
    decidedByUserId: null,
    ...overrides,
  };
}

/** `isConfirmed(transactionId)` for `createFakeTransactionRepository`'s own `listUnmatched`
 * implementation - wires the two fakes together without either one importing the other's
 * internal state shape. */
export function isConfirmedPredicate(state: DocumentTransactionRow[]): (transactionId: string) => boolean {
  return (transactionId) => state.some((r) => r.transactionId === transactionId && r.status === "confirmed");
}

export function createFakeDocumentTransactionRepository(
  seed: DocumentTransactionRow[] = [],
  details: Map<string, Omit<DocumentTransactionWithDetails, keyof DocumentTransactionRow>> = new Map(),
): { repo: DocumentTransactionRepository; state: DocumentTransactionRow[] } {
  const rows = [...seed];

  function withDetails(row: DocumentTransactionRow): DocumentTransactionWithDetails {
    const extra = details.get(row.id) ?? {
      documentOriginalFileName: "dokument.pdf",
      documentTitle: null,
      documentInvoiceNumber: null,
      transactionBookingDate: "2026-01-01",
      transactionAmountCents: 0,
      transactionCurrency: "EUR",
      transactionCounterpartyName: null,
      transactionRemittanceText: null,
    };
    return { ...row, ...extra };
  }

  const repo: DocumentTransactionRepository = {
    async upsertSuggestion(input: CreateDocumentTransactionRow) {
      const existing = rows.find((r) => r.documentId === input.documentId && r.transactionId === input.transactionId);
      if (existing) {
        if (existing.status !== "suggested") return existing;
        Object.assign(existing, { kind: input.kind, confidence: input.confidence, reasons: input.reasons, explanation: input.explanation, arbiterCacheKey: input.arbiterCacheKey });
        return existing;
      }
      const row = documentTransactionRow(input);
      rows.push(row);
      return row;
    },

    async createConfirmed(input: CreateDocumentTransactionRow) {
      const existing = rows.find((r) => r.documentId === input.documentId && r.transactionId === input.transactionId);
      if (existing) {
        Object.assign(existing, input);
        return existing;
      }
      const row = documentTransactionRow(input);
      rows.push(row);
      return row;
    },

    async findById(workspaceId, id) {
      return rows.find((r) => r.id === id && r.workspaceId === workspaceId) ?? null;
    },

    async findByPair(workspaceId, documentId, transactionId) {
      return rows.find((r) => r.workspaceId === workspaceId && r.documentId === documentId && r.transactionId === transactionId) ?? null;
    },

    async findAiSuggestionForTransaction(workspaceId, transactionId) {
      return rows.find((r) => r.workspaceId === workspaceId && r.transactionId === transactionId && r.kind === "ai") ?? null;
    },

    async decide(workspaceId, id, input) {
      const row = rows.find((r) => r.id === id && r.workspaceId === workspaceId);
      if (!row) return null;
      row.status = input.status;
      row.matchedBy = input.matchedBy;
      row.decidedAt = new Date();
      row.decidedByUserId = input.decidedByUserId;
      if (input.allocatedAmountCents !== undefined) row.allocatedAmountCents = input.allocatedAmountCents;
      return row;
    },

    async deleteById(workspaceId, id) {
      const index = rows.findIndex((r) => r.id === id && r.workspaceId === workspaceId);
      if (index !== -1) rows.splice(index, 1);
    },

    async listForDocument(workspaceId, documentId) {
      return rows.filter((r) => r.workspaceId === workspaceId && r.documentId === documentId).map(withDetails);
    },

    async listForTransaction(workspaceId, transactionId) {
      return rows.filter((r) => r.workspaceId === workspaceId && r.transactionId === transactionId).map(withDetails);
    },

    async listSuggestedForWorkspace(workspaceId) {
      return rows.filter((r) => r.workspaceId === workspaceId && r.status === "suggested").map(withDetails);
    },

    async countSuggestedForWorkspace(workspaceId) {
      return rows.filter((r) => r.workspaceId === workspaceId && r.status === "suggested").length;
    },

    async countSuggestedForPeriod(workspaceId, from, to) {
      // Abschluss (decisions/0066-abschluss-check-and-export.md): the real query narrows by
      // the booking date of the JOINED transaction, which this fake has no access to - the
      // DB test (`src/persistence/tests/closing-repository.db.test.ts`) is the authority. The
      // period bounds are accepted and ignored here on purpose.
      void from;
      void to;
      return rows.filter((r) => r.workspaceId === workspaceId && r.status === "suggested").length;
    },

    async sumConfirmedAllocatedByDocument(workspaceId, documentIds) {
      const map = new Map<string, number>();
      for (const row of rows) {
        if (row.workspaceId !== workspaceId || row.status !== "confirmed" || !documentIds.includes(row.documentId)) continue;
        map.set(row.documentId, (map.get(row.documentId) ?? 0) + row.allocatedAmountCents);
      }
      return map;
    },

    async sumConfirmedAllocatedByTransaction(workspaceId, transactionIds) {
      const map = new Map<string, number>();
      for (const row of rows) {
        if (row.workspaceId !== workspaceId || row.status !== "confirmed" || !transactionIds.includes(row.transactionId)) continue;
        map.set(row.transactionId, (map.get(row.transactionId) ?? 0) + row.allocatedAmountCents);
      }
      return map;
    },
  };

  return { repo, state: rows };
}

export function createFakePaymentAliasRepository(seed: PaymentAliasRow[] = []): { repo: PaymentAliasRepository; state: PaymentAliasRow[] } {
  const rows = [...seed];

  const repo: PaymentAliasRepository = {
    async deleteById(workspaceId, id) {
      const index = rows.findIndex((row) => row.workspaceId === workspaceId && row.id === id);
      if (index >= 0) rows.splice(index, 1);
    },
    async upsert(input) {
      const existing = rows.find((r) => r.workspaceId === input.workspaceId && r.counterpartyNameNormalized === input.counterpartyNameNormalized);
      if (existing) {
        existing.contactId = input.contactId;
        existing.learnedFromUserId = input.learnedFromUserId;
        return existing;
      }
      const row: PaymentAliasRow = { id: crypto.randomUUID(), createdAt: new Date(0), ...input };
      rows.push(row);
      return row;
    },

    async listForWorkspace(workspaceId) {
      return rows.filter((r) => r.workspaceId === workspaceId);
    },
  };

  return { repo, state: rows };
}

export function createFakePaymentRejectionRepository(seed: PaymentRejectionRow[] = []): { repo: PaymentRejectionRepository; state: PaymentRejectionRow[] } {
  const rows = [...seed];

  const repo: PaymentRejectionRepository = {
    async create(input) {
      const exists = rows.some((r) => r.documentId === input.documentId && r.transactionId === input.transactionId);
      if (exists) return;
      rows.push({ id: crypto.randomUUID(), createdAt: new Date(0), ...input });
    },

    async listForWorkspace(workspaceId) {
      return rows.filter((r) => r.workspaceId === workspaceId);
    },
  };

  return { repo, state: rows };
}

export function createFakePaymentNoDocumentRuleRepository(
  seed: PaymentNoDocumentRuleRow[] = [],
): { repo: PaymentNoDocumentRuleRepository; state: PaymentNoDocumentRuleRow[] } {
  const rows = [...seed];

  const repo: PaymentNoDocumentRuleRepository = {
    async upsert(input) {
      const existing = rows.find((r) => r.workspaceId === input.workspaceId && r.counterpartyNameNormalized === input.counterpartyNameNormalized);
      if (existing) {
        existing.createdByUserId = input.createdByUserId;
        return existing;
      }
      const row: PaymentNoDocumentRuleRow = { id: crypto.randomUUID(), createdAt: new Date(0), ...input };
      rows.push(row);
      return row;
    },

    async listForWorkspace(workspaceId) {
      return rows.filter((r) => r.workspaceId === workspaceId);
    },
  };

  return { repo, state: rows };
}

export function createFakePaymentArbiterAnswerRepository(
  seed: PaymentArbiterAnswerRow[] = [],
): { repo: PaymentArbiterAnswerRepository; state: PaymentArbiterAnswerRow[] } {
  const rows = [...seed];

  const repo: PaymentArbiterAnswerRepository = {
    async findForTransaction(workspaceId, transactionId) {
      return rows.find((r) => r.workspaceId === workspaceId && r.transactionId === transactionId) ?? null;
    },

    async upsert(input) {
      const existing = rows.find((r) => r.transactionId === input.transactionId);
      if (existing) {
        if (existing.workspaceId !== input.workspaceId) return;
        Object.assign(existing, { cacheKey: input.cacheKey, bestDocumentId: input.bestDocumentId, confidence: input.confidence, reason: input.reason });
        return;
      }
      rows.push({ id: crypto.randomUUID(), answeredAt: new Date(0), ...input });
    },
  };

  return { repo, state: rows };
}
