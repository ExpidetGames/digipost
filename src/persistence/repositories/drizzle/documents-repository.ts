// Owner: src/modules/documents (decisions/0015-documents-and-quotas.md). Encapsulates
// access only: no validation, no status transitions, no external calls
// (WEBAPP_TEMPLATE_SPEC.md §5.3). Every workspace-scoped method takes `workspaceId` and
// filters on it explicitly.
import { and, asc, desc, eq, inArray, lt, ne, or, sql, type SQL } from "drizzle-orm";

import type { DateRange } from "@/shared/date-range";
import type { DbExecutor } from "@/persistence/foundation/db-types";
import { user } from "@/persistence/schema/auth";
import { documents } from "@/persistence/schema/documents";
import type {
  ClosingDocumentRow,
  ClosingLinkedTransaction,
  DocumentRepository,
  DocumentWithRelations,
} from "@/persistence/repositories/contracts/documents-repository";

// F3b (decisions/0025-payment-matching-wiring.md): the SQL mirror of `@/modules/payments`'s
// `resolveDisplayStatus` - a stored `open`/`partially_paid` row whose due date has already
// passed reads as `overdue` for filtering purposes too, without a write (see that function's
// own header comment for why `documents.payment_status` is not kept live-updated by a clock).
const effectivePaymentStatus = sql<string>`(case when ${documents.paymentStatus} in ('open', 'partially_paid') and ${documents.dueDate} < current_date then 'overdue' else ${documents.paymentStatus} end)`;

// decisions/0060-app-store-reports-are-named-by-their-period.md: an Apple or Google report
// carries no document date, it covers a month. Both readers already store that month in
// `intakeResult.appStorePayout.period` as `YYYY-MM` (decisions/0048), so it is read from there
// rather than duplicated into a column of its own. The regex guard keeps `to_date` from ever
// seeing something that is not a period.
const reportPeriod = sql<string | null>`documents.intake_result->'appStorePayout'->>'period'`;
const reportPeriodEnd = sql`case when ${reportPeriod} ~ '^[0-9]{4}-[0-9]{2}$'
  then (to_date(${reportPeriod} || '-01', 'YYYY-MM-DD') + interval '1 month' - interval '1 day')::date end`;

// decisions/0061-a-statement-is-dated-by-its-last-booking.md: a bank statement is dated by its
// latest booking, which its reader records over every parsed transaction (so truncation cannot
// move the date). Guarded the same way as the period above.
const statementLastBooking = sql<string | null>`documents.intake_result->>'lastBookingDate'`;
// The parentheses around the cast are load-bearing: `::` binds tighter than `->>`, so
// `intake_result->>'lastBookingDate'::date` would cast the KEY, not the value, and every query
// using this expression fails for every row.
const statementDate = sql`case when ${statementLastBooking} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then (${statementLastBooking})::date end`;

/**
 * THE date that decides which day (and so which month, and which year) a document belongs to:
 * its own date, else the end of the month an app-store report covers
 * (decisions/0060-app-store-reports-are-named-by-their-period.md), else a bank statement's last
 * booking (decisions/0061-a-statement-is-dated-by-its-last-booking.md), else the day it arrived
 * (decisions/0058-inbox-sorts-by-the-document-s-own-date.md).
 *
 * Exported and shared on purpose (decisions/0066-abschluss-check-and-export.md): the inbox's
 * own ordering and the Abschluss's period scoping are the SAME expression, so the two can never
 * disagree about which month a document belongs to. `coalesce` (rather than `nulls last`) keeps
 * a document with no own date in the timeline instead of collecting every one of them at the
 * very end; `created_at` is a timestamp and `document_date` a date, so the cast makes every arm
 * of the coalesce one type.
 *
 * Every column below is written as already-qualified `documents.<column>` SQL text rather
 * than as a `${documents.x}` column proxy, for the reason `list`'s counterparty subquery
 * spells out: drizzle only table-qualifies a proxy when the OUTER query needs the
 * disambiguation, so in a query with a join it would compile to a bare column name that binds
 * to whatever else is in scope. Spelling the table out makes this expression safe in any
 * scope that has an unaliased `documents` in its `from` - which is what lets the transaction
 * side share it too (`accounts-repository.ts`'s `listForPeriod` reads a linked document's
 * effective date with this very expression, inside a joined query).
 */
