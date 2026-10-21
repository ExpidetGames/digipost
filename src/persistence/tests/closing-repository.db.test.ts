// Real Postgres (WEBAPP_TEMPLATE_SPEC.md §10.1/§10.3). The Abschluss's period scoping
// (decisions/0066-abschluss-check-and-export.md) is entirely SQL - a shared `coalesce` over
// four sources for a document, a plain `booking_date` for a transaction - so a fake can
// prove nothing about it. This file is the authority for all of it: which date puts a
// document in a period, that the period counts are real `count(*)`s, that "Buchungen ohne
// Beleg" means exactly what "Zuordnung" lists, and that every count is workspace-scoped.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { getDb } from "@/persistence/foundation/client";
import { createDrizzleAccountRepository, createDrizzleTransactionRepository } from "@/persistence/repositories/drizzle/accounts-repository";
import { createDrizzleDocumentRepository } from "@/persistence/repositories/drizzle/documents-repository";
import { createDrizzleDocumentTransactionRepository } from "@/persistence/repositories/drizzle/payments-repository";
import { createDrizzleWorkspaceRepository } from "@/persistence/repositories/drizzle/workspaces-repository";
import { settlementLines } from "@/persistence/schema/accounts";
import { documents } from "@/persistence/schema/documents";
import type { CreateTransactionRow } from "@/persistence/repositories/contracts";

const db = getDb();
const documentRepo = createDrizzleDocumentRepository(db);
const accountRepo = createDrizzleAccountRepository(db);
const transactionRepo = createDrizzleTransactionRepository(db);
const documentTransactionRepo = createDrizzleDocumentTransactionRepository(db);

const JANUARY = { from: "2026-01-01", to: "2026-01-31" } as const;
const YEAR_2026 = { from: "2026-01-01", to: "2026-12-31" } as const;

async function createTestWorkspace(): Promise<{ id: string }> {
  return createDrizzleWorkspaceRepository(db).create({ name: `Abschluss Co ${randomUUID()}` });
}

/** Creates a document and then writes whatever the test needs directly - every column below
 * is otherwise only ever set by a pipeline branch (`markDone`/`markIntakeResult`) this test
 * has no reason to run. */
async function createDocument(
  workspaceId: string,
  patch: Partial<typeof documents.$inferInsert> & { originalFileName?: string } = {},
): Promise<string> {
  const row = await documentRepo.create({
    id: randomUUID(),
    workspaceId,
    uploadedByUserId: null,
    originalFileName: patch.originalFileName ?? "beleg.pdf",
    mimeType: "application/pdf",
    pageCount: 1,
    sizeBytes: 100,
    storageKey: `workspaces/${workspaceId}/documents/${randomUUID()}/original.pdf`,
    fileHash: randomUUID(),
  });
  const columns = { ...patch };
  delete columns.originalFileName;
  if (Object.keys(columns).length > 0) await db.update(documents).set(columns).where(eq(documents.id, row.id));
  return row.id;
}

function transactionRowFor(workspaceId: string, accountId: string, overrides: Partial<CreateTransactionRow> = {}): CreateTransactionRow {
  return {
    workspaceId,
    accountId,
    bookingDate: "2026-01-15",
    valueDate: null,
    amountCents: 5000,
    currency: "EUR",
    creditDebit: "credit",
    counterpartyName: "Kunde AG",
    counterpartyIban: null,
    counterpartyBic: null,
    remittanceText: "Rechnung 1",
    endToEndId: null,
    mandateId: null,
    creditorId: null,
    bankTxCode: null,
    bankReference: null,
    idempotencyKey: `key-${randomUUID()}`,
    importBatchId: null,
    sourceDocumentId: null,
    raw: null,
    ...overrides,
  };
}

