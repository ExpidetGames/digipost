// Typed in-memory fakes for `AccountRepository`/`TransactionRepository`/`ImportBatchRepository`
// (WEBAPP_TEMPLATE_SPEC.md §10.2): unit tests for `createAccountsUseCases` inject these
// instead of mocking with `vi.fn()`/`as never` casts.
import type {
  AccountRepository,
  AccountRow,
  CreateAccountRow,
  CreateSettlementLineRow,
  CreateTransactionRow,
  ImportBatchRepository,
  ImportBatchRow,
  SettlementLineRepository,
  SettlementLineRow,
  TransactionListFilter,
  TransactionRepository,
  TransactionRow,
  UpsertImportBatchRow,
} from "@/persistence/repositories/contracts";

export function accountRow(overrides: Partial<AccountRow> & Pick<AccountRow, "workspaceId">): AccountRow {
  return {
    id: crypto.randomUUID(),
    type: "bank",
    name: "Testkonto",
    iban: null,
    bic: null,
    currency: "EUR",
    holder: null,
    platform: null,
    contactId: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

export function transactionRow(overrides: Partial<TransactionRow> & Pick<TransactionRow, "workspaceId" | "accountId" | "idempotencyKey">): TransactionRow {
  return {
    id: crypto.randomUUID(),
    bookingDate: "2026-01-01",
    valueDate: null,
    amountCents: 0,
    currency: "EUR",
    creditDebit: "credit",
    counterpartyName: null,
    counterpartyIban: null,
    counterpartyBic: null,
    remittanceText: null,
    endToEndId: null,
    mandateId: null,
    creditorId: null,
    bankTxCode: null,
    bankReference: null,
    importBatchId: null,
    sourceDocumentId: null,
    transferGroupId: null,
    raw: null,
    noDocumentNeeded: false,
    createdAt: new Date(0),
    ...overrides,
  };
}

export function importBatchRow(overrides: Partial<ImportBatchRow> & Pick<ImportBatchRow, "workspaceId" | "accountId">): ImportBatchRow {
  return {
    id: crypto.randomUUID(),
    sourceDocumentId: null,
    statementFrom: null,
    statementTo: null,
    openingBalanceCents: null,
    closingBalanceCents: null,
    rowsTotal: 0,
    rowsImported: 0,
    rowsDuplicate: 0,
    balanceMismatch: false,
    createdAt: new Date(0),
    ...overrides,
  };
}

export function createFakeAccountRepository(seed: AccountRow[] = []): { repo: AccountRepository; state: AccountRow[] } {
  const rows = [...seed];

  const repo: AccountRepository = {
    async create(input: CreateAccountRow) {
      const row = accountRow({ ...input, contactId: input.contactId ?? null });
      rows.push(row);
      return row;
    },

    async update(workspaceId, id, input) {
      const row = rows.find((r) => r.id === id && r.workspaceId === workspaceId);
      if (!row) return null;
      Object.assign(row, input, { updatedAt: new Date() });
      return row;
    },

    async findById(workspaceId, id) {
      return rows.find((r) => r.id === id && r.workspaceId === workspaceId) ?? null;
    },

    async findByIban(workspaceId, iban) {
      return rows.find((r) => r.workspaceId === workspaceId && r.iban === iban) ?? null;
    },

    async findByPlatform(workspaceId, platform) {
      return rows.find((r) => r.workspaceId === workspaceId && r.type === "clearing" && r.platform === platform) ?? null;
    },

    async findByContact(workspaceId, contactId) {
      return rows.find((r) => r.workspaceId === workspaceId && r.type === "clearing" && r.contactId === contactId) ?? null;
    },

    async listForWorkspace(workspaceId) {
      return rows.filter((r) => r.workspaceId === workspaceId);
    },
  };

  return { repo, state: rows };
}

export function createFakeTransactionRepository(
  seed: TransactionRow[] = [],
  options: { isConfirmed?: (transactionId: string) => boolean; accounts?: { id: string; type: string; name?: string }[] } = {},
): { repo: TransactionRepository; state: TransactionRow[] } {
  const rows = [...seed];
  const isConfirmed = options.isConfirmed ?? (() => false);
  const accountTypeById = new Map((options.accounts ?? []).map((a) => [a.id, a.type]));
  const accountNameById = new Map((options.accounts ?? []).map((a) => [a.id, a.name ?? a.id]));

  const repo: TransactionRepository = {
    async findById(workspaceId, id) {
      return rows.find((r) => r.id === id && r.workspaceId === workspaceId) ?? null;
    },

    async insertManyIdempotent(input: CreateTransactionRow[]) {
      const inserted: TransactionRow[] = [];
      for (const item of input) {
        const exists = rows.some((r) => r.accountId === item.accountId && r.idempotencyKey === item.idempotencyKey);
        if (exists) continue;
        const row = transactionRow(item);
        rows.push(row);
        inserted.push(row);
      }
      return inserted;
    },

    async assignBatch(transactionIds, importBatchId) {
      for (const row of rows) {
        if (transactionIds.includes(row.id)) row.importBatchId = importBatchId;
      }
    },

    async list(workspaceId, accountId, filter: TransactionListFilter) {
      let matches = rows.filter((r) => r.workspaceId === workspaceId && r.accountId === accountId);
      if (filter.dateFrom) matches = matches.filter((r) => r.bookingDate >= filter.dateFrom!);
      if (filter.dateTo) matches = matches.filter((r) => r.bookingDate <= filter.dateTo!);
      if (filter.minAmountCents !== undefined) matches = matches.filter((r) => r.amountCents >= filter.minAmountCents!);
      if (filter.maxAmountCents !== undefined) matches = matches.filter((r) => r.amountCents <= filter.maxAmountCents!);
      if (filter.creditDebit) matches = matches.filter((r) => r.creditDebit === filter.creditDebit);
      if (filter.q) {
        const needle = filter.q.toLowerCase();
        matches = matches.filter(
          (r) => r.counterpartyName?.toLowerCase().includes(needle) || r.remittanceText?.toLowerCase().includes(needle),
        );
      }
      matches = [...matches].sort((a, b) => (a.bookingDate < b.bookingDate ? 1 : -1));
      const start = (filter.page - 1) * filter.pageSize;
      const page = matches.slice(start, start + filter.pageSize + 1);
      const hasMore = page.length > filter.pageSize;
      return { items: hasMore ? page.slice(0, filter.pageSize) : page, hasMore };
    },

    async sumAmountCents(workspaceId, accountId, accountCurrency) {
      const matches = rows.filter((r) => r.workspaceId === workspaceId && r.accountId === accountId);
      const amountCents = matches
        .filter((r) => r.currency === null || r.currency === accountCurrency)
        .reduce((sum, r) => sum + r.amountCents, 0);
      const hasMixedCurrency = matches.some((r) => r.currency !== null && r.currency !== accountCurrency);
      return { amountCents, hasMixedCurrency };
    },

    async listForMatching(workspaceId, filter) {
      let matches = rows.filter((r) => r.workspaceId === workspaceId && !r.noDocumentNeeded && accountTypeById.get(r.accountId) !== "clearing");
      if (filter.dateFrom) matches = matches.filter((r) => r.bookingDate >= filter.dateFrom!);
      if (filter.dateTo) matches = matches.filter((r) => r.bookingDate <= filter.dateTo!);
      if (filter.minAmountCents !== undefined) matches = matches.filter((r) => r.amountCents >= filter.minAmountCents!);
      if (filter.maxAmountCents !== undefined) matches = matches.filter((r) => r.amountCents <= filter.maxAmountCents!);
      if (filter.counterpartyIban) matches = matches.filter((r) => r.counterpartyIban === filter.counterpartyIban);
      if (filter.excludeId) matches = matches.filter((r) => r.id !== filter.excludeId);
      matches = [...matches].sort((a, b) => (a.bookingDate < b.bookingDate ? 1 : -1));
      return matches.slice(0, filter.limit);
    },

    async listUnmatched(workspaceId, filter) {
      const matches = rows.filter(
        (r) =>
          r.workspaceId === workspaceId &&
          !r.noDocumentNeeded &&
          !isConfirmed(r.id) &&
          accountTypeById.get(r.accountId) !== "clearing" &&
          // decisions/0066: the same inclusive `booking_date` bounds `countsForPeriod` uses.
          (filter.from === undefined || r.bookingDate >= filter.from) &&
          (filter.to === undefined || r.bookingDate <= filter.to),
      );
      const sorted = [...matches].sort((a, b) => (a.bookingDate < b.bookingDate ? 1 : -1));
      const start = (filter.page - 1) * filter.pageSize;
      const page = sorted.slice(start, start + filter.pageSize + 1);
      const hasMore = page.length > filter.pageSize;
      return { items: hasMore ? page.slice(0, filter.pageSize) : page, hasMore };
    },

    async countUnmatched(workspaceId) {
      return rows.filter((r) => r.workspaceId === workspaceId && !r.noDocumentNeeded && !isConfirmed(r.id) && accountTypeById.get(r.accountId) !== "clearing").length;
    },

    // --- Abschluss (decisions/0066-abschluss-check-and-export.md). `unmatched` repeats
    // `countUnmatched` above (which is itself the in-memory mirror of the one shared SQL
    // condition builder); the real behaviour is covered against Postgres by
    // `src/persistence/tests/closing-repository.db.test.ts`. ---

    async countsForPeriod(workspaceId, from, to) {
      const inPeriod = rows.filter((r) => r.workspaceId === workspaceId && r.bookingDate >= from && r.bookingDate <= to);
      return {
        total: inPeriod.length,
        unmatched: inPeriod.filter((r) => !r.noDocumentNeeded && !isConfirmed(r.id) && accountTypeById.get(r.accountId) !== "clearing").length,
      };
    },

    async listForPeriod(workspaceId, from, to) {
      return rows
        .filter((r) => r.workspaceId === workspaceId && r.bookingDate >= from && r.bookingDate <= to)
        .sort((a, b) => a.bookingDate.localeCompare(b.bookingDate) || a.id.localeCompare(b.id))
        .map((r) => ({
          id: r.id,
          bookingDate: r.bookingDate,
          accountName: accountNameById.get(r.accountId) ?? r.accountId,
          amountCents: r.amountCents,
          currency: r.currency ?? "EUR",
          counterpartyName: r.counterpartyName,
          remittanceText: r.remittanceText,
          noDocumentNeeded: r.noDocumentNeeded,
          // The fake knows a transaction is matched, never by which document: a synthetic
          // link keeps `.length` (and so the sheet's "Status") honest, while the real link
          // data is proved against Postgres in `closing-repository.db.test.ts`.
          confirmedDocuments: isConfirmed(r.id)
            ? [
                {
                  id: `document-for-${r.id}`,
                  effectiveDate: r.bookingDate,
                  amountCents: r.amountCents,
                  currency: r.currency ?? "EUR",
                  allocatedAmountCents: Math.abs(r.amountCents),
                },
              ]
            : [],
        }));
    },

    async markNoDocumentNeeded(workspaceId, transactionIds) {
      for (const row of rows) {
        if (row.workspaceId === workspaceId && transactionIds.includes(row.id)) row.noDocumentNeeded = true;
      }
    },

    async findByIdempotencyKeys(accountId, idempotencyKeys) {
      return rows.filter((r) => r.accountId === accountId && idempotencyKeys.includes(r.idempotencyKey));
    },

    async setTransferGroup(transactionIds, transferGroupId) {
      for (const row of rows) {
        if (transactionIds.includes(row.id)) row.transferGroupId = transferGroupId;
      }
    },

    async findUnpairedBankMatch(workspaceId, candidate) {
      const bankTransactions = rows.filter(
        (r) => r.workspaceId === workspaceId && accountTypeById.get(r.accountId) === "bank" && r.transferGroupId === null,
      );
      if (candidate.payoutId) {
        const byReference = bankTransactions.find((r) => r.remittanceText?.includes(candidate.payoutId!));
        if (byReference) return byReference;
      }
      const from = new Date(candidate.bookingDate);
      const byAmountAndDate = bankTransactions.find((r) => {
        if (r.amountCents !== candidate.amountCents) return false;
        const days = Math.abs((new Date(r.bookingDate).getTime() - from.getTime()) / (24 * 60 * 60 * 1000));
        return days <= 3;
      });
      return byAmountAndDate ?? null;
    },
  };

  return { repo, state: rows };
}

export function settlementLineRow(overrides: Partial<SettlementLineRow> & Pick<SettlementLineRow, "workspaceId" | "clearingAccountId" | "sourceDocumentId" | "externalLineId" | "type">): SettlementLineRow {
  return {
    id: crypto.randomUUID(),
    transactionId: null,
    grossCents: null,
    feeCents: null,
    netCents: null,
    currency: null,
    bookingDate: null,
    payoutId: null,
    chargeId: null,
    invoiceId: null,
    customerName: null,
    customerEmail: null,
    productName: null,
    countryOfSale: null,
    createdAt: new Date(0),
    ...overrides,
  };
}

export function createFakeSettlementLineRepository(seed: SettlementLineRow[] = []): { repo: SettlementLineRepository; state: SettlementLineRow[] } {
  const rows = [...seed];

  const repo: SettlementLineRepository = {
    async insertManyIdempotent(input: CreateSettlementLineRow[]) {
      const inserted: SettlementLineRow[] = [];
      for (const item of input) {
        const exists = rows.some((r) => r.sourceDocumentId === item.sourceDocumentId && r.externalLineId === item.externalLineId);
        if (exists) continue;
        const row = settlementLineRow(item);
        rows.push(row);
        inserted.push(row);
      }
      return inserted;
    },

    async listForDocument(workspaceId, documentId) {
      return rows.filter((r) => r.workspaceId === workspaceId && r.sourceDocumentId === documentId);
    },

    async sumFeeCentsForAccountAndPeriod(clearingAccountId, monthStart, monthEnd) {
      return rows
        .filter((r) => r.clearingAccountId === clearingAccountId && r.type === "fee" && r.bookingDate !== null && r.bookingDate >= monthStart && r.bookingDate <= monthEnd)
        .reduce((sum, r) => sum + (r.feeCents ?? 0), 0);
    },

    async listUnpairedPayoutLines() {
      return [];
    },
  };

  return { repo, state: rows };
}

export function createFakeImportBatchRepository(
  seed: ImportBatchRow[] = [],
  documents: { id: string; workspaceId: string; originalFileName: string; createdAt: Date; kind: string; intakeStatus: string }[] = [],
): { repo: ImportBatchRepository; state: ImportBatchRow[] } {
  const rows = [...seed];

  const repo: ImportBatchRepository = {
    async upsertForDocument(input: UpsertImportBatchRow) {
      const existing = input.sourceDocumentId ? rows.find((r) => r.sourceDocumentId === input.sourceDocumentId) : undefined;
      if (existing) {
        Object.assign(existing, input);
        return existing;
      }
      const row = importBatchRow(input);
      rows.push(row);
      return row;
    },

    async listForAccount(workspaceId, accountId) {
      return rows.filter((r) => r.workspaceId === workspaceId && r.accountId === accountId);
    },

    async findBySourceDocumentId(workspaceId, sourceDocumentId) {
      return rows.find((r) => r.workspaceId === workspaceId && r.sourceDocumentId === sourceDocumentId) ?? null;
    },

    async listPendingAccountDocuments(workspaceId) {
      return documents
        .filter((d) => d.workspaceId === workspaceId && d.kind === "bank_statement" && d.intakeStatus === "confirmed")
        .filter((d) => !rows.some((r) => r.sourceDocumentId === d.id))
        .map((d) => ({ id: d.id, originalFileName: d.originalFileName, createdAt: d.createdAt }));
    },
  };

  return { repo, state: rows };
}