export const documentEffectiveDate = sql<string>`coalesce(documents.document_date, ${reportPeriodEnd}, ${statementDate}, documents.created_at::date)`;

/**
 * decisions/0066: a platform report carries NO `total_amount_cents` at all (true for all 24 of
 * the owner's Apple/Google reports) - its amount only exists as the sum of its own settlement
 * lines. Exported and shared for the same reason as the effective date above: the "Dokumente"
 * sheet and the "Buchungen" sheet's own linked-document references must show one document the
 * same amount, whichever side reads it.
 */
export const documentTotalAmountCents = sql<number | null>`coalesce(documents.total_amount_cents, (
  select sum(sl.net_cents)::int from settlement_lines sl where sl.source_document_id = documents.id
))`;

export const documentCurrency = sql<string | null>`coalesce(documents.currency, (
  select sl.currency from settlement_lines sl
  where sl.source_document_id = documents.id and sl.currency is not null limit 1
))`;

/** decisions/0059-generated-document-names.md: the contact this document is WITH, which its
 * direction decides (the sender of an incoming document, the recipient of an outgoing one). A
 * correlated scalar subquery rather than a join on purpose: a document may legitimately carry
 * more than one contact in the same role (a debt collector writing for a creditor,
 * decisions/0019-contacts.md), and a join would then return that document twice and break
 * offset pagination. `limit 1` with the oldest link first makes the choice deterministic.
 *
 * `documents.id`/`documents.direction` are written as literal, already-qualified SQL text here
 * (never `${documents.id}` column-proxy interpolation): drizzle only table-qualifies a column
 * reference when the outer query actually needs the disambiguation (e.g. when it has a join) -
 * with no join on these queries, `${documents.id}` compiles down to a bare, unqualified `"id"`,
 * which inside THIS subquery's own scope collides with `contacts.id` (aliased `c`) and
 * silently binds to the wrong table, breaking the correlation entirely (P6-style regression,
 * caught by this file's own "list resolves the counterparty" test). Spelling the table name
 * out explicitly sidesteps that qualification heuristic altogether. */
const counterpartyName = sql<string | null>`(
  select c.name
  from document_contacts dc
  join contacts c on c.id = dc.contact_id
  where dc.document_id = documents.id
    and dc.role = case when documents.direction = 'outgoing' then 'recipient' else 'sender' end
  order by dc.created_at, c.name
  limit 1
)`;

/**
 * The inclusive `from`/`to` bounds of a `DateRange`, as conditions on the shared effective
 * date (decisions/0066-abschluss-check-and-export.md). Either bound may be absent; an absent
 * one simply contributes no condition, so an unfiltered caller is unaffected.
 *
 * Written as two one-sided comparisons rather than `between`, since `between` would need
 * both bounds present. The values are already-validated ISO dates
 * (`@/shared/date-range`'s `isIsoDate`) and travel as bound parameters regardless.
 */
function effectiveDateRangeConditions(range: DateRange): SQL[] {
  const conditions: SQL[] = [];
  if (range.from !== undefined) conditions.push(sql`${documentEffectiveDate} >= ${range.from}::date`);
  if (range.to !== undefined) conditions.push(sql`${documentEffectiveDate} <= ${range.to}::date`);
  return conditions;
}