describe("DocumentRepository period scoping (the shared effective date)", () => {
  it("puts a document in the period by its own date, a report's period end, a statement's last booking, or its upload day", async () => {
    const workspace = await createTestWorkspace();

    const ownDate = await createDocument(workspace.id, { documentDate: "2026-01-15", originalFileName: "rechnung.pdf" });
    const previousMonth = await createDocument(workspace.id, { documentDate: "2025-12-31", originalFileName: "alt.pdf" });
    // decisions/0060: an app-store report is dated by the END of the month it covers.
    const report = await createDocument(workspace.id, {
      kind: "payout_report",
      platform: "apple",
      intakeResult: { appStorePayout: { period: "2026-01" } },
      originalFileName: "apple.csv",
    });
    // decisions/0061: a bank statement is dated by its last booking - February, so out.
    const statement = await createDocument(workspace.id, {
      kind: "bank_statement",
      intakeResult: { lastBookingDate: "2026-02-03" },
      originalFileName: "auszug.xml",
    });
    // Nothing of its own: the day it arrived.
    const uploadedOnly = await createDocument(workspace.id, { createdAt: new Date("2026-01-20T08:00:00Z"), originalFileName: "scan.pdf" });

    const rows = await documentRepo.listForPeriod(workspace.id, JANUARY.from, JANUARY.to);
    expect(rows.map((row) => row.id)).toEqual([ownDate, uploadedOnly, report]);
    expect(rows.map((row) => row.effectiveDate)).toEqual(["2026-01-15", "2026-01-20", "2026-01-31"]);
    expect(rows.map((row) => row.id)).not.toContain(previousMonth);
    expect(rows.map((row) => row.id)).not.toContain(statement);

    // The whole year holds every one of them except December's.
    expect(await documentRepo.countsForPeriod(workspace.id, YEAR_2026.from, YEAR_2026.to)).toMatchObject({ total: 4 });
    expect((await documentRepo.countsForPeriod(workspace.id, JANUARY.from, JANUARY.to)).total).toBe(3);
  });

  it("agrees with the inbox: the same expression orders `list` and scopes the period", async () => {
    const workspace = await createTestWorkspace();
    await createDocument(workspace.id, { documentDate: "2026-01-02" });
    await createDocument(workspace.id, { kind: "bank_statement", intakeResult: { lastBookingDate: "2026-01-28" } });
    await createDocument(workspace.id, { createdAt: new Date("2026-01-10T08:00:00Z") });

    const inbox = await documentRepo.list(workspace.id, { page: 1, pageSize: 50, sort: "documentDate" });
    const period = await documentRepo.listForPeriod(workspace.id, JANUARY.from, JANUARY.to);
    // The inbox is newest-first, the export oldest-first; the SET and the relative order are
    // otherwise identical, which is the whole point of sharing the expression.
    expect(inbox.items.map((row) => row.id)).toEqual([...period].reverse().map((row) => row.id));
  });

  it("counts the three document gaps inside the period only, and never another workspace's rows", async () => {
    const workspace = await createTestWorkspace();
    const otherWorkspace = await createTestWorkspace();

    await createDocument(workspace.id, { documentDate: "2026-01-05", paymentStatus: "open", totalAmountCents: 1000 });
    // Stored `open` with a due date already past reads as `overdue` - still counted.
    await createDocument(workspace.id, { documentDate: "2026-01-06", paymentStatus: "open", dueDate: "2020-01-01" });
    // `paid` is not a gap.
    await createDocument(workspace.id, { documentDate: "2026-01-07", paymentStatus: "paid" });
    await createDocument(workspace.id, { documentDate: "2026-01-08", intakeStatus: "pending_confirmation" });
    await createDocument(workspace.id, { documentDate: "2026-01-09", status: "failed" });
    // Outside the period entirely.
    await createDocument(workspace.id, { documentDate: "2026-02-09", status: "failed", paymentStatus: "open" });
    // Another workspace, inside the period.
    await createDocument(otherWorkspace.id, { documentDate: "2026-01-09", status: "failed", paymentStatus: "open" });

    expect(await documentRepo.countsForPeriod(workspace.id, JANUARY.from, JANUARY.to)).toEqual({
      total: 5,
      openOrOverduePayments: 2,
      pendingIntakeConfirmation: 1,
      failedProcessing: 1,
    });
    expect(await documentRepo.countsForPeriod(otherWorkspace.id, JANUARY.from, JANUARY.to)).toEqual({
      total: 1,
      openOrOverduePayments: 1,
      pendingIntakeConfirmation: 0,
      failedProcessing: 1,
    });
  });

  it("returns zeros, not a crash, for a period with nothing in it", async () => {
    const workspace = await createTestWorkspace();
    expect(await documentRepo.countsForPeriod(workspace.id, "1999-01-01", "1999-12-31")).toEqual({
      total: 0,
      openOrOverduePayments: 0,
      pendingIntakeConfirmation: 0,
      failedProcessing: 0,
    });
    expect(await documentRepo.listForPeriod(workspace.id, "1999-01-01", "1999-12-31")).toEqual([]);
  });
});

