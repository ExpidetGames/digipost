// Owner-crossing integration test (WEBAPP_TEMPLATE_SPEC.md §10.1) for F2's accounts import
// (decisions/0024-accounts-and-transactions.md): uploads through the real `POST
// /api/documents` route handler (real Postgres + real MinIO), runs the job runner
// (`runDueJobs`), and verifies the import-account-transactions hook actually ran: a
// camt.053 statement auto-creates its account by IBAN and imports its transactions; a
// confirmed Musterbank-style CSV (no own-account IBAN) is reported `pending_account` until an
// explicit `accountId` is given; re-running an import is idempotent (zero new rows).
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

let currentUser: { id: string; email: string } | null = null;
vi.mock("@/platform/auth/server", () => ({
  getCurrentUser: async () => currentUser,
}));

vi.mock("next/cache", () => ({
  revalidatePath: () => {},
}));

import { getDb } from "@/persistence/foundation/client";
import { getRequestServices } from "@/persistence/composition/request-services";
import { createDrizzleDocumentRepository } from "@/persistence/repositories/drizzle/documents-repository";
import { createDrizzleWorkspaceMemberRepository, createDrizzleWorkspaceRepository } from "@/persistence/repositories/drizzle/workspaces-repository";
import { user } from "@/persistence/schema/auth";
import { runDueJobs } from "@/platform/jobs/server";

import { POST } from "@/app/api/documents/route";

const FIXTURES_DIR = path.join(process.cwd(), "src/modules/intake/tests/fixtures");

function fixtureBytes(name: string): Buffer {
  return readFileSync(path.join(FIXTURES_DIR, name));
}

async function createTestUser(label: string): Promise<{ id: string; email: string }> {
  const email = `${label}-${randomUUID()}@example.test`;
  const [row] = await getDb().insert(user).values({ name: "Accounts Test User", email, emailVerified: false }).returning({ id: user.id });
  if (!row) throw new Error("failed to insert test user fixture");
  return { id: row.id, email };
}

async function createWorkspaceForUser(userId: string, name: string) {
  const workspaceRepo = createDrizzleWorkspaceRepository(getDb());
  const memberRepo = createDrizzleWorkspaceMemberRepository(getDb());
  const workspace = await workspaceRepo.create({ name });
  await memberRepo.create({ workspaceId: workspace.id, userId, role: "admin" });
  return workspace;
}

function postRequest(formData: FormData): Request {
  return new Request("http://localhost/api/documents", { method: "POST", body: formData });
}

function uploadForm(bytes: Buffer, fileName: string, mimeType: string): FormData {
  const formData = new FormData();
  formData.append("files", new File([new Uint8Array(bytes)], fileName, { type: mimeType }));
  return formData;
}

