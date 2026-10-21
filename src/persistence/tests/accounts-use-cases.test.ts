// Unit tests for createAccountsUseCases (WEBAPP_TEMPLATE_SPEC.md §10.2): typed fakes via
// dependency injection, no DB, no vi.mock. Covers the import service's account
// resolution/auto-creation, idempotent re-import (zero new rows the second time), the
// "pending account" outcome for a source with no own-account IBAN, and workspace scoping.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { MT940_MIME_TYPE } from "@/modules/intake";

import { createFakeObjectStorage } from "@/platform/object-storage/tests/support/fake-object-storage";
import { createFakeDocumentRepository, createFakeIntakeFingerprintRepository, documentRow } from "@/persistence/tests/support/fake-documents-repositories";
import {
  accountRow,
  createFakeAccountRepository,
  createFakeImportBatchRepository,
  createFakeSettlementLineRepository,
  createFakeTransactionRepository,
  importBatchRow,
  transactionRow,
} from "@/persistence/tests/support/fake-accounts-repositories";
import { createFakeJobsRepository } from "@/persistence/tests/support/fake-jobs-repository";
import { withUnusedRepositories } from "@/persistence/tests/support/unused-repositories";
import type { Repositories, UnitOfWork } from "@/persistence/repositories/contracts";
import { ACCOUNT_ERROR, createAccountsUseCases } from "@/persistence/use-cases/accounts-use-cases";
import { UseCaseError } from "@/persistence/use-cases/errors";

const CAMT_053_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02">
  <BkToCstmrStmt>
    <Stmt>
      <Id>STMT-1</Id>
      <Acct><Id><IBAN>DE89370400440532013000</IBAN></Id><Ccy>EUR</Ccy></Acct>
      <Bal><Tp><CdOrPrtry><Cd>OPBD</Cd></CdOrPrtry></Tp><Amt Ccy="EUR">100.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>2026-01-01</Dt></Dt></Bal>
      <Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp><Amt Ccy="EUR">150.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>2026-01-31</Dt></Dt></Bal>
      <Ntry>
        <Amt Ccy="EUR">50.00</Amt>
        <CdtDbtInd>CRDT</CdtDbtInd>
        <BookgDt><Dt>2026-01-15</Dt></BookgDt>
      </Ntry>
    </Stmt>
  </BkToCstmrStmt>
</Document>`;

function textBytes(input: string): Uint8Array {
  return new TextEncoder().encode(input);
}

function readIntakeFixtureText(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../../modules/intake/tests/fixtures/${name}`, import.meta.url)), "utf8");
}

function setup(options: { documents?: Parameters<typeof createFakeDocumentRepository>[0] } = {}) {
  const { repo: document, state: documentState } = createFakeDocumentRepository(options.documents);
  const { repo: account, state: accountState } = createFakeAccountRepository();
  const { repo: transaction, state: transactionState } = createFakeTransactionRepository();
  const { repo: importBatch, state: importBatchState } = createFakeImportBatchRepository();
  const { repo: settlementLine, state: settlementLineState } = createFakeSettlementLineRepository();
  const { repo: intakeFingerprint } = createFakeIntakeFingerprintRepository();
  const { repo: jobs, state: jobState } = createFakeJobsRepository();

  const repos: Repositories = withUnusedRepositories({ document, account, transaction, importBatch, settlementLine, intakeFingerprint, jobs });
  const uow: UnitOfWork = { transaction: (work) => work(repos) };
  const { storage, objects } = createFakeObjectStorage();

  const useCases = createAccountsUseCases({ repos, uow, objectStorage: storage });

  return { useCases, documentState, accountState, transactionState, importBatchState, settlementLineState, storage, objects, jobState };
}