describe("TransactionRepository period scoping", () => {
  it("counts 'Buchungen ohne Beleg' with exactly the conditions Zuordnung lists by, plus the period", async () => {
    const workspace = await createTestWorkspace();
    const bank = await accountRepo.create({
      workspaceId: workspace.id,
      type: "bank",
      name: "Bankkonto",
      iban: null,
      bic: null,
      currency: "EUR",
      holder: null,
      platform: null,
    });
    const clearing = await accountRepo.create({
      workspaceId: workspace.id,
      type: "clearing",
      name: "Stripe",
      iban: null,
      bic: null,
      currency: "EUR",
      holder: null,
      platform: "stripe",
    });

    const inserted = await transactionRepo.insertManyIdempotent([
      transactionRowFor(workspace.id, bank.id, { bookingDate: "2026-01-10", remittanceText: "zaehlt" }),
      transactionRowFor(workspace.id, bank.id, { bookingDate: "2026-01-11", remittanceText: "kein beleg noetig" }),
      transactionRowFor(workspace.id, bank.id, { bookingDate: "2026-01-12", remittanceText: "schon zugeordnet" }),
      transactionRowFor(workspace.id, clearing.id, { bookingDate: "2026-01-13", remittanceText: "verrechnungskonto" }),
      transactionRowFor(workspace.id, bank.id, { bookingDate: "2026-02-01", remittanceText: "anderer monat" }),
    ]);
    const byText = new Map(inserted.map((row) => [row.remittanceText, row]));

    await transactionRepo.markNoDocumentNeeded(workspace.id, [byText.get("kein beleg noetig")!.id]);

    const document = await createDocument(workspace.id, { documentDate: "2026-01-12" });
    await documentTransactionRepo.createConfirmed({
      workspaceId: workspace.id,
      documentId: document,
      transactionId: byText.get("schon zugeordnet")!.id,
      status: "confirmed",
      kind: "exact",
      confidence: 100,
      reasons: [],
      explanation: null,
      matchedBy: "auto",
      allocatedAmountCents: 5000,
      arbiterCacheKey: null,
      decidedAt: new Date(),
      decidedByUserId: null,
    });

    // Four transactions booked in January (the clearing one included in `total`), exactly
    // one of which is still a gap.
    expect(await transactionRepo.countsForPeriod(workspace.id, JANUARY.from, JANUARY.to)).toEqual({ total: 4, unmatched: 1 });

    // And over a period that covers everything, the period count and the unscoped count the
    // "Start" page uses must be the same number.
    expect((await transactionRepo.countsForPeriod(workspace.id, "2000-01-01", "2099-12-31")).unmatched).toBe(
      await transactionRepo.countUnmatched(workspace.id),
    );
  });

  it("lists a period's transactions with their account, currency fallback and confirmed documents", async () => {
    const workspace = await createTestWorkspace();
    const bank = await accountRepo.create({
      workspaceId: workspace.id,
      type: "bank",
      name: "Geschäftskonto",
      iban: null,
      bic: null,
      currency: "CHF",
      holder: null,
      platform: null,
    });
    const inserted = await transactionRepo.insertManyIdempotent([
      transactionRowFor(workspace.id, bank.id, { bookingDate: "2026-01-20", currency: null, remittanceText: "ohne waehrung" }),
      transactionRowFor(workspace.id, bank.id, { bookingDate: "2026-01-05", amountCents: -2500, creditDebit: "debit", remittanceText: "mit beleg" }),
    ]);
    const withDocument = inserted.find((row) => row.remittanceText === "mit beleg")!;
    const document = await createDocument(workspace.id, { documentDate: "2026-01-05" });
    await documentTransactionRepo.createConfirmed({
      workspaceId: workspace.id,
      documentId: document,
      transactionId: withDocument.id,
      status: "confirmed",
      kind: "exact",
      confidence: 100,
      reasons: [],
      explanation: null,
      matchedBy: "auto",
      allocatedAmountCents: 2500,
      arbiterCacheKey: null,
      decidedAt: new Date(),
      decidedByUserId: null,
    });

    const rows = await transactionRepo.listForPeriod(workspace.id, JANUARY.from, JANUARY.to);
    expect(rows.map((row) => row.bookingDate)).toEqual(["2026-01-05", "2026-01-20"]);
    expect(rows[0]).toMatchObject({ accountName: "Geschäftskonto", amountCents: -2500, currency: "EUR" });
    // WHICH document settles it, not merely how many (decisions/0066): the export turns this
    // into "D-007" and into a row of the "Zuordnungen" sheet.
    expect(rows[0]!.confirmedDocuments).toEqual([
      { id: document, effectiveDate: "2026-01-05", amountCents: null, currency: null, allocatedAmountCents: 2500 },
    ]);
    // No own currency: the account's own is used instead of an empty cell.
    expect(rows[1]).toMatchObject({ currency: "CHF", confirmedDocuments: [] });
  });
});

