// Real Postgres (WEBAPP_TEMPLATE_SPEC.md §10.1/§10.3). Proves the properties a fake cannot
// guarantee are actually enforced by the real schema: the per-account idempotency-key unique
// constraint (`ON CONFLICT ... DO NOTHING`, the idempotent-reimport guarantee), the
// per-source-document upsert on `import_batches`, workspace scoping, and that deleting the
// source document sets both `transactions.source_document_id` and
// `import_batches.source_document_id` to `null` rather than deleting either row
// (decisions/0024-accounts-and-transactions.md).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { getDb } from "@/persistence/foundation/client";
import { createDrizzleAccountRepository, createDrizzleImportBatchRepository, createDrizzleTransactionRepository } from "@/persistence/repositories/drizzle/accounts-repository";
import { createDrizzleDocumentRepository } from "@/persistence/repositories/drizzle/documents-repository";
import { createDrizzleWorkspaceRepository } from "@/persistence/repositories/drizzle/workspaces-repository";
import type { CreateTransactionRow } from "@/persistence/repositories/contracts";

const db = getDb();

async function createTestWorkspace(name: string): Promise<{ id: string }> {
  return createDrizzleWorkspaceRepository(db).create({ name });
}

async function createTestDocument(workspaceId: string): Promise<{ id: string }> {
  const documentRepo = createDrizzleDocumentRepository(db);
  const row = await documentRepo.create({
    id: randomUUID(),
    workspaceId,
    uploadedByUserId: null,
    originalFileName: "kontoauszug.xml",
    mimeType: "application/xml",
    pageCount: 1,
    sizeBytes: 10,
    storageKey: `workspaces/${workspaceId}/documents/${randomUUID()}/original.xml`,
    fileHash: randomUUID(),
  });
  return { id: row.id };
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

describe("accounts repositories (real Postgres)", () => {
  it("findByIban is scoped per workspace - two workspaces may hold an account for the same IBAN", async () => {
    const workspaceA = await createTestWorkspace("Konten A");
    const workspaceB = await createTestWorkspace("Konten B");
    const accountRepo = createDrizzleAccountRepository(db);
    const iban = "DE89370400440532013000";

    const accountA = await accountRepo.create({ workspaceId: workspaceA.id, type: "bank", name: "Konto A", iban, bic: null, currency: "EUR", holder: null, platform: null });
    const accountB = await accountRepo.create({ workspaceId: workspaceB.id, type: "bank", name: "Konto B", iban, bic: null, currency: "EUR", holder: null, platform: null });

    expect(await accountRepo.findByIban(workspaceA.id, iban)).toMatchObject({ id: accountA.id });
    expect(await accountRepo.findByIban(workspaceB.id, iban)).toMatchObject({ id: accountB.id });
    expect(await accountRepo.findByIban(workspaceA.id, "DE00000000000000000000")).toBeNull();
  });

  it("rejects a second account with the same IBAN in the same workspace (partial unique index)", async () => {
    const workspace = await createTestWorkspace("Konten Duplicate");
    const accountRepo = createDrizzleAccountRepository(db);
    const iban = "DE12500105170648489890";
    await accountRepo.create({ workspaceId: workspace.id, type: "bank", name: "Erstes Konto", iban, bic: null, currency: "EUR", holder: null, platform: null });

    await expect(
      accountRepo.create({ workspaceId: workspace.id, type: "bank", name: "Zweites Konto", iban, bic: null, currency: "EUR", holder: null, platform: null }),
    ).rejects.toThrow();
  });

  it("allows multiple accounts with iban: null in the same workspace (NULLS DISTINCT)", async () => {
    const workspace = await createTestWorkspace("Konten Null Iban");
    const accountRepo = createDrizzleAccountRepository(db);

    const first = await accountRepo.create({ workspaceId: workspace.id, type: "clearing", name: "Stripe", iban: null, bic: null, currency: "EUR", holder: null, platform: "stripe" });
    const second = await accountRepo.create({ workspaceId: workspace.id, type: "clearing", name: "Apple", iban: null, bic: null, currency: "EUR", holder: null, platform: "apple" });

    expect(first.id).not.toBe(second.id);
    expect(await accountRepo.listForWorkspace(workspace.id)).toHaveLength(2);
  });

  it(
    "rejects a second clearing account for the same platform in the same workspace " +
      "(F5 review finding F4 leftover (c), decisions/0027-hardening-and-deletion.md)",
    async () => {
      const workspace = await createTestWorkspace("Konten Clearing Duplicate");
      const accountRepo = createDrizzleAccountRepository(db);
      await accountRepo.create({ workspaceId: workspace.id, type: "clearing", name: "Stripe", iban: null, bic: null, currency: "EUR", holder: null, platform: "stripe" });

      await expect(
        accountRepo.create({ workspaceId: workspace.id, type: "clearing", name: "Stripe (duplicate)", iban: null, bic: null, currency: "EUR", holder: null, platform: "stripe" }),
      ).rejects.toThrow();
    },
  );

  it("allows a bank account and a clearing account to coexist even if a bank account's platform column happened to be set", async () => {
    const workspace = await createTestWorkspace("Konten Mixed Type");
    const accountRepo = createDrizzleAccountRepository(db);
    // A `type: "bank"` account is never given a `platform` in practice, but the partial
    // index only constrains `type = 'clearing'` rows, so this must not collide with a real
    // clearing account for the same (unusual, hypothetical) platform value.
    await accountRepo.create({ workspaceId: workspace.id, type: "bank", name: "Ungewöhnlich", iban: null, bic: null, currency: "EUR", holder: null, platform: "stripe" });
    const clearing = await accountRepo.create({ workspaceId: workspace.id, type: "clearing", name: "Stripe", iban: null, bic: null, currency: "EUR", holder: null, platform: "stripe" });

    expect(clearing.type).toBe("clearing");
    expect(await accountRepo.listForWorkspace(workspace.id)).toHaveLength(2);
  });

  it("insertManyIdempotent skips a row whose (accountId, idempotencyKey) already exists", async () => {
    const workspace = await createTestWorkspace("Idempotent Import Co");
    const accountRepo = createDrizzleAccountRepository(db);
    const transactionRepo = createDrizzleTransactionRepository(db);
    const account = await accountRepo.create({ workspaceId: workspace.id, type: "bank", name: "Konto", iban: null, bic: null, currency: "EUR", holder: null, platform: null });

    const row = transactionRowFor(workspace.id, account.id);
    const firstInsert = await transactionRepo.insertManyIdempotent([row]);
    expect(firstInsert).toHaveLength(1);

    // Re-importing the exact same row (same idempotencyKey, same account): zero new rows.
    const secondInsert = await transactionRepo.insertManyIdempotent([row]);
    expect(secondInsert).toHaveLength(0);

    const { hasMore, items } = await transactionRepo.list(workspace.id, account.id, { page: 1, pageSize: 10 });
    expect(hasMore).toBe(false);
    expect(items).toHaveLength(1);
  });

  it("the same idempotencyKey is allowed again under a DIFFERENT account", async () => {
    const workspace = await createTestWorkspace("Same Key Different Account");
    const accountRepo = createDrizzleAccountRepository(db);
    const transactionRepo = createDrizzleTransactionRepository(db);
    const accountA = await accountRepo.create({ workspaceId: workspace.id, type: "bank", name: "A", iban: null, bic: null, currency: "EUR", holder: null, platform: null });
    const accountB = await accountRepo.create({ workspaceId: workspace.id, type: "bank", name: "B", iban: null, bic: null, currency: "EUR", holder: null, platform: null });

    const sharedKey = `key-${randomUUID()}`;
    const insertedA = await transactionRepo.insertManyIdempotent([transactionRowFor(workspace.id, accountA.id, { idempotencyKey: sharedKey })]);
    const insertedB = await transactionRepo.insertManyIdempotent([transactionRowFor(workspace.id, accountB.id, { idempotencyKey: sharedKey })]);

    expect(insertedA).toHaveLength(1);
    expect(insertedB).toHaveLength(1);
  });

  it(
    "sumAmountCents (F5 review finding F2 #3, decisions/0027-hardening-and-deletion.md) excludes a " +
      "differently-currencied transaction from the sum and flags hasMixedCurrency",
    async () => {
      const workspace = await createTestWorkspace("Mixed Currency Co");
      const accountRepo = createDrizzleAccountRepository(db);
      const transactionRepo = createDrizzleTransactionRepository(db);
      const account = await accountRepo.create({ workspaceId: workspace.id, type: "bank", name: "Konto", iban: null, bic: null, currency: "EUR", holder: null, platform: null });
      await transactionRepo.insertManyIdempotent([
        transactionRowFor(workspace.id, account.id, { amountCents: 1000, currency: "EUR" }),
        transactionRowFor(workspace.id, account.id, { amountCents: 500, currency: null }),
        transactionRowFor(workspace.id, account.id, { amountCents: 99999, currency: "USD" }),
      ]);

      const result = await transactionRepo.sumAmountCents(workspace.id, account.id, "EUR");

      expect(result).toEqual({ amountCents: 1500, hasMixedCurrency: true });
    },
  );

  it("sumAmountCents reports hasMixedCurrency: false when every row matches or has no currency", async () => {
    const workspace = await createTestWorkspace("Same Currency Co");
    const accountRepo = createDrizzleAccountRepository(db);
    const transactionRepo = createDrizzleTransactionRepository(db);
    const account = await accountRepo.create({ workspaceId: workspace.id, type: "bank", name: "Konto", iban: null, bic: null, currency: "EUR", holder: null, platform: null });
    await transactionRepo.insertManyIdempotent([
      transactionRowFor(workspace.id, account.id, { amountCents: 1000, currency: "EUR" }),
      transactionRowFor(workspace.id, account.id, { amountCents: 500, currency: null }),
    ]);

    const result = await transactionRepo.sumAmountCents(workspace.id, account.id, "EUR");

    expect(result).toEqual({ amountCents: 1500, hasMixedCurrency: false });
  });

  it("upsertForDocument replaces the same batch row on a second call for the same document", async () => {
    const workspace = await createTestWorkspace("Batch Upsert Co");
    const accountRepo = createDrizzleAccountRepository(db);
    const importBatchRepo = createDrizzleImportBatchRepository(db);
    const account = await accountRepo.create({ workspaceId: workspace.id, type: "bank", name: "Konto", iban: null, bic: null, currency: "EUR", holder: null, platform: null });
    const doc = await createTestDocument(workspace.id);

    const first = await importBatchRepo.upsertForDocument({
      workspaceId: workspace.id,
      accountId: account.id,
      sourceDocumentId: doc.id,
      statementFrom: "2026-01-01",
      statementTo: "2026-01-31",
      openingBalanceCents: 0,
      closingBalanceCents: 5000,
      rowsTotal: 1,
      rowsImported: 1,
      rowsDuplicate: 0,
      balanceMismatch: false,
    });

    const second = await importBatchRepo.upsertForDocument({
      workspaceId: workspace.id,
      accountId: account.id,
      sourceDocumentId: doc.id,
      statementFrom: "2026-01-01",
      statementTo: "2026-01-31",
      openingBalanceCents: 0,
      closingBalanceCents: 5000,
      rowsTotal: 1,
      rowsImported: 0,
      rowsDuplicate: 1,
      balanceMismatch: false,
    });

    expect(second.id).toBe(first.id);
    expect(second.rowsImported).toBe(0);
    expect(second.rowsDuplicate).toBe(1);
    expect(await importBatchRepo.listForAccount(workspace.id, account.id)).toHaveLength(1);
  });

  it("deleting the source document keeps the transaction and the batch, setting source_document_id to null", async () => {
    const workspace = await createTestWorkspace("Delete Source Doc Co");
    const accountRepo = createDrizzleAccountRepository(db);
    const transactionRepo = createDrizzleTransactionRepository(db);
    const importBatchRepo = createDrizzleImportBatchRepository(db);
    const documentRepo = createDrizzleDocumentRepository(db);
    const account = await accountRepo.create({ workspaceId: workspace.id, type: "bank", name: "Konto", iban: null, bic: null, currency: "EUR", holder: null, platform: null });
    const doc = await createTestDocument(workspace.id);

    const [inserted] = await transactionRepo.insertManyIdempotent([transactionRowFor(workspace.id, account.id, { sourceDocumentId: doc.id })]);
    const batch = await importBatchRepo.upsertForDocument({
      workspaceId: workspace.id,
      accountId: account.id,
      sourceDocumentId: doc.id,
      statementFrom: "2026-01-01",
      statementTo: "2026-01-31",
      openingBalanceCents: null,
      closingBalanceCents: null,
      rowsTotal: 1,
      rowsImported: 1,
      rowsDuplicate: 0,
      balanceMismatch: false,
    });
    await transactionRepo.assignBatch([inserted!.id], batch.id);

    await documentRepo.deleteById(workspace.id, doc.id);

    const { items } = await transactionRepo.list(workspace.id, account.id, { page: 1, pageSize: 10 });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ sourceDocumentId: null, importBatchId: batch.id });

    const batches = await importBatchRepo.listForAccount(workspace.id, account.id);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({ id: batch.id, sourceDocumentId: null });
  });

  it("listPendingAccountDocuments finds a confirmed bank_statement document with no batch yet, scoped per workspace", async () => {
    const workspace = await createTestWorkspace("Pending Account Co");
    const otherWorkspace = await createTestWorkspace("Other Co");
    const documentRepo = createDrizzleDocumentRepository(db);
    const importBatchRepo = createDrizzleImportBatchRepository(db);

    const pendingDoc = await createTestDocument(workspace.id);
    await documentRepo.markIntakeResult(workspace.id, pendingDoc.id, { kind: "bank_statement", platform: null, intakeStatus: "confirmed", intakeResult: { type: "tabular_confirmed" } });

    const otherWorkspaceDoc = await createTestDocument(otherWorkspace.id);
    await documentRepo.markIntakeResult(otherWorkspace.id, otherWorkspaceDoc.id, { kind: "bank_statement", platform: null, intakeStatus: "confirmed", intakeResult: {} });

    const letterDoc = await createTestDocument(workspace.id);
    // stays "letter"/"not_applicable" - never pending.

    const pending = await importBatchRepo.listPendingAccountDocuments(workspace.id);
    expect(pending.map((d) => d.id)).toEqual([pendingDoc.id]);
    expect(pending.map((d) => d.id)).not.toContain(letterDoc.id);
  });
});

