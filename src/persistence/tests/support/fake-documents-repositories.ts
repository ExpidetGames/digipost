// Typed in-memory fake for `DocumentRepository` (WEBAPP_TEMPLATE_SPEC.md §10.2): unit tests
// for `createDocumentUseCases` inject this instead of mocking with `vi.fn()`/`as never` casts.
import type {
  CreateDocumentRow,
  DocumentRepository,
  DocumentRow,
  DocumentWithRelations,
  IntakeFingerprintRepository,
  IntakeFingerprintRow,
  ListDocumentsFilter,
} from "@/persistence/repositories/contracts";

export function documentRow(overrides: Partial<DocumentRow> & Pick<DocumentRow, "workspaceId" | "storageKey">): DocumentRow {
  return {
    id: crypto.randomUUID(),
    uploadedByUserId: null,
    originalFileName: "dokument.pdf",
    mimeType: "application/pdf",
    pageCount: 1,
    sizeBytes: 1024,
    searchablePdfKey: null,
    fileHash: null,
    kind: "letter",
    manualKind: null,
    platform: null,
    intakeStatus: "not_applicable",
    intakeResult: null,
    status: "uploaded",
    errorCode: null,
    ocrText: null,
    ocrBlocks: null,
    title: null,
    sender: null,
    documentDate: null,
    summary: null,
    direction: null,
    invoiceNumber: null,
    totalAmountCents: null,
    currency: null,
    dueDate: null,
    paymentIban: null,
    paymentReference: null,
    paidNote: null,
    paymentStatus: "not_applicable",
    paidAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    processedAt: null,
    searchVector: "",
    ...overrides,
  };
}

function withRelations(row: DocumentRow, users: Record<string, { email: string; name: string }>): DocumentWithRelations {
  const uploader = row.uploadedByUserId ? users[row.uploadedByUserId] : undefined;
  return {
    ...row,
    uploadedByEmail: uploader?.email ?? null,
  };
}

/** See `countsForPeriod`'s own comment: an in-memory approximation of the shared SQL
 * `documentEffectiveDate`, good enough for fakes that never seed `intakeResult`. */
function fakeEffectiveDate(row: DocumentRow): string {
  return row.documentDate ?? row.createdAt.toISOString().slice(0, 10);
}

