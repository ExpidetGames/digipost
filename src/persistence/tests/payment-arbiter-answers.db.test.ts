// Real Postgres (WEBAPP_TEMPLATE_SPEC.md §10.1/§10.3) for the arbiter answer cache
// (decisions/0077-arbiter-answer-cache.md): one row per transaction that a new answer replaces,
// workspace-scoped reads and writes, and removal together with the transaction and the
// workspace (the foreign keys, which a fake cannot prove).
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { getDb } from "@/persistence/foundation/client";
import { createDrizzleAccountRepository, createDrizzleTransactionRepository } from "@/persistence/repositories/drizzle/accounts-repository";
import { createDrizzlePaymentArbiterAnswerRepository } from "@/persistence/repositories/drizzle/payments-repository";
import { createDrizzleWorkspaceRepository } from "@/persistence/repositories/drizzle/workspaces-repository";
import { transactions } from "@/persistence/schema/accounts";
import { paymentArbiterAnswers } from "@/persistence/schema/payments";

const db = getDb();
const answerRepo = createDrizzlePaymentArbiterAnswerRepository(db);
const workspaceRepo = createDrizzleWorkspaceRepository(db);

async function createWorkspaceWithTransaction(): Promise<{ workspaceId: string; transactionId: string }> {
  const workspace = await workspaceRepo.create({ name: `Arbiter Cache Co ${randomUUID()}` });
  const account = await createDrizzleAccountRepository(db).create({
    workspaceId: workspace.id,
    type: "bank",
    name: "Girokonto",
    iban: null,
    bic: null,
    currency: "EUR",
    holder: null,
    platform: null,
  });
  const [transaction] = await createDrizzleTransactionRepository(db).insertManyIdempotent([
    {
      workspaceId: workspace.id,
      accountId: account.id,
      bookingDate: "2026-01-15",
      valueDate: null,
      amountCents: -1_000,
      currency: "EUR",
      creditDebit: "debit",
      counterpartyName: "Unbekannt",
      counterpartyIban: null,
      counterpartyBic: null,
      remittanceText: "Lastschrift",
      endToEndId: null,
      mandateId: null,
      creditorId: null,
      bankTxCode: null,
      bankReference: null,
      idempotencyKey: `key-${randomUUID()}`,
      importBatchId: null,
      sourceDocumentId: null,
      raw: null,
    },
  ]);
  if (!transaction) throw new Error("failed to insert transaction fixture");
  return { workspaceId: workspace.id, transactionId: transaction.id };
}

const NO_MATCH = { bestDocumentId: null, confidence: 0, reason: "Keine passt." };

describe("createDrizzlePaymentArbiterAnswerRepository (decisions/0077-arbiter-answer-cache.md)", () => {
  it("returns null before the arbiter was ever asked about a transaction", async () => {
    const { workspaceId, transactionId } = await createWorkspaceWithTransaction();
    expect(await answerRepo.findForTransaction(workspaceId, transactionId)).toBeNull();
  });

  it("stores a no-match answer and finds it again", async () => {
    const { workspaceId, transactionId } = await createWorkspaceWithTransaction();
    await answerRepo.upsert({ workspaceId, transactionId, cacheKey: "key-1", ...NO_MATCH });

    expect(await answerRepo.findForTransaction(workspaceId, transactionId)).toMatchObject({ workspaceId, transactionId, cacheKey: "key-1", ...NO_MATCH });
  });

  it("keeps one row per transaction: an answer to a new question replaces the old one", async () => {
    const { workspaceId, transactionId } = await createWorkspaceWithTransaction();
    await answerRepo.upsert({ workspaceId, transactionId, cacheKey: "key-1", ...NO_MATCH });
    // A raw pick is stored as answered, even an id that is no document at all.
    await answerRepo.upsert({ workspaceId, transactionId, cacheKey: "key-2", bestDocumentId: "not-a-candidate", confidence: 0.75, reason: "Betrag passt." });

    const rows = await db.select().from(paymentArbiterAnswers).where(eq(paymentArbiterAnswers.transactionId, transactionId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ cacheKey: "key-2", bestDocumentId: "not-a-candidate", confidence: 0.75, reason: "Betrag passt." });
  });

  it("is workspace-scoped: another workspace neither reads nor overwrites the answer", async () => {
    const own = await createWorkspaceWithTransaction();
    const other = await createWorkspaceWithTransaction();
    await answerRepo.upsert({ workspaceId: own.workspaceId, transactionId: own.transactionId, cacheKey: "key-1", ...NO_MATCH });

    expect(await answerRepo.findForTransaction(other.workspaceId, own.transactionId)).toBeNull();
    await answerRepo.upsert({ workspaceId: other.workspaceId, transactionId: own.transactionId, cacheKey: "forged", ...NO_MATCH });
    expect(await answerRepo.findForTransaction(own.workspaceId, own.transactionId)).toMatchObject({ cacheKey: "key-1" });
  });

  it("is removed together with its transaction", async () => {
    const { workspaceId, transactionId } = await createWorkspaceWithTransaction();
    await answerRepo.upsert({ workspaceId, transactionId, cacheKey: "key-1", ...NO_MATCH });

    await db.delete(transactions).where(eq(transactions.id, transactionId));

    expect(await db.select().from(paymentArbiterAnswers).where(eq(paymentArbiterAnswers.transactionId, transactionId))).toHaveLength(0);
  });
});