describe("DocumentTransactionRepository.countSuggestedForPeriod", () => {
  it("counts suggestions by the booking date of the transaction they propose, workspace-scoped", async () => {
    const workspace = await createTestWorkspace();
    const otherWorkspace = await createTestWorkspace();
    const bank = await accountRepo.create({
      workspaceId: workspace.id,
      type: "bank",
      name: "Bankkonto",
      iban: null,
      bic: null,
      currency: "EUR",
      holder: null,
      platform: null,
    });
    const inserted = await transactionRepo.insertManyIdempotent([
      transactionRowFor(workspace.id, bank.id, { bookingDate: "2026-01-09", remittanceText: "januar" }),
      transactionRowFor(workspace.id, bank.id, { bookingDate: "2026-03-09", remittanceText: "maerz" }),
    ]);
    const document = await createDocument(workspace.id, { documentDate: "2026-01-09" });

    for (const transaction of inserted) {
      await documentTransactionRepo.upsertSuggestion({
        workspaceId: workspace.id,
        documentId: document,
        transactionId: transaction.id,
        status: "suggested",
        kind: "exact",
        confidence: 70,
        reasons: [],
        explanation: null,
        matchedBy: "auto",
        allocatedAmountCents: 5000,
        arbiterCacheKey: null,
        decidedAt: null,
        decidedByUserId: null,
      });
    }

    expect(await documentTransactionRepo.countSuggestedForPeriod(workspace.id, JANUARY.from, JANUARY.to)).toBe(1);
    expect(await documentTransactionRepo.countSuggestedForPeriod(workspace.id, YEAR_2026.from, YEAR_2026.to)).toBe(2);
    expect(await documentTransactionRepo.countSuggestedForPeriod(otherWorkspace.id, YEAR_2026.from, YEAR_2026.to)).toBe(0);

    // A decided suggestion is no longer open.
    const open = await documentTransactionRepo.listSuggestedForWorkspace(workspace.id);
    await documentTransactionRepo.decide(workspace.id, open[0]!.id, { status: "rejected", matchedBy: "user", decidedByUserId: null });
    expect(await documentTransactionRepo.countSuggestedForPeriod(workspace.id, YEAR_2026.from, YEAR_2026.to)).toBe(1);
  });
});

// Both of these were found by exporting a full real-world year and reading the workbook back:
// every platform report exported with an EMPTY amount, and the Buchungen sheet held one
// clearing row per in-app purchase, far more than the real bank movements.
describe("what the export's two sheets actually contain", () => {
  it("gives a platform report the sum of its settlement lines, since it has no amount of its own", async () => {
    const workspace = await createTestWorkspace();
    const accountRepo = createDrizzleAccountRepository(db);
    const clearing = await accountRepo.create({
      workspaceId: workspace.id,
      type: "clearing",
      name: "Google",
      iban: null,
      bic: null,
      currency: "EUR",
      holder: null,
      platform: "google",
    });
    const reportId = await createDocument(workspace.id, {
      kind: "payout_report",
      platform: "google",
      originalFileName: "financial_report.csv",
      intakeResult: { type: "tabular_confirmed", appStorePayout: { period: "2026-03" } },
    });
    // A report's own amount column stays null on purpose; the money lives in its lines.
    await db.insert(settlementLines).values(
      [1234, 2766].map((netCents, index) => ({
        workspaceId: workspace.id,
        clearingAccountId: clearing.id,
        sourceDocumentId: reportId,
        type: "revenue" as const,
        externalLineId: `line-${index}-${randomUUID()}`,
        netCents,
        currency: "EUR",
        bookingDate: "2026-03-15",
      })),
    );

    const [row] = await documentRepo.listForPeriod(workspace.id, "2026-03-01", "2026-03-31");
    expect(row?.totalAmountCents).toBe(4000);
    expect(row?.currency).toBe("EUR");
  });

  it("lists only bank movements, never a clearing account's own rows", async () => {
    const workspace = await createTestWorkspace();
    const accountRepo = createDrizzleAccountRepository(db);
    const transactionRepo = createDrizzleTransactionRepository(db);
    const bank = await accountRepo.create({
      workspaceId: workspace.id,
      type: "bank",
      name: "Bankkonto",
      iban: null,
      bic: null,
      currency: "EUR",
      holder: null,
      platform: null,
    });
    const clearing = await accountRepo.create({
      workspaceId: workspace.id,
      type: "clearing",
      name: "Google",
      iban: null,
      bic: null,
      currency: "EUR",
      holder: null,
      platform: "google",
    });
    await transactionRepo.insertManyIdempotent([
      transactionRowFor(workspace.id, bank.id, { bookingDate: "2026-04-10", remittanceText: "echte Bankbuchung" }),
      transactionRowFor(workspace.id, clearing.id, { bookingDate: "2026-04-10", remittanceText: "In-App-Kauf" }),
    ]);

    const rows = await transactionRepo.listForPeriod(workspace.id, "2026-04-01", "2026-04-30");
    expect(rows.map((row) => row.remittanceText)).toEqual(["echte Bankbuchung"]);
  });
});