export function createFakeDocumentRepository(
  seed: DocumentRow[] = [],
  options: { users?: Record<string, { email: string; name: string }> } = {},
): { repo: DocumentRepository; state: DocumentRow[] } {
  const rows = [...seed];
  const users = options.users ?? {};

  const repo: DocumentRepository = {
    async create(input: CreateDocumentRow) {
      const row = documentRow(input);
      rows.push(row);
      return row;
    },

    async countByWorkspace(workspaceId) {
      return rows.filter((r) => r.workspaceId === workspaceId).length;
    },

    async countPendingIntakeConfirmation(workspaceId) {
      return rows.filter((r) => r.workspaceId === workspaceId && r.intakeStatus === "pending_confirmation").length;
    },

    async countFailed(workspaceId) {
      return rows.filter((r) => r.workspaceId === workspaceId && r.status === "failed").length;
    },

    async countOverduePayments(workspaceId) {
      const todayIso = new Date().toISOString().slice(0, 10);
      return rows.filter((r) => {
        if (r.workspaceId !== workspaceId) return false;
        const effective = (r.paymentStatus === "open" || r.paymentStatus === "partially_paid") && r.dueDate !== null && r.dueDate < todayIso ? "overdue" : r.paymentStatus;
        return effective === "overdue";
      }).length;
    },

    async findByFileHash(workspaceId, fileHash) {
      const row = rows.find((r) => r.workspaceId === workspaceId && r.fileHash !== null && r.fileHash === fileHash);
      return row ? { id: row.id, originalFileName: row.originalFileName } : null;
    },

    async findByInvoiceNumber(workspaceId, invoiceNumber, excludeDocumentId) {
      return rows
        .filter((r) => r.workspaceId === workspaceId && r.invoiceNumber === invoiceNumber && r.id !== excludeDocumentId)
        .map((r) => ({ id: r.id, originalFileName: r.originalFileName, sender: r.sender, totalAmountCents: r.totalAmountCents }));
    },

    async findPaymentStatusByInvoiceNumber(workspaceId, invoiceNumber, excludeDocumentId) {
      return rows
        .filter((r) => r.workspaceId === workspaceId && r.invoiceNumber === invoiceNumber && r.id !== excludeDocumentId)
        .map((r) => ({ id: r.id, paymentStatus: r.paymentStatus, paidAt: r.paidAt }));
    },

    async findById(workspaceId, id) {
      const row = rows.find((r) => r.id === id && r.workspaceId === workspaceId);
      return row ? withRelations(row, users) : null;
    },

    async list(workspaceId, filter: ListDocumentsFilter) {
      let matches = rows.filter((r) => r.workspaceId === workspaceId);
      if (filter.status) matches = matches.filter((r) => r.status === filter.status);
      if (filter.direction) matches = matches.filter((r) => r.direction === filter.direction);
      if (filter.kind) matches = matches.filter((r) => r.kind === filter.kind);
      if (filter.intakeStatus) matches = matches.filter((r) => r.intakeStatus === filter.intakeStatus);
      // decisions/0066: the same approximation of the effective date this fake already uses
      // for `countsForPeriod`/`listForPeriod` (see their own comment below).
      if (filter.from !== undefined) matches = matches.filter((r) => fakeEffectiveDate(r) >= filter.from!);
      if (filter.to !== undefined) matches = matches.filter((r) => fakeEffectiveDate(r) <= filter.to!);
      if (filter.q) {
        const needle = filter.q.toLowerCase();
        matches = matches.filter(
          (r) =>
            (r.title ?? "").toLowerCase().includes(needle) ||
            (r.ocrText ?? "").toLowerCase().includes(needle) ||
            r.originalFileName.toLowerCase().includes(needle),
        );
      }
      matches = [...matches].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      const start = (filter.page - 1) * filter.pageSize;
      const page = matches.slice(start, start + filter.pageSize);
      // decisions/0059-generated-document-names.md: the real repository resolves the
      // counterparty with a correlated subquery over `document_contacts`; this fake owns no
      // contact links at all, so every row reports none and callers fall back as they would
      // for a tabular import.
      return {
        items: page.map((r) => ({ ...withRelations(r, users), counterpartyName: null, reportPeriod: null, statementLastBooking: null })),
        hasMore: matches.length > start + filter.pageSize,
      };
    },

    async deleteById(workspaceId, id) {
      const index = rows.findIndex((r) => r.id === id && r.workspaceId === workspaceId);
      if (index === -1) return null;
      const [row] = rows.splice(index, 1);
      return row ?? null;
    },

    async markProcessing(workspaceId, id) {
      const row = rows.find((r) => r.id === id && r.workspaceId === workspaceId);
      if (!row) return;
      row.status = "processing";
      row.errorCode = null;
      row.updatedAt = new Date();
    },

    async markProcessingWithManualKind(workspaceId, id, manualKind) {
      const row = rows.find((r) => r.id === id && r.workspaceId === workspaceId);
      if (!row) return;
      row.status = "processing";
      row.errorCode = null;
      row.manualKind = manualKind;
      row.updatedAt = new Date();
    },

    async markDone(workspaceId, id, input) {
      const row = rows.find((r) => r.id === id && r.workspaceId === workspaceId);
      if (!row) return;
      row.status = "done";
      row.ocrText = input.ocrText;
      row.ocrBlocks = input.ocrBlocks;
      row.title = input.title;
      row.sender = input.sender;
      row.documentDate = input.documentDate;
      row.summary = input.summary;
      row.searchablePdfKey = input.searchablePdfKey;
      row.direction = input.direction;
      row.invoiceNumber = input.invoiceNumber;
      row.totalAmountCents = input.totalAmountCents;
      row.currency = input.currency;
      row.dueDate = input.dueDate;
      row.paymentIban = input.paymentIban;
      row.paymentReference = input.paymentReference;
      row.paidNote = input.paidNote;
      row.kind = input.kind;
      row.paymentStatus = input.paymentStatus;
      row.paidAt = null;
      row.errorCode = null;
      row.processedAt = new Date();
      row.updatedAt = new Date();
    },

    async markFailed(workspaceId, id, errorCode) {
      const row = rows.find((r) => r.id === id && r.workspaceId === workspaceId);
      if (!row) return;
      row.status = "failed";
      row.errorCode = errorCode;
      row.updatedAt = new Date();
    },

    async markIntakeResult(workspaceId, id, input) {
      const row = rows.find((r) => r.id === id && r.workspaceId === workspaceId);
      if (!row) return;
      row.status = "done";
      row.kind = input.kind;
      row.platform = input.platform;
      row.intakeStatus = input.intakeStatus;
      row.intakeResult = input.intakeResult;
      row.errorCode = null;
      row.processedAt = new Date();
      row.updatedAt = new Date();
    },

    async confirmIntake(workspaceId, id, input) {
      const row = rows.find((r) => r.id === id && r.workspaceId === workspaceId);
      if (!row) return;
      row.kind = input.kind;
      row.platform = input.platform;
      row.intakeStatus = "confirmed";
      row.intakeResult = input.intakeResult;
      row.updatedAt = new Date();
    },

    async rejectIntake(workspaceId, id) {
      const row = rows.find((r) => r.id === id && r.workspaceId === workspaceId);
      if (!row) return;
      row.intakeStatus = "rejected";
      row.updatedAt = new Date();
    },

    async updatePaymentStatus(workspaceId, id, input) {
      const row = rows.find((r) => r.id === id && r.workspaceId === workspaceId);
      if (!row) return;
      row.paymentStatus = input.paymentStatus;
      row.paidAt = input.paidAt;
      row.updatedAt = new Date();
    },

    async listInvoiceCandidates(workspaceId, range) {
      return rows.filter(
        (r) =>
          r.workspaceId === workspaceId &&
          (r.direction === "incoming" || r.direction === "outgoing") &&
          ["open", "partially_paid", "overdue"].includes(r.paymentStatus) &&
          (range?.from === undefined || fakeEffectiveDate(r) >= range.from) &&
          (range?.to === undefined || fakeEffectiveDate(r) <= range.to),
      );
    },

    async listIntakeRejectedBefore(cutoff) {
      return rows
        .filter((r) => r.intakeStatus === "rejected" && r.updatedAt.getTime() < cutoff.getTime())
        .map((r) => ({ id: r.id, workspaceId: r.workspaceId }));
    },

    async listConfirmedSettlementReports(workspaceId, platform) {
      return rows
        .filter(
          (r) =>
            r.workspaceId === workspaceId &&
            r.intakeStatus === "confirmed" &&
            r.platform === platform &&
            (r.kind === "payout_report" || r.kind === "platform_settlement"),
        )
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .map((r) => ({ id: r.id, intakeResult: r.intakeResult }));
    },

    // --- Abschluss (decisions/0066-abschluss-check-and-export.md). The AUTHORITATIVE
    // definition of a document's effective date is the shared SQL expression
    // `documentEffectiveDate` (`repositories/drizzle/documents-repository.ts`), covered by
    // `src/persistence/tests/closing-repository.db.test.ts` against real Postgres. The
    // approximation below (own date, else the day it arrived) is enough for the in-memory
    // use-case tests, which never seed an app-store report's period or a statement's last
    // booking into `intakeResult`. ---

    async countsForPeriod(workspaceId, from, to) {
      const todayIso = new Date().toISOString().slice(0, 10);
      const inPeriod = rows.filter((r) => r.workspaceId === workspaceId && fakeEffectiveDate(r) >= from && fakeEffectiveDate(r) <= to);
      const effectiveStatus = (r: DocumentRow): string =>
        (r.paymentStatus === "open" || r.paymentStatus === "partially_paid") && r.dueDate !== null && r.dueDate < todayIso ? "overdue" : r.paymentStatus;
      return {
        total: inPeriod.length,
        openOrOverduePayments: inPeriod.filter((r) => ["open", "overdue"].includes(effectiveStatus(r))).length,
        pendingIntakeConfirmation: inPeriod.filter((r) => r.intakeStatus === "pending_confirmation").length,
        failedProcessing: inPeriod.filter((r) => r.status === "failed").length,
      };
    },

    async listForPeriod(workspaceId, from, to) {
      const todayIso = new Date().toISOString().slice(0, 10);
      return rows
        .filter((r) => r.workspaceId === workspaceId && fakeEffectiveDate(r) >= from && fakeEffectiveDate(r) <= to)
        .sort((a, b) => fakeEffectiveDate(a).localeCompare(fakeEffectiveDate(b)) || a.id.localeCompare(b.id))
        .map((r) => ({
          id: r.id,
          effectiveDate: fakeEffectiveDate(r),
          originalFileName: r.originalFileName,
          mimeType: r.mimeType,
          searchablePdfKey: r.searchablePdfKey,
          kind: r.kind,
          platform: r.platform,
          direction: r.direction,
          documentDate: r.documentDate,
          sender: r.sender,
          counterpartyName: null,
          reportPeriod: null,
          statementLastBooking: null,
          invoiceNumber: r.invoiceNumber,
          totalAmountCents: r.totalAmountCents,
          currency: r.currency,
          paymentStatus:
            (r.paymentStatus === "open" || r.paymentStatus === "partially_paid") && r.dueDate !== null && r.dueDate < todayIso
              ? "overdue"
              : r.paymentStatus,
          // No link bookkeeping in the fake: the export's cross references are proved
          // against real Postgres (`closing-repository.db.test.ts`) and, in the module
          // itself, against literal rows (`src/modules/closing/tests/export.test.ts`).
          confirmedTransactions: [],
        }));
    },
  };

  return { repo, state: rows };
}