describe("createAccountsUseCases", () => {
  describe("importFromDocument - camt.053", () => {
    it("auto-creates the account by the statement's own IBAN and imports its transactions", async () => {
      const doc = documentRow({
        workspaceId: "w1",
        storageKey: "workspaces/w1/documents/d1/original.xml",
        mimeType: "application/xml",
        kind: "bank_statement",
        intakeStatus: "confirmed",
      });
      const { useCases, accountState, transactionState, importBatchState, storage, jobState } = setup({ documents: [doc] });
      await storage.putObject({ key: doc.storageKey, body: textBytes(CAMT_053_XML), contentType: "application/xml" });

      const outcome = await useCases.importFromDocument({ workspaceId: "w1", documentId: doc.id });

      expect(outcome).toMatchObject({ status: "imported", accountCreated: true, rowsTotal: 1, rowsImported: 1, rowsDuplicate: 0 });
      // F3b (decisions/0025-payment-matching-wiring.md): a successful import with at least one
      // new transaction triggers a workspace-wide matching run.
      expect(jobState.filter((j) => j.kind === "match-payments")).toHaveLength(1);
      expect(accountState).toHaveLength(1);
      expect(accountState[0]).toMatchObject({ iban: "DE89370400440532013000", type: "bank" });
      expect(transactionState).toHaveLength(1);
      expect(transactionState[0]).toMatchObject({ accountId: accountState[0]!.id, amountCents: 5000, creditDebit: "credit" });
      expect(importBatchState).toHaveLength(1);
      // 100.00 opening + 50.00 credit transaction = 150.00, which matches the fixture's own
      // closing balance exactly - reconciles cleanly.
      expect(importBatchState[0]).toMatchObject({
        sourceDocumentId: doc.id,
        openingBalanceCents: 10000,
        closingBalanceCents: 15000,
        balanceMismatch: false,
      });
    });

    it("re-importing the same document inserts zero new transactions and upserts the same batch row", async () => {
      const doc = documentRow({
        workspaceId: "w1",
        storageKey: "workspaces/w1/documents/d1/original.xml",
        mimeType: "application/xml",
        kind: "bank_statement",
        intakeStatus: "confirmed",
      });
      const { useCases, transactionState, importBatchState, storage, jobState } = setup({ documents: [doc] });
      await storage.putObject({ key: doc.storageKey, body: textBytes(CAMT_053_XML), contentType: "application/xml" });

      const first = await useCases.importFromDocument({ workspaceId: "w1", documentId: doc.id });
      const second = await useCases.importFromDocument({ workspaceId: "w1", documentId: doc.id });

      expect(first.status).toBe("imported");
      expect(second).toMatchObject({ status: "imported", rowsTotal: 1, rowsImported: 0, rowsDuplicate: 1 });
      expect(transactionState).toHaveLength(1);
      expect(importBatchState).toHaveLength(1);
      // The second, zero-new-rows re-import never re-triggers matching (nothing could have
      // changed its conclusion).
      expect(jobState.filter((j) => j.kind === "match-payments")).toHaveLength(1);
    });

    it("resolves an already-known account by IBAN instead of creating a second one", async () => {
      const existing = accountRow({ workspaceId: "w1", iban: "DE89370400440532013000" });
      const doc = documentRow({
        workspaceId: "w1",
        storageKey: "workspaces/w1/documents/d1/original.xml",
        mimeType: "application/xml",
        kind: "bank_statement",
        intakeStatus: "confirmed",
      });
      const { useCases, accountState, storage } = setup({ documents: [doc] });
      accountState.push(existing);
      await storage.putObject({ key: doc.storageKey, body: textBytes(CAMT_053_XML), contentType: "application/xml" });

      const outcome = await useCases.importFromDocument({ workspaceId: "w1", documentId: doc.id });

      expect(outcome).toMatchObject({ status: "imported", accountId: existing.id, accountCreated: false });
      expect(accountState).toHaveLength(1);
    });
  });

  describe("importFromDocument - MT940 (decisions/0028-mt940-support.md)", () => {
    // Reuses camt.053's own IBAN/currency/amounts so both tests assert the identical resulting
    // shape - proving `Mt940Statement`'s shared shape with `Camt053Statement` really does make
    // the import service work unmodified for the new format.
    const MT940_STATEMENT = [
      ":20:STMT1",
      ":25:DE89370400440532013000",
      ":28C:00001/001",
      ":60F:C260101EUR100,00",
      ":61:2601150115C50,00NTRFREF1",
      ":86:000?00GUTSCHR?20EREF+X1?32Kunde AG",
      ":62F:C260115EUR150,00",
      "-",
    ].join("\n");

    it("auto-creates the account by the statement's own IBAN and imports its transactions", async () => {
      const doc = documentRow({
        workspaceId: "w1",
        storageKey: "workspaces/w1/documents/d1/original.mt940",
        mimeType: MT940_MIME_TYPE,
        kind: "bank_statement",
        intakeStatus: "confirmed",
      });
      const { useCases, accountState, transactionState, importBatchState, storage } = setup({ documents: [doc] });
      await storage.putObject({ key: doc.storageKey, body: textBytes(MT940_STATEMENT), contentType: MT940_MIME_TYPE });

      const outcome = await useCases.importFromDocument({ workspaceId: "w1", documentId: doc.id });

      expect(outcome).toMatchObject({ status: "imported", accountCreated: true, rowsTotal: 1, rowsImported: 1, rowsDuplicate: 0 });
      expect(accountState).toHaveLength(1);
      expect(accountState[0]).toMatchObject({ iban: "DE89370400440532013000", type: "bank" });
      expect(transactionState).toHaveLength(1);
      expect(transactionState[0]).toMatchObject({ accountId: accountState[0]!.id, amountCents: 5000, creditDebit: "credit" });
      expect(importBatchState[0]).toMatchObject({ sourceDocumentId: doc.id, openingBalanceCents: 10000, closingBalanceCents: 15000, balanceMismatch: false });
    });

    it("re-importing the same MT940 document inserts zero new transactions (idempotent)", async () => {
      const doc = documentRow({
        workspaceId: "w1",
        storageKey: "workspaces/w1/documents/d1/original.mt940",
        mimeType: MT940_MIME_TYPE,
        kind: "bank_statement",
        intakeStatus: "confirmed",
      });
      const { useCases, transactionState, storage } = setup({ documents: [doc] });
      await storage.putObject({ key: doc.storageKey, body: textBytes(MT940_STATEMENT), contentType: MT940_MIME_TYPE });

      await useCases.importFromDocument({ workspaceId: "w1", documentId: doc.id });
      const second = await useCases.importFromDocument({ workspaceId: "w1", documentId: doc.id });

      expect(second).toMatchObject({ status: "imported", rowsTotal: 1, rowsImported: 0, rowsDuplicate: 1 });
      expect(transactionState).toHaveLength(1);
    });

    it("falls into the pending_account flow when the statement's :25: carries no IBAN", async () => {
      const doc = documentRow({
        workspaceId: "w1",
        storageKey: "workspaces/w1/documents/d1/original.mt940",
        mimeType: MT940_MIME_TYPE,
        kind: "bank_statement",
        intakeStatus: "confirmed",
      });
      const { useCases, storage, transactionState } = setup({ documents: [doc] });
      const noIbanStatement = MT940_STATEMENT.replace(":25:DE89370400440532013000", ":25:10020030/1234567");
      await storage.putObject({ key: doc.storageKey, body: textBytes(noIbanStatement), contentType: MT940_MIME_TYPE });

      const outcome = await useCases.importFromDocument({ workspaceId: "w1", documentId: doc.id });

      expect(outcome).toEqual({ status: "pending_account", reason: "missing_iban" });
      expect(transactionState).toHaveLength(0);
    });
  });

  describe("importFromDocument - Apple payment summary and Google Play earnings (decisions/0048-app-store-reports.md)", () => {
    it("imports the real Apple report into a new clearing account: one revenue line per region, no fee, no payout line", async () => {
      const doc = documentRow({
        workspaceId: "w1",
        storageKey: "workspaces/w1/documents/d1/original.csv",
        mimeType: "text/csv",
        kind: "payout_report",
        platform: "apple",
        intakeStatus: "confirmed",
      });
      const { useCases, accountState, transactionState, settlementLineState, storage } = setup({ documents: [doc] });
      await storage.putObject({ key: doc.storageKey, body: textBytes(readIntakeFixtureText("apple-payment-summary.csv")), contentType: "text/csv" });

      const outcome = await useCases.importFromDocument({ workspaceId: "w1", documentId: doc.id });

      expect(outcome).toMatchObject({ status: "settlement_imported", accountCreated: true, linesTotal: 4, linesImported: 4 });
      expect(accountState).toHaveLength(1);
      expect(accountState[0]).toMatchObject({ type: "clearing", platform: "apple" });
      expect(settlementLineState.filter((l) => l.type === "revenue")).toHaveLength(4);
      expect(settlementLineState.filter((l) => l.type === "fee")).toHaveLength(0);
      expect(settlementLineState.filter((l) => l.type === "payout")).toHaveLength(0);
      // Every revenue line lands as its own credit transaction on the clearing account, in the
      // bank currency the report itself states - the sum matches the footer's own 61.51 EUR.
      const revenueTxIds = new Set(settlementLineState.filter((l) => l.type === "revenue").map((l) => l.transactionId));
      const revenueSum = transactionState.filter((t) => revenueTxIds.has(t.id)).reduce((sum, t) => sum + t.amountCents, 0);
      expect(revenueSum).toBe(6151);
    });

    it("re-importing the same Apple report inserts zero new settlement lines (idempotent)", async () => {
      const doc = documentRow({
        workspaceId: "w1",
        storageKey: "workspaces/w1/documents/d1/original.csv",
        mimeType: "text/csv",
        kind: "payout_report",
        platform: "apple",
        intakeStatus: "confirmed",
      });
      const { useCases, settlementLineState, storage } = setup({ documents: [doc] });
      await storage.putObject({ key: doc.storageKey, body: textBytes(readIntakeFixtureText("apple-payment-summary.csv")), contentType: "text/csv" });

      await useCases.importFromDocument({ workspaceId: "w1", documentId: doc.id });
      const second = await useCases.importFromDocument({ workspaceId: "w1", documentId: doc.id });

      expect(second).toMatchObject({ status: "settlement_imported", linesTotal: 4, linesImported: 0, linesDuplicate: 4 });
      expect(settlementLineState).toHaveLength(4);
    });

    it("imports the real Google Play earnings report: one revenue line per Charge, one fee line per Google fee", async () => {
      const doc = documentRow({
        workspaceId: "w1",
        storageKey: "workspaces/w1/documents/d2/original.csv",
        mimeType: "text/csv",
        kind: "platform_settlement",
        platform: "google",
        intakeStatus: "confirmed",
      });
      const { useCases, accountState, settlementLineState, storage } = setup({ documents: [doc] });
      await storage.putObject({ key: doc.storageKey, body: textBytes(readIntakeFixtureText("google-play-earnings.csv")), contentType: "text/csv" });

      const outcome = await useCases.importFromDocument({ workspaceId: "w1", documentId: doc.id });

      expect(outcome).toMatchObject({ status: "settlement_imported", accountCreated: true, linesTotal: 8, linesImported: 8 });
      expect(accountState[0]).toMatchObject({ type: "clearing", platform: "google" });
      expect(settlementLineState.filter((l) => l.type === "revenue")).toHaveLength(4);
      expect(settlementLineState.filter((l) => l.type === "fee")).toHaveLength(4);
      expect(settlementLineState.filter((l) => l.type === "payout")).toHaveLength(0);
    });
  });

  describe("importFromDocument - tabular (no own-account IBAN)", () => {
    const TABULAR_ROWS = [
      {
        rowNumber: 1,
        idempotencyKey: "abc123",
        bookingDate: "2026-01-15",
        valueDate: null,
        amountCents: 10000,
        creditDebit: "credit" as const,
        currency: "EUR",
        counterpartyName: "Kunde AG",
        counterpartyIban: "DE89370400440532013000",
        reference: "Rechnung 1",
        endToEndId: null,
      },
    ];

    it("reports pending_account when the document has no own-account IBAN and no accountId is given", async () => {
      const doc = documentRow({
        workspaceId: "w1",
        storageKey: "workspaces/w1/documents/d1/original.csv",
        mimeType: "text/csv",
        kind: "bank_statement",
        intakeStatus: "confirmed",
        intakeResult: { type: "tabular_confirmed", documentKind: "bank_statement", platform: null, rowCount: 1, truncated: false, rows: TABULAR_ROWS },
      });
      const { useCases, storage, transactionState } = setup({ documents: [doc] });
      await storage.putObject({ key: doc.storageKey, body: textBytes("irrelevant"), contentType: "text/csv" });

      const outcome = await useCases.importFromDocument({ workspaceId: "w1", documentId: doc.id });

      expect(outcome).toEqual({ status: "pending_account", reason: "missing_iban" });
      expect(transactionState).toHaveLength(0);
    });

    it("imports against an explicitly given accountId", async () => {
      const target = accountRow({ workspaceId: "w1", name: "Geschäftskonto" });
      const doc = documentRow({
        workspaceId: "w1",
        storageKey: "workspaces/w1/documents/d1/original.csv",
        mimeType: "text/csv",
        kind: "bank_statement",
        intakeStatus: "confirmed",
        intakeResult: { type: "tabular_confirmed", documentKind: "bank_statement", platform: null, rowCount: 1, truncated: false, rows: TABULAR_ROWS },
      });
      const { useCases, accountState, storage, transactionState } = setup({ documents: [doc] });
      accountState.push(target);
      await storage.putObject({ key: doc.storageKey, body: textBytes("irrelevant"), contentType: "text/csv" });

      const outcome = await useCases.importFromDocument({ workspaceId: "w1", documentId: doc.id, accountId: target.id });

      expect(outcome).toMatchObject({ status: "imported", accountId: target.id, rowsImported: 1 });
      expect(transactionState).toHaveLength(1);
      expect(transactionState[0]?.accountId).toBe(target.id);
    });

    it("F5 review finding (F2 #4): rejects an explicit accountId that resolves to a clearing account", async () => {
      const clearing = accountRow({ workspaceId: "w1", type: "clearing", platform: "stripe" });
      const doc = documentRow({
        workspaceId: "w1",
        storageKey: "workspaces/w1/documents/d1/original.csv",
        mimeType: "text/csv",
        kind: "bank_statement",
        intakeStatus: "confirmed",
        intakeResult: { type: "tabular_confirmed", documentKind: "bank_statement", platform: null, rowCount: 1, truncated: false, rows: TABULAR_ROWS },
      });
      const { useCases, accountState, storage } = setup({ documents: [doc] });
      accountState.push(clearing);
      await storage.putObject({ key: doc.storageKey, body: textBytes("irrelevant"), contentType: "text/csv" });

      await expect(useCases.importFromDocument({ workspaceId: "w1", documentId: doc.id, accountId: clearing.id })).rejects.toMatchObject({
        code: ACCOUNT_ERROR.notBankAccount,
      });
    });
  });

  describe("importFromDocument - guard rails", () => {
    it("rejects a document that is not a confirmed bank_statement", async () => {
      const doc = documentRow({ workspaceId: "w1", storageKey: "workspaces/w1/documents/d1/original.pdf", kind: "letter" });
      const { useCases } = setup({ documents: [doc] });

      await expect(useCases.importFromDocument({ workspaceId: "w1", documentId: doc.id })).rejects.toThrow(UseCaseError);
      try {
        await useCases.importFromDocument({ workspaceId: "w1", documentId: doc.id });
        throw new Error("expected to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(UseCaseError);
        expect((err as UseCaseError).code).toBe(ACCOUNT_ERROR.notImportable);
      }
    });

    it("scopes account resolution per workspace", async () => {
      const doc = documentRow({
        workspaceId: "w1",
        storageKey: "workspaces/w1/documents/d1/original.xml",
        mimeType: "application/xml",
        kind: "bank_statement",
        intakeStatus: "confirmed",
      });
      const otherWorkspaceAccount = accountRow({ workspaceId: "w2", iban: "DE89370400440532013000" });
      const { useCases, accountState, storage } = setup({ documents: [doc] });
      accountState.push(otherWorkspaceAccount);
      await storage.putObject({ key: doc.storageKey, body: textBytes(CAMT_053_XML), contentType: "application/xml" });

      const outcome = await useCases.importFromDocument({ workspaceId: "w1", documentId: doc.id });

      expect(outcome).toMatchObject({ status: "imported", accountCreated: true });
      expect(accountState.filter((a) => a.workspaceId === "w1")).toHaveLength(1);
    });
  });

  describe("listAccounts (F5 review finding F2 #3, decisions/0027-hardening-and-deletion.md)", () => {
    it("uses the batch's own closing balance as the exact latest balance when one exists", async () => {
      const account = accountRow({ workspaceId: "w1", currency: "EUR" });
      const { useCases, accountState, importBatchState } = setup();
      accountState.push(account);
      importBatchState.push(importBatchRow({ workspaceId: "w1", accountId: account.id, closingBalanceCents: 12345 }));

      const [overview] = await useCases.listAccounts("w1");

      expect(overview).toMatchObject({ latestBalanceCents: 12345, balanceIsExact: true, hasMixedCurrencyTransactions: false });
    });

    it("falls back to the transaction sum, excluding a differently-currencied row and flagging it", async () => {
      const account = accountRow({ workspaceId: "w1", currency: "EUR" });
      const { useCases, accountState, importBatchState, transactionState } = setup();
      accountState.push(account);
      // No batch carries a closing balance (a tabular/CSV-only import) - the fallback sum path.
      importBatchState.push(importBatchRow({ workspaceId: "w1", accountId: account.id, closingBalanceCents: null }));
      transactionState.push(
        transactionRow({ workspaceId: "w1", accountId: account.id, amountCents: 1000, currency: "EUR", idempotencyKey: "k1" }),
        transactionRow({ workspaceId: "w1", accountId: account.id, amountCents: 500, currency: null, idempotencyKey: "k2" }),
        // A genuinely different currency - must never be added to a EUR total.
        transactionRow({ workspaceId: "w1", accountId: account.id, amountCents: 99999, currency: "USD", idempotencyKey: "k3" }),
      );

      const [overview] = await useCases.listAccounts("w1");

      expect(overview).toMatchObject({
        // 1000 (EUR) + 500 (null, assumed EUR) - the USD row is excluded, not added.
        latestBalanceCents: 1500,
        balanceIsExact: false,
        hasMixedCurrencyTransactions: true,
      });
    });

    it("reports hasMixedCurrencyTransactions: false when every transaction matches the account's own currency (or has none)", async () => {
      const account = accountRow({ workspaceId: "w1", currency: "EUR" });
      const { useCases, accountState, importBatchState, transactionState } = setup();
      accountState.push(account);
      importBatchState.push(importBatchRow({ workspaceId: "w1", accountId: account.id, closingBalanceCents: null }));
      transactionState.push(
        transactionRow({ workspaceId: "w1", accountId: account.id, amountCents: 1000, currency: "EUR", idempotencyKey: "k1" }),
        transactionRow({ workspaceId: "w1", accountId: account.id, amountCents: 500, currency: null, idempotencyKey: "k2" }),
      );

      const [overview] = await useCases.listAccounts("w1");

      expect(overview).toMatchObject({ latestBalanceCents: 1500, hasMixedCurrencyTransactions: false });
    });

    it("reports null latestBalanceCents (never hasMixedCurrencyTransactions) for an account with no import batch at all", async () => {
      const account = accountRow({ workspaceId: "w1", currency: "EUR" });
      const { useCases, accountState } = setup();
      accountState.push(account);

      const [overview] = await useCases.listAccounts("w1");

      expect(overview).toMatchObject({ latestBalanceCents: null, balanceIsExact: false, hasMixedCurrencyTransactions: false });
    });
  });

  describe("updateAccount (F5 review finding F2 #2, decisions/0027-hardening-and-deletion.md)", () => {
    it("blocks an IBAN change once the account has at least one import batch", async () => {
      const account = accountRow({ workspaceId: "w1", iban: "DE89370400440532013000" });
      const { useCases, accountState, importBatchState } = setup();
      accountState.push(account);
      importBatchState.push(importBatchRow({ workspaceId: "w1", accountId: account.id }));

      await expect(
        useCases.updateAccount({
          workspaceId: "w1",
          accountId: account.id,
          type: "bank",
          name: account.name,
          iban: "DE12500105170648489890",
          bic: null,
          currency: "EUR",
          holder: null,
          platform: null,
        }),
      ).rejects.toMatchObject({ code: ACCOUNT_ERROR.ibanLockedByImports });
      expect(accountState[0]?.iban).toBe("DE89370400440532013000");
    });

    it("blocks clearing the IBAN to null once the account has at least one import batch", async () => {
      const account = accountRow({ workspaceId: "w1", iban: "DE89370400440532013000" });
      const { useCases, accountState, importBatchState } = setup();
      accountState.push(account);
      importBatchState.push(importBatchRow({ workspaceId: "w1", accountId: account.id }));

      await expect(
        useCases.updateAccount({
          workspaceId: "w1",
          accountId: account.id,
          type: "bank",
          name: account.name,
          iban: null,
          bic: null,
          currency: "EUR",
          holder: null,
          platform: null,
        }),
      ).rejects.toMatchObject({ code: ACCOUNT_ERROR.ibanLockedByImports });
    });

    it("allows an IBAN change when the account has no import batches yet", async () => {
      const account = accountRow({ workspaceId: "w1", iban: "DE89370400440532013000" });
      const { useCases, accountState } = setup();
      accountState.push(account);

      const updated = await useCases.updateAccount({
        workspaceId: "w1",
        accountId: account.id,
        type: "bank",
        name: account.name,
        iban: "DE12500105170648489890",
        bic: null,
        currency: "EUR",
        holder: null,
        platform: null,
      });

      expect(updated.iban).toBe("DE12500105170648489890");
    });

    it("allows a non-IBAN edit (name) even when the account has import batches", async () => {
      const account = accountRow({ workspaceId: "w1", iban: "DE89370400440532013000", name: "Altes Konto" });
      const { useCases, accountState, importBatchState } = setup();
      accountState.push(account);
      importBatchState.push(importBatchRow({ workspaceId: "w1", accountId: account.id }));

      const updated = await useCases.updateAccount({
        workspaceId: "w1",
        accountId: account.id,
        type: "bank",
        name: "Neuer Name",
        iban: account.iban,
        bic: null,
        currency: "EUR",
        holder: null,
        platform: null,
      });

      expect(updated.name).toBe("Neuer Name");
      expect(updated.iban).toBe("DE89370400440532013000");
    });

    it("still rejects a duplicate IBAN belonging to another account (unaffected by the new lock check)", async () => {
      const account = accountRow({ workspaceId: "w1", iban: "DE89370400440532013000" });
      const other = accountRow({ workspaceId: "w1", iban: "DE12500105170648489890" });
      const { useCases, accountState } = setup();
      accountState.push(account, other);

      await expect(
        useCases.updateAccount({
          workspaceId: "w1",
          accountId: account.id,
          type: "bank",
          name: account.name,
          iban: "DE12500105170648489890",
          bic: null,
          currency: "EUR",
          holder: null,
          platform: null,
        }),
      ).rejects.toMatchObject({ code: ACCOUNT_ERROR.duplicateIban });
    });

    it("rejects an account that does not exist", async () => {
      const { useCases } = setup();

      await expect(
        useCases.updateAccount({
          workspaceId: "w1",
          accountId: crypto.randomUUID(),
          type: "bank",
          name: "Ghost",
          iban: null,
          bic: null,
          currency: "EUR",
          holder: null,
          platform: null,
        }),
      ).rejects.toMatchObject({ code: ACCOUNT_ERROR.notFound });
    });
  });
});

// decisions/0050: Apple's and Google's reports carry no payout id, so the payout only becomes
// known when the bank credit is paired. Booking it out of the clearing account is what keeps that
// account's balance equal to what the platform still owes.
describe("recordPlatformPayout", () => {
  const WORKSPACE = "w1";

  function withClearingAccountAndCredit() {
    const s = setup();
    const clearing = accountRow({ workspaceId: WORKSPACE, type: "clearing", platform: "google", name: "Google (Verrechnungskonto)", currency: "EUR" });
    const bank = accountRow({ workspaceId: WORKSPACE, type: "bank", name: "Bank", currency: "EUR" });
    s.accountState.push(clearing, bank);
    const credit = transactionRow({ workspaceId: WORKSPACE, accountId: bank.id, idempotencyKey: "k1", amountCents: 14_160, bookingDate: "2025-05-14", counterpartyName: "Google Payment Ireland Limited" });
    s.transactionState.push(credit);
    return { s, clearing, credit };
  }

  it("books the payout out of the clearing account and ties it to the bank credit", async () => {
    const { s, clearing, credit } = withClearingAccountAndCredit();

    await s.useCases.recordPlatformPayout({ workspaceId: WORKSPACE, platform: "google", amountCents: 14_160, bookingDate: "2025-05-14", bankTransactionId: credit.id, reference: "GG100AB12CD" });

    const payout = s.transactionState.find((t) => t.accountId === clearing.id);
    expect(payout).toMatchObject({ amountCents: -14_160, creditDebit: "debit", bookingDate: "2025-05-14" });
    expect(payout?.transferGroupId).toBeTruthy();
    expect(s.transactionState.find((t) => t.id === credit.id)?.transferGroupId).toBe(payout?.transferGroupId);
  });

  it("books nothing a second time for the same bank credit", async () => {
    const { s, clearing, credit } = withClearingAccountAndCredit();
    const call = () => s.useCases.recordPlatformPayout({ workspaceId: WORKSPACE, platform: "google", amountCents: 14_160, bookingDate: "2025-05-14", bankTransactionId: credit.id, reference: null });

    await call();
    await call();

    expect(s.transactionState.filter((t) => t.accountId === clearing.id)).toHaveLength(1);
  });
});