// decisions/0066: the workbook shows both sides of a pairing but, until now, never which
// belonged to which. Both repositories therefore return the linked counterparts themselves,
// and a counterpart may legitimately lie OUTSIDE the exported period - which is exactly the
// case a fake cannot prove, because the document's side of it is the shared `coalesce`.
describe("the export's confirmed links", () => {
  async function confirm(workspaceId: string, documentId: string, transactionId: string, allocatedAmountCents: number): Promise<void> {
    await documentTransactionRepo.createConfirmed({
      workspaceId,
      documentId,
      transactionId,
      status: "confirmed",
      kind: "exact",
      confidence: 100,
      reasons: [],
      explanation: null,
      matchedBy: "auto",
      allocatedAmountCents,
      arbiterCacheKey: null,
      decidedAt: new Date(),
      decidedByUserId: null,
    });
  }

  it("names the counterpart on both sides, including one outside the period, and ignores a mere suggestion", async () => {
    const workspace = await createTestWorkspace();
    const bank = await accountRepo.create({
      workspaceId: workspace.id,
      type: "bank",
      name: "Geschäftskonto",
      iban: null,
      bic: null,
      currency: "EUR",
      holder: null,
      platform: null,
    });

    const januaryDocument = await createDocument(workspace.id, { documentDate: "2026-01-15", totalAmountCents: 119000, currency: "EUR" });
    const decemberDocument = await createDocument(workspace.id, { documentDate: "2025-12-14", totalAmountCents: 2300, currency: "EUR" });
    const [januaryTransaction, decemberTransaction, suggestedTransaction] = await transactionRepo.insertManyIdempotent([
      transactionRowFor(workspace.id, bank.id, { bookingDate: "2026-01-29", amountCents: -2300, creditDebit: "debit", remittanceText: "januar" }),
      transactionRowFor(workspace.id, bank.id, { bookingDate: "2025-12-20", amountCents: -119000, creditDebit: "debit", remittanceText: "dezember" }),
      transactionRowFor(workspace.id, bank.id, { bookingDate: "2026-01-30", amountCents: -500, creditDebit: "debit", remittanceText: "nur Vorschlag" }),
    ]);

    // A January booking settled by a December invoice, and a January invoice settled by a
    // December booking: one of each direction across the period's edge.
    await confirm(workspace.id, decemberDocument, januaryTransaction!.id, 2300);
    await confirm(workspace.id, januaryDocument, decemberTransaction!.id, 119000);
    await documentTransactionRepo.upsertSuggestion({
      workspaceId: workspace.id,
      documentId: januaryDocument,
      transactionId: suggestedTransaction!.id,
      status: "suggested",
      kind: "exact",
      confidence: 70,
      reasons: [],
      explanation: null,
      matchedBy: "auto",
      allocatedAmountCents: 500,
      arbiterCacheKey: null,
      decidedAt: null,
      decidedByUserId: null,
    });

    const documentRows = await documentRepo.listForPeriod(workspace.id, JANUARY.from, JANUARY.to);
    expect(documentRows.map((row) => row.id)).toEqual([januaryDocument]);
    // Only the confirmed one, and it carries the booking's own date, amount and currency -
    // everything the export needs to NAME a counterpart it cannot number.
    expect(documentRows[0]!.confirmedTransactions).toEqual([
      { id: decemberTransaction!.id, bookingDate: "2025-12-20", amountCents: -119000, currency: "EUR", allocatedAmountCents: 119000 },
    ]);

    const transactionRows = await transactionRepo.listForPeriod(workspace.id, JANUARY.from, JANUARY.to);
    expect(transactionRows.map((row) => row.id)).toEqual([januaryTransaction!.id, suggestedTransaction!.id]);
    expect(transactionRows[0]!.confirmedDocuments).toEqual([
      { id: decemberDocument, effectiveDate: "2025-12-14", amountCents: 2300, currency: "EUR", allocatedAmountCents: 2300 },
    ]);
    expect(transactionRows[1]!.confirmedDocuments).toEqual([]);
  });

  it("reads a linked document's date and amount with the SAME expressions the Dokumente sheet uses", async () => {
    const workspace = await createTestWorkspace();
    const bank = await accountRepo.create({
      workspaceId: workspace.id,
      type: "bank",
      name: "Geschäftskonto",
      iban: null,
      bic: null,
      currency: "EUR",
      holder: null,
      platform: null,
    });
    const clearing = await accountRepo.create({
      workspaceId: workspace.id,
      type: "clearing",
      name: "Apple",
      iban: null,
      bic: null,
      currency: "EUR",
      holder: null,
      platform: "apple",
    });
    // A platform report: no document date (its period's end dates it, decisions/0060) and no
    // amount of its own (its settlement lines carry it, decisions/0066).
    const report = await createDocument(workspace.id, {
      kind: "payout_report",
      platform: "apple",
      originalFileName: "apple.csv",
      intakeResult: { appStorePayout: { period: "2026-02" } },
    });
    await db.insert(settlementLines).values(
      [1500, 2500].map((netCents, index) => ({
        workspaceId: workspace.id,
        clearingAccountId: clearing.id,
        sourceDocumentId: report,
        type: "revenue" as const,
        externalLineId: `line-${index}-${randomUUID()}`,
        netCents,
        currency: "EUR",
        bookingDate: "2026-02-15",
      })),
    );
    const [payout] = await transactionRepo.insertManyIdempotent([
      transactionRowFor(workspace.id, bank.id, { bookingDate: "2026-03-05", amountCents: 4000, remittanceText: "Apple Auszahlung" }),
    ]);
    await confirm(workspace.id, report, payout!.id, 4000);

    const [transaction] = await transactionRepo.listForPeriod(workspace.id, "2026-03-01", "2026-03-31");
    expect(transaction!.confirmedDocuments).toEqual([
      // The report's period END, not its upload day, and the sum of its lines, not an empty
      // amount: the same two expressions `listForPeriod` selects for the Dokumente sheet.
      { id: report, effectiveDate: "2026-02-28", amountCents: 4000, currency: "EUR", allocatedAmountCents: 4000 },
    ]);
  });
});