export function createFakeIntakeFingerprintRepository(
  seed: IntakeFingerprintRow[] = [],
): { repo: IntakeFingerprintRepository; state: IntakeFingerprintRow[] } {
  const rows = [...seed];

  const repo: IntakeFingerprintRepository = {
    async findByFingerprint(workspaceId, fingerprint) {
      return rows.find((r) => r.workspaceId === workspaceId && r.fingerprint === fingerprint) ?? null;
    },

    async upsertConfirmed(input) {
      const existing = rows.find((r) => r.workspaceId === input.workspaceId && r.fingerprint === input.fingerprint);
      const now = new Date();
      if (existing) {
        existing.documentKind = input.documentKind;
        existing.platform = input.platform;
        existing.columnMapping = input.columnMapping;
        existing.amountSign = input.amountSign;
        existing.confirmedByUserId = input.confirmedByUserId;
        existing.confirmedAt = now;
        existing.lastUsedAt = now;
        existing.useCount = 1;
        return existing;
      }
      const row: IntakeFingerprintRow = {
        id: crypto.randomUUID(),
        workspaceId: input.workspaceId,
        fingerprint: input.fingerprint,
        documentKind: input.documentKind,
        platform: input.platform,
        columnMapping: input.columnMapping,
        amountSign: input.amountSign,
        confirmedByUserId: input.confirmedByUserId,
        confirmedAt: now,
        lastUsedAt: now,
        useCount: 1,
      };
      rows.push(row);
      return row;
    },

    async touchUsage(id) {
      const row = rows.find((r) => r.id === id);
      if (!row) return;
      row.lastUsedAt = new Date();
      row.useCount += 1;
    },

    async listForWorkspace(workspaceId) {
      return rows.filter((r) => r.workspaceId === workspaceId).sort((a, b) => b.lastUsedAt.getTime() - a.lastUsedAt.getTime());
    },

    async remove(workspaceId, id) {
      const index = rows.findIndex((r) => r.id === id && r.workspaceId === workspaceId);
      if (index !== -1) rows.splice(index, 1);
    },
  };

  return { repo, state: rows };
}