describe("accounts import (F2, real Postgres + MinIO, fake AI)", () => {
  it("a camt.053 statement auto-creates the account by IBAN and imports its transactions", async () => {
    const founder = await createTestUser("camt-accounts");
    currentUser = founder;
    const workspace = await createWorkspaceForUser(founder.id, "Camt Accounts GmbH");

    const bytes = fixtureBytes("camt053-valid.xml");
    const response = await POST(postRequest(uploadForm(bytes, "kontoauszug.xml", "application/xml")), {} as never);
    expect(response.status).toBe(201);
    const { documentId } = (await response.json()) as { documentId: string };

    await runDueJobs({ workspaceId: workspace.id, limit: 10 });

    const accounts = await getRequestServices().accounts.listAccounts(workspace.id);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ type: "bank" });

    const batches = await getRequestServices().accounts.listImportBatches(workspace.id, accounts[0]!.id);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({ sourceDocumentId: documentId, rowsImported: 8, rowsDuplicate: 0 });

    const transactions = await getRequestServices().accounts.listTransactions(workspace.id, accounts[0]!.id, { page: 1, pageSize: 50 });
    expect(transactions.items).toHaveLength(8);

    // Re-running the import directly (idempotent - the pipeline already triggered it once via
    // the job, this proves the use case itself is safe to call again, e.g. from "Erneut
    // importieren"): zero new rows, the same account, the same batch row.
    const rerun = await getRequestServices().accounts.importFromDocument({ workspaceId: workspace.id, documentId });
    expect(rerun).toMatchObject({ status: "imported", accountId: accounts[0]!.id, rowsImported: 0, rowsDuplicate: 8 });
    expect(await getRequestServices().accounts.listImportBatches(workspace.id, accounts[0]!.id)).toHaveLength(1);
  });

  it("a confirmed Musterbank-style CSV (no own-account IBAN) reports pending_account until an explicit accountId is given", async () => {
    const founder = await createTestUser("musterbank-accounts");
    currentUser = founder;
    const workspace = await createWorkspaceForUser(founder.id, "Musterbank Accounts GmbH");

    const csv = fixtureBytes("musterbank-statement.csv");
    const uploadResponse = await POST(postRequest(uploadForm(csv, "kontoauszug.csv", "text/csv")), {} as never);
    expect(uploadResponse.status).toBe(201);
    const { documentId } = (await uploadResponse.json()) as { documentId: string };

    await runDueJobs({ workspaceId: workspace.id, limit: 10 });

    const pendingBeforeConfirm = await getRequestServices().documents.getById(workspace.id, documentId);
    expect(pendingBeforeConfirm?.intakeStatus).toBe("pending_confirmation");
    const proposal = pendingBeforeConfirm?.intakeResult;
    if (proposal?.type !== "tabular_proposal") throw new Error("expected a tabular_proposal intake result");

    await getRequestServices().documents.confirmIntake({
      workspaceId: workspace.id,
      documentId,
      actingUserId: founder.id,
      documentKind: "bank_statement",
      platform: null,
      mapping: proposal.columnMapping,
      amountSign: proposal.amountSign,
    });

    // `confirmIntake` itself enqueues the import job (decisions/0024's "re-runnable" hook) -
    // it finds no own-account IBAN anywhere in the mapped rows and reports pending_account,
    // creating no account/transactions.
    await runDueJobs({ workspaceId: workspace.id, limit: 10 });
    expect(await getRequestServices().accounts.listAccounts(workspace.id)).toHaveLength(0);

    const pendingDocs = await getRequestServices().accounts.listPendingAccountDocuments(workspace.id);
    expect(pendingDocs.map((d) => d.id)).toEqual([documentId]);

    const account = await getRequestServices().accounts.createAccount({
      workspaceId: workspace.id,
      type: "bank",
      name: "Geschäftskonto",
      iban: null,
      bic: null,
      currency: "EUR",
      holder: null,
      platform: null,
    });

    const outcome = await getRequestServices().accounts.importFromDocument({ workspaceId: workspace.id, documentId, accountId: account.id });
    expect(outcome).toMatchObject({ status: "imported", accountId: account.id });
    expect(await getRequestServices().accounts.listPendingAccountDocuments(workspace.id)).toHaveLength(0);
  });

  it(
    "F2 review finding #1 (fixed by R2): two NOTPROVIDED-EndToEndId entries on the same day for " +
      "the same amount both survive as distinct transactions, not collapsed by the idempotency key",
    async () => {
      const founder = await createTestUser("notprovided-accounts");
      currentUser = founder;
      const workspace = await createWorkspaceForUser(founder.id, "Notprovided Accounts GmbH");

      const bytes = fixtureBytes("camt053-notprovided.xml");
      const response = await POST(postRequest(uploadForm(bytes, "kontoauszug.xml", "application/xml")), {} as never);
      expect(response.status).toBe(201);
      const { documentId } = (await response.json()) as { documentId: string };

      await runDueJobs({ workspaceId: workspace.id, limit: 10 });

      const accounts = await getRequestServices().accounts.listAccounts(workspace.id);
      expect(accounts).toHaveLength(1);

      // All 4 entries (the two NOTPROVIDED/same-day/same-amount ones, plus the two otherwise-
      // identical bank fees the fixture also exercises) must survive as distinct rows - a
      // pre-R2 idempotency key would have collapsed at least the first pair onto one row.
      const transactions = await getRequestServices().accounts.listTransactions(workspace.id, accounts[0]!.id, { page: 1, pageSize: 50 });
      expect(transactions.items).toHaveLength(4);
      const creditFifty = transactions.items.filter((t) => t.amountCents === 5000 && t.creditDebit === "credit");
      expect(creditFifty).toHaveLength(2);
      expect(new Set(creditFifty.map((t) => t.id)).size).toBe(2);

      // Re-running the import is still idempotent against the real (account_id,
      // idempotency_key) unique constraint - zero new rows, all 4 reported as duplicates.
      const rerun = await getRequestServices().accounts.importFromDocument({ workspaceId: workspace.id, documentId });
      expect(rerun).toMatchObject({ status: "imported", rowsImported: 0, rowsDuplicate: 4 });
    },
  );

  it("an MT940 statement auto-creates the account by IBAN and imports its transactions with correct signs/counterparties (decisions/0028-mt940-support.md)", async () => {
    const founder = await createTestUser("mt940-accounts");
    currentUser = founder;
    const workspace = await createWorkspaceForUser(founder.id, "MT940 Accounts GmbH");

    const bytes = fixtureBytes("mt940-valid.mt940");
    const response = await POST(postRequest(uploadForm(bytes, "umsaetze.mt940", "text/plain")), {} as never);
    expect(response.status).toBe(201);
    const { documentId } = (await response.json()) as { documentId: string };

    await runDueJobs({ workspaceId: workspace.id, limit: 10 });

    const accounts = await getRequestServices().accounts.listAccounts(workspace.id);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ type: "bank", iban: "DE02120300000000202051" });

    const batches = await getRequestServices().accounts.listImportBatches(workspace.id, accounts[0]!.id);
    expect(batches).toHaveLength(1);
    // Both statements' 4 + 1 transactions collapse into one batch (decisions/0024's "one
    // document, one batch" simplification), and both statements individually reconcile.
    expect(batches[0]).toMatchObject({ sourceDocumentId: documentId, rowsImported: 5, rowsDuplicate: 0, balanceMismatch: false });

    const transactions = await getRequestServices().accounts.listTransactions(workspace.id, accounts[0]!.id, { page: 1, pageSize: 50 });
    expect(transactions.items).toHaveLength(5);

    const credit = transactions.items.find((t) => t.amountCents === 25000);
    expect(credit).toMatchObject({ creditDebit: "credit", counterpartyName: "Kunde AG", counterpartyIban: "DE89370400440532013000" });

    const directDebit = transactions.items.find((t) => t.amountCents === -7550);
    expect(directDebit).toMatchObject({ creditDebit: "debit", counterpartyName: "Vermieter GmbHCo KG" });

    const reversal = transactions.items.find((t) => t.amountCents === -3000);
    expect(reversal).toMatchObject({ creditDebit: "debit" });

    const wrapped = transactions.items.find((t) => t.amountCents === -14450);
    expect(wrapped).toMatchObject({ creditDebit: "debit", counterpartyName: "Müller & Söhne GmbH", counterpartyIban: "DE44500105175407324931" });

    // Idempotent re-import: zero new rows, the same account, the same batch row.
    const rerun = await getRequestServices().accounts.importFromDocument({ workspaceId: workspace.id, documentId });
    expect(rerun).toMatchObject({ status: "imported", accountId: accounts[0]!.id, rowsImported: 0, rowsDuplicate: 5 });
    expect(await getRequestServices().accounts.listImportBatches(workspace.id, accounts[0]!.id)).toHaveLength(1);
  });

  it("workspace scoping: accounts and transactions from one workspace never surface in another", async () => {
    const founderA = await createTestUser("scoping-a");
    currentUser = founderA;
    const workspaceA = await createWorkspaceForUser(founderA.id, "Scoping A GmbH");
    const bytes = fixtureBytes("camt053-valid.xml");
    const uploadA = await POST(postRequest(uploadForm(bytes, "kontoauszug.xml", "application/xml")), {} as never);
    expect(uploadA.status).toBe(201);
    await runDueJobs({ workspaceId: workspaceA.id, limit: 10 });

    const founderB = await createTestUser("scoping-b");
    const workspaceB = await createWorkspaceForUser(founderB.id, "Scoping B GmbH");

    expect(await getRequestServices().accounts.listAccounts(workspaceA.id)).toHaveLength(1);
    expect(await getRequestServices().accounts.listAccounts(workspaceB.id)).toHaveLength(0);

    const documentRepo = createDrizzleDocumentRepository(getDb());
    const docA = (await documentRepo.list(workspaceA.id, { page: 1, pageSize: 1 })).items[0]!;
    // A document from workspace A is not importable from workspace B's own accounts use case
    // (`document.findById` is workspace-scoped) - `not_importable`/`not_found` either way,
    // never a cross-workspace import.
    await expect(getRequestServices().accounts.importFromDocument({ workspaceId: workspaceB.id, documentId: docA.id })).rejects.toThrow();
  });
});