// decisions/0066-abschluss-check-and-export.md. The defect this guards: every check's COUNT
// was period-scoped while the LIST its link opened was not, so "24 Buchungen ohne Beleg" for
// 2025 opened a page showing 28 rows from every year there has ever been. A number nobody can
// reproduce on the page it points at teaches the reader to distrust the whole page, so the
// invariant below is the feature, not a detail of it: for one period, every count equals the
// length of the list that count's link opens.
describe("a check's count equals the length of the list its link opens", () => {
  async function seedPeriodFixture() {
    const workspace = await createTestWorkspace();
    const bank = await accountRepo.create({
      workspaceId: workspace.id,
      type: "bank",
      name: "Bankkonto",
      iban: null,
      bic: null,
      currency: "EUR",
      holder: null,
      platform: null,
    });
    const clearing = await accountRepo.create({
      workspaceId: workspace.id,
      type: "clearing",
      name: "Apple",
      iban: null,
      bic: null,
      currency: "EUR",
      holder: null,
      platform: "apple",
    });

    // "Buchungen ohne Beleg": two inside January, plus three rows that must not be counted
    // OR listed (already settled, "kein Beleg nötig", a clearing account's own row), plus one
    // in another month that must stay out of both.
    const inserted = await transactionRepo.insertManyIdempotent([
      transactionRowFor(workspace.id, bank.id, { bookingDate: "2026-01-04", remittanceText: "offen a" }),
      transactionRowFor(workspace.id, bank.id, { bookingDate: "2026-01-18", remittanceText: "offen b" }),
      transactionRowFor(workspace.id, bank.id, { bookingDate: "2026-01-19", remittanceText: "schon zugeordnet" }),
      transactionRowFor(workspace.id, bank.id, { bookingDate: "2026-01-20", remittanceText: "kein beleg noetig" }),
      transactionRowFor(workspace.id, clearing.id, { bookingDate: "2026-01-21", remittanceText: "in-app-kauf" }),
      transactionRowFor(workspace.id, bank.id, { bookingDate: "2026-02-04", remittanceText: "februar" }),
    ]);
    const byText = new Map(inserted.map((row) => [row.remittanceText, row]));
    await transactionRepo.markNoDocumentNeeded(workspace.id, [byText.get("kein beleg noetig")!.id]);

    // "Belege ohne Zahlung": one plainly open, one stored `open` but already past its due
    // date (which reads as `overdue`), one paid (neither counted nor listed), one open but in
    // February (out of the period on both sides).
    await createDocument(workspace.id, { documentDate: "2026-01-07", direction: "incoming", paymentStatus: "open", totalAmountCents: 11_900 });
    await createDocument(workspace.id, {
      documentDate: "2026-01-08",
      direction: "outgoing",
      paymentStatus: "open",
      dueDate: "2020-01-01",
      totalAmountCents: 4200,
    });
    await createDocument(workspace.id, { documentDate: "2026-01-09", direction: "incoming", paymentStatus: "paid", totalAmountCents: 500 });
    await createDocument(workspace.id, { documentDate: "2026-02-10", direction: "incoming", paymentStatus: "open", totalAmountCents: 999 });

    // "Wartet auf Bestätigung" and "Verarbeitung fehlgeschlagen", in and out of the period.
    await createDocument(workspace.id, { documentDate: "2026-01-11", intakeStatus: "pending_confirmation" });
    await createDocument(workspace.id, { documentDate: "2026-02-11", intakeStatus: "pending_confirmation" });
    await createDocument(workspace.id, { documentDate: "2026-01-12", status: "failed" });
    await createDocument(workspace.id, { documentDate: "2026-01-13", status: "failed" });
    await createDocument(workspace.id, { documentDate: "2026-02-13", status: "failed" });

    // A document with no date of its own at all: the shared effective date puts it in the
    // period by its upload day, so it must count AND list for the same period as the rest.
    await createDocument(workspace.id, { createdAt: new Date("2026-01-25T09:00:00Z"), status: "failed" });

    const settled = await createDocument(workspace.id, { documentDate: "2026-01-19" });
    await documentTransactionRepo.createConfirmed({
      workspaceId: workspace.id,
      documentId: settled,
      transactionId: byText.get("schon zugeordnet")!.id,
      status: "confirmed",
      kind: "exact",
      confidence: 100,
      reasons: [],
      explanation: null,
      matchedBy: "auto",
      allocatedAmountCents: 5000,
      arbiterCacheKey: null,
      decidedAt: new Date(),
      decidedByUserId: null,
    });

    return workspace;
  }

  it("holds for 'Buchungen ohne Beleg' (count: booking date, list: the same conditions plus the same booking date)", async () => {
    const workspace = await seedPeriodFixture();
    for (const period of [JANUARY, YEAR_2026]) {
      const { unmatched } = await transactionRepo.countsForPeriod(workspace.id, period.from, period.to);
      const list = await transactionRepo.listUnmatched(workspace.id, { page: 1, pageSize: 500, from: period.from, to: period.to });
      expect(list.items.length).toBe(unmatched);
      expect(list.hasMore).toBe(false);
    }
    // January is a strict subset of the year, so the range really is doing the narrowing and
    // the two numbers are not accidentally equal because everything happens to fit in one
    // month.
    expect((await transactionRepo.countsForPeriod(workspace.id, JANUARY.from, JANUARY.to)).unmatched).toBe(2);
    expect((await transactionRepo.countsForPeriod(workspace.id, YEAR_2026.from, YEAR_2026.to)).unmatched).toBe(3);
  });

  it("holds for 'Belege ohne Zahlung' (count and list both on the shared effective date)", async () => {
    const workspace = await seedPeriodFixture();
    for (const period of [JANUARY, YEAR_2026]) {
      const { openOrOverduePayments } = await documentRepo.countsForPeriod(workspace.id, period.from, period.to);
      const list = await documentRepo.listInvoiceCandidates(workspace.id, { from: period.from, to: period.to });
      expect(list.length).toBe(openOrOverduePayments);
    }
    expect((await documentRepo.countsForPeriod(workspace.id, JANUARY.from, JANUARY.to)).openOrOverduePayments).toBe(2);
    expect((await documentRepo.countsForPeriod(workspace.id, YEAR_2026.from, YEAR_2026.to)).openOrOverduePayments).toBe(3);
  });

  it("holds for 'Wartet auf Bestätigung' and 'Verarbeitung fehlgeschlagen' (the inbox, filtered)", async () => {
    const workspace = await seedPeriodFixture();
    for (const period of [JANUARY, YEAR_2026]) {
      const counts = await documentRepo.countsForPeriod(workspace.id, period.from, period.to);

      const pending = await documentRepo.list(workspace.id, {
        page: 1,
        pageSize: 100,
        sort: "documentDate",
        intakeStatus: "pending_confirmation",
        from: period.from,
        to: period.to,
      });
      expect(pending.items.length).toBe(counts.pendingIntakeConfirmation);

      const failed = await documentRepo.list(workspace.id, {
        page: 1,
        pageSize: 100,
        sort: "documentDate",
        status: "failed",
        from: period.from,
        to: period.to,
      });
      expect(failed.items.length).toBe(counts.failedProcessing);
    }
    const january = await documentRepo.countsForPeriod(workspace.id, JANUARY.from, JANUARY.to);
    // The dateless document (uploaded 2026-01-25) is among January's failures, which is the
    // point of filtering the list by the same `coalesce` the count uses rather than by
    // `document_date`.
    expect([january.pendingIntakeConfirmation, january.failedProcessing]).toEqual([1, 3]);
    const year = await documentRepo.countsForPeriod(workspace.id, YEAR_2026.from, YEAR_2026.to);
    expect([year.pendingIntakeConfirmation, year.failedProcessing]).toEqual([2, 4]);
  });

  it("leaves an unranged caller alone: no bounds means the whole list, exactly as before", async () => {
    const workspace = await seedPeriodFixture();
    const everything = await transactionRepo.listUnmatched(workspace.id, { page: 1, pageSize: 500 });
    expect(everything.items.length).toBe(await transactionRepo.countUnmatched(workspace.id));
    // `runMatching`'s own candidate pool reads `listInvoiceCandidates` with no range at all -
    // an invoice from any month may be the one a transaction settles.
    expect((await documentRepo.listInvoiceCandidates(workspace.id)).length).toBe(3);
  });

  it("filters on one open bound as readily as on two", async () => {
    const workspace = await seedPeriodFixture();
    const fromFebruary = await transactionRepo.listUnmatched(workspace.id, { page: 1, pageSize: 500, from: "2026-02-01" });
    expect(fromFebruary.items.map((row) => row.remittanceText)).toEqual(["februar"]);
    const untilJanuary = await documentRepo.listInvoiceCandidates(workspace.id, { to: "2026-01-31" });
    expect(untilJanuary.length).toBe(2);
  });
});