// The "Start" work list's "Zahlungen ohne Beleg" bucket. The count and the "Zuordnung" page
// must agree, so this pins down the two exclusions that are easy to forget: a transaction
// marked "kein Beleg nötig", and anything sitting on a platform clearing account
// (decisions/0026-platform-settlements.md).
describe("countUnmatched agrees with what Zuordnung shows", () => {
  it("excludes a no-document-needed transaction and a clearing-account transaction", async () => {
    const workspace = await createTestWorkspace(`Unmatched Co ${randomUUID()}`);
    const accountRepo = createDrizzleAccountRepository(db);
    const transactionRepo = createDrizzleTransactionRepository(db);
    const bank = await accountRepo.create({ workspaceId: workspace.id, type: "bank", name: "Bankkonto", iban: null, bic: null, currency: "EUR", holder: null, platform: null });
    const clearing = await accountRepo.create({ workspaceId: workspace.id, type: "clearing", name: "Stripe", iban: null, bic: null, currency: "EUR", holder: null, platform: "stripe" });

    await transactionRepo.insertManyIdempotent([
      transactionRowFor(workspace.id, bank.id, { remittanceText: "zaehlt" }),
      transactionRowFor(workspace.id, bank.id, { remittanceText: "kein beleg noetig" }),
      transactionRowFor(workspace.id, clearing.id, { remittanceText: "verrechnungskonto" }),
    ]);

    const before = await transactionRepo.listUnmatched(workspace.id, { page: 1, pageSize: 50 });
    expect(await transactionRepo.countUnmatched(workspace.id)).toBe(before.items.length);

    const noDocumentNeeded = before.items.find((t) => t.remittanceText === "kein beleg noetig");
    await transactionRepo.markNoDocumentNeeded(workspace.id, [noDocumentNeeded!.id]);

    const after = await transactionRepo.listUnmatched(workspace.id, { page: 1, pageSize: 50 });
    expect(after.items.map((t) => t.remittanceText)).toEqual(["zaehlt"]);
    expect(await transactionRepo.countUnmatched(workspace.id)).toBe(1);
  });
});