export function createDrizzleDocumentRepository(db: DbExecutor): DocumentRepository {
  const selectColumns = {
    id: documents.id,
    workspaceId: documents.workspaceId,
    uploadedByUserId: documents.uploadedByUserId,
    originalFileName: documents.originalFileName,
    mimeType: documents.mimeType,
    pageCount: documents.pageCount,
    sizeBytes: documents.sizeBytes,
    storageKey: documents.storageKey,
    searchablePdfKey: documents.searchablePdfKey,
    fileHash: documents.fileHash,
    kind: documents.kind,
    manualKind: documents.manualKind,
    platform: documents.platform,
    intakeStatus: documents.intakeStatus,
    intakeResult: documents.intakeResult,
    status: documents.status,
    errorCode: documents.errorCode,
    ocrText: documents.ocrText,
    ocrBlocks: documents.ocrBlocks,
    title: documents.title,
    sender: documents.sender,
    documentDate: documents.documentDate,
    summary: documents.summary,
    direction: documents.direction,
    invoiceNumber: documents.invoiceNumber,
    totalAmountCents: documents.totalAmountCents,
    currency: documents.currency,
    dueDate: documents.dueDate,
    paymentIban: documents.paymentIban,
    paymentReference: documents.paymentReference,
    paidNote: documents.paidNote,
    paymentStatus: documents.paymentStatus,
    paidAt: documents.paidAt,
    createdAt: documents.createdAt,
    updatedAt: documents.updatedAt,
    processedAt: documents.processedAt,
    searchVector: documents.searchVector,
  };

  return {
    async create(input) {
      const [row] = await db.insert(documents).values(input).returning();
      if (!row) throw new Error("insert into documents returned no row");
      return row;
    },

    async findByFileHash(workspaceId, fileHash) {
      const [row] = await db
        .select({ id: documents.id, originalFileName: documents.originalFileName })
        .from(documents)
        .where(and(eq(documents.workspaceId, workspaceId), eq(documents.fileHash, fileHash)))
        .limit(1);
      return row ?? null;
    },

    async countByWorkspace(workspaceId) {
      // A real SQL `count(*)` (P6 review finding A7): the previous `select` + `.length`
      // pulled every row (and every selected column) across the network just to count
      // them, and ran inside the workspace row lock (`createFromUpload`'s transaction,
      // decisions/0015-documents-and-quotas.md) - the more documents a workspace has, the
      // longer that lock is held, needlessly serializing concurrent uploads for longer.
      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(documents)
        .where(eq(documents.workspaceId, workspaceId));
      return row?.count ?? 0;
    },

    async countPendingIntakeConfirmation(workspaceId) {
      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(documents)
        .where(and(eq(documents.workspaceId, workspaceId), eq(documents.intakeStatus, "pending_confirmation")));
      return row?.count ?? 0;
    },

    async countFailed(workspaceId) {
      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(documents)
        .where(and(eq(documents.workspaceId, workspaceId), eq(documents.status, "failed")));
      return row?.count ?? 0;
    },

    async countOverduePayments(workspaceId) {
      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(documents)
        .where(and(eq(documents.workspaceId, workspaceId), eq(effectivePaymentStatus, "overdue")));
      return row?.count ?? 0;
    },

    async findByInvoiceNumber(workspaceId, invoiceNumber, excludeDocumentId) {
      return db
        .select({
          id: documents.id,
          originalFileName: documents.originalFileName,
          sender: documents.sender,
          totalAmountCents: documents.totalAmountCents,
        })
        .from(documents)
        .where(and(eq(documents.workspaceId, workspaceId), eq(documents.invoiceNumber, invoiceNumber), ne(documents.id, excludeDocumentId)));
    },

    async findPaymentStatusByInvoiceNumber(workspaceId, invoiceNumber, excludeDocumentId) {
      return db
        .select({ id: documents.id, paymentStatus: documents.paymentStatus, paidAt: documents.paidAt })
        .from(documents)
        .where(and(eq(documents.workspaceId, workspaceId), eq(documents.invoiceNumber, invoiceNumber), ne(documents.id, excludeDocumentId)));
    },

    async findById(workspaceId, id) {
      const [row] = await db
        .select(selectColumns)
        .from(documents)
        .where(and(eq(documents.id, id), eq(documents.workspaceId, workspaceId)))
        .limit(1);
      if (!row) return null;
      const uploaderRow = row.uploadedByUserId
        ? await db.select({ email: user.email }).from(user).where(eq(user.id, row.uploadedByUserId)).limit(1)
        : [];
      return { ...row, uploadedByEmail: uploaderRow[0]?.email ?? null } satisfies DocumentWithRelations;
    },

    async list(workspaceId, filter) {
      const conditions = [eq(documents.workspaceId, workspaceId)];
      if (filter.status) conditions.push(eq(documents.status, filter.status));
      if (filter.direction) conditions.push(eq(documents.direction, filter.direction));
      if (filter.kind) conditions.push(eq(documents.kind, filter.kind));
      if (filter.paymentStatus) conditions.push(eq(effectivePaymentStatus, filter.paymentStatus));
      if (filter.intakeStatus) conditions.push(eq(documents.intakeStatus, filter.intakeStatus));
      // decisions/0066-abschluss-check-and-export.md: the date-range filter runs against
      // `documentEffectiveDate`, the very expression this list is ordered by below and the
      // Abschluss's own counts are scoped by - so "N Belege im Zeitraum" and the list that
      // link opens are the same set, never two notions of a document's date.
      conditions.push(...effectiveDateRangeConditions(filter));

      const q = filter.q?.trim();
      const searchCondition = q ? sql`${documents.searchVector} @@ websearch_to_tsquery('german', ${q})` : null;
      if (searchCondition) conditions.push(searchCondition);

      const rank = q ? sql`ts_rank(${documents.searchVector}, websearch_to_tsquery('german', ${q}))` : null;

      const offset = (filter.page - 1) * filter.pageSize;
      const limit = filter.pageSize + 1;

      const baseQuery = db
        .select({
          ...selectColumns,
          // decisions/0059-generated-document-names.md - see `counterpartyName`'s own
          // definition above this factory for why it is a correlated subquery written in
          // literal, table-qualified SQL.
          counterpartyName,
          reportPeriod,
          statementLastBooking,
        })
        .from(documents)
        .where(and(...conditions))
        .limit(limit)
        .offset(offset);

      // A `ts_rank` order alone has no deterministic tie-break: two documents with the
      // exact same rank (a very common case - e.g. neither has a search-relevant field
      // populated yet) had no guaranteed relative order between them, so offset pagination
      // could skip or duplicate a row across pages depending on the plan Postgres happened
      // to pick (P6 review finding A8). `created_at desc, id desc` behind it makes the full
      // order deterministic (createdAt alone is still not quite enough: two documents
      // created in the same transaction can share a timestamp, hence `id` as the final
      // tie-break).
      // decisions/0058-inbox-sorts-by-the-document-s-own-date.md: the inbox is ordered by the
      // date the document itself carries - `documentEffectiveDate`, the one shared expression
      // the Abschluss scopes its period by too (decisions/0066-abschluss-check-and-export.md),
      // so the two can never disagree about which month a document belongs to.
      const primaryOrder =
        filter.sort === "uploaded" ? [desc(documents.createdAt)] : [desc(documentEffectiveDate), desc(documents.createdAt)];

      const rows = rank
        ? await baseQuery.orderBy(desc(rank), ...primaryOrder, desc(documents.id))
        : await baseQuery.orderBy(...primaryOrder, desc(documents.id));

      const hasMore = rows.length > filter.pageSize;
      const page = hasMore ? rows.slice(0, filter.pageSize) : rows;

      const uploaderIds = [...new Set(page.map((r) => r.uploadedByUserId).filter((v): v is string => v !== null))];
      const uploaders =
        uploaderIds.length > 0
          ? await db.select({ id: user.id, email: user.email }).from(user).where(inArray(user.id, uploaderIds))
          : [];
      const uploaderEmailById = new Map(uploaders.map((u) => [u.id, u.email]));

      return {
        items: page.map((row) => ({
          ...row,
          uploadedByEmail: row.uploadedByUserId ? (uploaderEmailById.get(row.uploadedByUserId) ?? null) : null,
        })),
        hasMore,
      };
    },

    async deleteById(workspaceId, id) {
      const [row] = await db
        .delete(documents)
        .where(and(eq(documents.id, id), eq(documents.workspaceId, workspaceId)))
        .returning();
      return row ?? null;
    },

    async markProcessing(workspaceId, id) {
      await db
        .update(documents)
        .set({ status: "processing", errorCode: null, updatedAt: new Date() })
        .where(and(eq(documents.id, id), eq(documents.workspaceId, workspaceId)));
    },

    async markProcessingWithManualKind(workspaceId, id, manualKind) {
      await db
        .update(documents)
        .set({ status: "processing", errorCode: null, manualKind, updatedAt: new Date() })
        .where(and(eq(documents.id, id), eq(documents.workspaceId, workspaceId)));
    },

    async markDone(workspaceId, id, input) {
      const now = new Date();
      await db
        .update(documents)
        .set({
          status: "done",
          ocrText: input.ocrText,
          ocrBlocks: input.ocrBlocks,
          title: input.title,
          sender: input.sender,
          documentDate: input.documentDate,
          summary: input.summary,
          searchablePdfKey: input.searchablePdfKey,
          direction: input.direction,
          invoiceNumber: input.invoiceNumber,
          totalAmountCents: input.totalAmountCents,
          currency: input.currency,
          dueDate: input.dueDate,
          paymentIban: input.paymentIban,
          paymentReference: input.paymentReference,
          paidNote: input.paidNote,
          kind: input.kind,
          paymentStatus: input.paymentStatus,
          paidAt: null,
          errorCode: null,
          processedAt: now,
          updatedAt: now,
        })
        .where(and(eq(documents.id, id), eq(documents.workspaceId, workspaceId)));
    },

    async markFailed(workspaceId, id, errorCode) {
      await db
        .update(documents)
        .set({ status: "failed", errorCode, updatedAt: new Date() })
        .where(and(eq(documents.id, id), eq(documents.workspaceId, workspaceId)));
    },

    async markIntakeResult(workspaceId, id, input) {
      const now = new Date();
      await db
        .update(documents)
        .set({
          status: "done",
          kind: input.kind,
          platform: input.platform,
          intakeStatus: input.intakeStatus,
          intakeResult: input.intakeResult,
          errorCode: null,
          processedAt: now,
          updatedAt: now,
        })
        .where(and(eq(documents.id, id), eq(documents.workspaceId, workspaceId)));
    },

    async confirmIntake(workspaceId, id, input) {
      await db
        .update(documents)
        .set({ kind: input.kind, platform: input.platform, intakeStatus: "confirmed", intakeResult: input.intakeResult, updatedAt: new Date() })
        .where(and(eq(documents.id, id), eq(documents.workspaceId, workspaceId)));
    },

    async rejectIntake(workspaceId, id) {
      await db
        .update(documents)
        .set({ intakeStatus: "rejected", updatedAt: new Date() })
        .where(and(eq(documents.id, id), eq(documents.workspaceId, workspaceId)));
    },

    async updatePaymentStatus(workspaceId, id, input) {
      await db
        .update(documents)
        .set({ paymentStatus: input.paymentStatus, paidAt: input.paidAt, updatedAt: new Date() })
        .where(and(eq(documents.id, id), eq(documents.workspaceId, workspaceId)));
    },

    async listInvoiceCandidates(workspaceId, range) {
      return db
        .select(selectColumns)
        .from(documents)
        .where(
          and(
            eq(documents.workspaceId, workspaceId),
            or(eq(documents.direction, "incoming"), eq(documents.direction, "outgoing")),
            inArray(documents.paymentStatus, ["open", "partially_paid", "overdue"]),
            // decisions/0066: "Offene Posten" narrowed to one period, by the same effective
            // date the Abschluss counts by. `runMatching`'s candidate pool passes no range.
            ...effectiveDateRangeConditions(range ?? {}),
          ),
        )
        .orderBy(desc(documents.dueDate));
    },

    async listIntakeRejectedBefore(cutoff) {
      return db
        .select({ id: documents.id, workspaceId: documents.workspaceId })
        .from(documents)
        .where(and(eq(documents.intakeStatus, "rejected"), lt(documents.updatedAt, cutoff)));
    },

    async listConfirmedSettlementReports(workspaceId, platform) {
      return db
        .select({ id: documents.id, intakeResult: documents.intakeResult })
        .from(documents)
        .where(
          and(
            eq(documents.workspaceId, workspaceId),
            eq(documents.intakeStatus, "confirmed"),
            eq(documents.platform, platform),
            inArray(documents.kind, ["payout_report", "platform_settlement"]),
          ),
        )
        .orderBy(desc(documents.createdAt));
    },

    // --- Abschluss (decisions/0066-abschluss-check-and-export.md). Both reads below scope by
    // `documentEffectiveDate`, the SAME expression `list` orders the inbox by, so the two can
    // never disagree about which month a document belongs to. Neither query joins, which is
    // what keeps that expression's own column references correctly resolved (see its header
    // comment). ---

    async countsForPeriod(workspaceId, from, to) {
      const [row] = await db
        .select({
          // Real SQL counts, never a `list(...)` measured with `.length` (P6 review finding
          // A7, `countByWorkspace`'s own header comment) - and one round trip rather than
          // four, since all four count the same rows under different conditions.
          total: sql<number>`count(*)::int`,
          openOrOverduePayments: sql<number>`(count(*) filter (where ${effectivePaymentStatus} in ('open', 'overdue')))::int`,
          pendingIntakeConfirmation: sql<number>`(count(*) filter (where ${documents.intakeStatus} = 'pending_confirmation'))::int`,
          failedProcessing: sql<number>`(count(*) filter (where ${documents.status} = 'failed'))::int`,
        })
        .from(documents)
        .where(and(eq(documents.workspaceId, workspaceId), sql`${documentEffectiveDate} between ${from}::date and ${to}::date`));
      return {
        total: row?.total ?? 0,
        openOrOverduePayments: row?.openOrOverduePayments ?? 0,
        pendingIntakeConfirmation: row?.pendingIntakeConfirmation ?? 0,
        failedProcessing: row?.failedProcessing ?? 0,
      };
    },

    async listForPeriod(workspaceId, from, to) {
      const rows = await db
        .select({
          id: documents.id,
          // `to_char` rather than the bare date expression: this crosses the repository
          // boundary as a plain ISO string, like every other date in these contracts.
          effectiveDate: sql<string>`to_char(${documentEffectiveDate}, 'YYYY-MM-DD')`,
          originalFileName: documents.originalFileName,
          mimeType: documents.mimeType,
          searchablePdfKey: documents.searchablePdfKey,
          kind: documents.kind,
          platform: documents.platform,
          direction: documents.direction,
          documentDate: documents.documentDate,
          sender: documents.sender,
          counterpartyName,
          reportPeriod,
          statementLastBooking,
          invoiceNumber: documents.invoiceNumber,
          // The settlement-line fallback (see the two shared expressions above): without it
          // every platform report exported with an empty amount, which hid the whole of the
          // app revenue from the workbook.
          totalAmountCents: documentTotalAmountCents,
          currency: documentCurrency,
          paymentStatus: effectivePaymentStatus,
          // WHICH transactions this document is settled by, not how many: the workbook's
          // "Zugeordnete Buchungen" column names them ("B-012, B-031") and the "Zuordnungen"
          // sheet pairs them off (decisions/0066). A correlated subquery aggregating to JSON,
          // for the same reason `counterpartyName` is a subquery: a join would multiply the
          // document's own row. `[]` rather than `null` for a document with no link, so the
          // caller never branches on it.
          confirmedTransactions: sql<ClosingLinkedTransaction[]>`coalesce((
            select json_agg(json_build_object(
              'id', t.id,
              'bookingDate', to_char(t.booking_date, 'YYYY-MM-DD'),
              'amountCents', t.amount_cents,
              'currency', coalesce(t.currency, a.currency),
              'allocatedAmountCents', dt.allocated_amount_cents
            ) order by t.booking_date, t.id)
            from document_transactions dt
            join transactions t on t.id = dt.transaction_id
            join accounts a on a.id = t.account_id
            where dt.document_id = documents.id and dt.status = 'confirmed'
          ), '[]'::json)`,
        })
        .from(documents)
        .where(and(eq(documents.workspaceId, workspaceId), sql`${documentEffectiveDate} between ${from}::date and ${to}::date`))
        .orderBy(asc(documentEffectiveDate), asc(documents.id));
      return rows as ClosingDocumentRow[];
    },
  };
}