// The one place a count and its list still cannot agree, pinned here rather than left to be
// rediscovered: "Offene Zuordnungsvorschläge" counts `document_transactions` ROWS, while the
// page it links to ("Zuordnung") lists TRANSACTIONS. One transaction can carry several open
// suggestions, and a transaction with none is still listed, so the two are different units of
// the same period: "Zuordnung" lists TRANSACTIONS, and one transaction can carry several open
// suggestions. Counting suggestion rows would print a number nobody can reproduce on the page
// the item links to, which is the exact failure this check exists to prevent, so the count is
// DISTINCT on the transaction (decisions/0066-abschluss-check-and-export.md).
describe("open suggestions are counted per transaction, the unit the list uses", () => {
  it("counts one transaction once, however many open suggestions it carries", async () => {
    const workspace = await createTestWorkspace();
    const bank = await accountRepo.create({
      workspaceId: workspace.id,
      type: "bank",
      name: "Bankkonto",
      iban: null,
      bic: null,
      currency: "EUR",
      holder: null,
      platform: null,
    });
    const [transaction] = await transactionRepo.insertManyIdempotent([
      transactionRowFor(workspace.id, bank.id, { bookingDate: "2026-01-14", remittanceText: "zwei vorschlaege" }),
    ]);
    for (const documentDate of ["2026-01-02", "2026-01-03"]) {
      const documentId = await createDocument(workspace.id, { documentDate });
      await documentTransactionRepo.upsertSuggestion({
        workspaceId: workspace.id,
        documentId,
        transactionId: transaction!.id,
        status: "suggested",
        kind: "exact",
        confidence: 70,
        reasons: [],
        explanation: null,
        matchedBy: "auto",
        allocatedAmountCents: 5000,
        arbiterCacheKey: null,
        decidedAt: null,
        decidedByUserId: null,
      });
    }

    // Two open suggestions, one transaction: the count and the list it links to must agree.
    const list = await transactionRepo.listUnmatched(workspace.id, { page: 1, pageSize: 500, from: JANUARY.from, to: JANUARY.to });
    expect(list.items.length).toBe(1);
    expect(await documentTransactionRepo.countSuggestedForPeriod(workspace.id, JANUARY.from, JANUARY.to)).toBe(1);
  });
});
