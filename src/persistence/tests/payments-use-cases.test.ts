// Unit tests for createPaymentsUseCases (WEBAPP_TEMPLATE_SPEC.md §10.2): typed fakes via
// dependency injection, no DB, no vi.mock. Covers `runMatching`'s orchestration (the
// auto-confirm path, the suggestion path, the alias filter, the rejection filter, the AI
// stage's cache-key reuse) and the decision actions.
import { describe, expect, it } from "vitest";

import { normalizeName } from "@/modules/contacts";
import { buildTabularConfirmedIntakeResult } from "@/modules/documents";
import { aliasKeyForCounterparty, createFakePaymentArbiter, type PaymentArbiter, type PaymentArbiterInput, type PaymentArbiterRawResult } from "@/modules/payments";
import { accountRow, createFakeAccountRepository, createFakeTransactionRepository, transactionRow } from "@/persistence/tests/support/fake-accounts-repositories";
import { contactRow, createFakeContactRepository, createFakeDocumentContactRepository } from "@/persistence/tests/support/fake-contacts-repositories";
import { createFakeDocumentRepository, documentRow } from "@/persistence/tests/support/fake-documents-repositories";
import {
  createFakeDocumentTransactionRepository,
  createFakePaymentAliasRepository,
  createFakePaymentArbiterAnswerRepository,
  createFakePaymentNoDocumentRuleRepository,
  createFakePaymentRejectionRepository,
  isConfirmedPredicate,
} from "@/persistence/tests/support/fake-payments-repositories";
import { createFakeJobsRepository, jobRow } from "@/persistence/tests/support/fake-jobs-repository";
import { withUnusedRepositories } from "@/persistence/tests/support/unused-repositories";
import { createFakeWorkspaceRepository, workspaceRow } from "@/persistence/tests/support/fake-workspaces-repositories";
import type { PaymentAutoConfirmMode } from "@/modules/payments";
import type { Repositories, UnitOfWork } from "@/persistence/repositories/contracts";
import { createPaymentsUseCases, PAYMENT_ERROR } from "@/persistence/use-cases/payments-use-cases";
import { UseCaseError } from "@/persistence/use-cases/errors";

const WORKSPACE = "w1";

function setup(options: { arbiter?: PaymentArbiter; now?: Date; autoConfirm?: PaymentAutoConfirmMode; accounts?: ReturnType<typeof accountRow>[] } = {}) {
  // decisions/0044: the matching run reads the workspace's auto-confirm mode.
  const { repo: workspace } = createFakeWorkspaceRepository([workspaceRow({ id: WORKSPACE, name: "Test", paymentAutoConfirm: options.autoConfirm ?? "system" })]);
  const { repo: document, state: documentState } = createFakeDocumentRepository();
  const { repo: contact, state: contactState } = createFakeContactRepository();
  const { repo: documentContact, state: documentContactState } = createFakeDocumentContactRepository();
  const { repo: documentTransaction, state: documentTransactionState } = createFakeDocumentTransactionRepository();
  const { repo: transaction, state: transactionState } = createFakeTransactionRepository([], { isConfirmed: isConfirmedPredicate(documentTransactionState) });
  const { repo: paymentAlias, state: paymentAliasState } = createFakePaymentAliasRepository();
  const { repo: paymentRejection, state: paymentRejectionState } = createFakePaymentRejectionRepository();
  const { repo: paymentNoDocumentRule } = createFakePaymentNoDocumentRuleRepository();
  const { repo: paymentArbiterAnswer, state: paymentArbiterAnswerState } = createFakePaymentArbiterAnswerRepository();
  const { repo: jobs, state: jobState } = createFakeJobsRepository();
  // decisions/0068-supplier-clearing-accounts.md: every matching run asks which contacts are
  // settled through a clearing account of their own, so this repository is no longer optional
  // for `runMatching`.
  const { repo: account, state: accountState } = createFakeAccountRepository(options.accounts ?? []);

  const repos: Repositories = withUnusedRepositories({
    account,
    workspace,
    document,
    contact,
    documentContact,
    documentTransaction,
    transaction,
    paymentAlias,
    paymentRejection,
    paymentNoDocumentRule,
    paymentArbiterAnswer,
    jobs,
  });
  const uow: UnitOfWork = { transaction: (work) => work(repos) };

  const useCases = createPaymentsUseCases({
    repos,
    uow,
    paymentArbiter: options.arbiter ?? createFakePaymentArbiter(),
    now: options.now ? () => options.now! : undefined,
  });

  return {
    useCases,
    accountState,
    documentState,
    contactState,
    documentContactState,
    documentTransactionState,
    transactionState,
    paymentAliasState,
    paymentRejectionState,
    paymentArbiterAnswerState,
    jobState,
  };
}

function linkContact(setupResult: ReturnType<typeof setup>, documentId: string, contact: ReturnType<typeof contactRow>, role: "sender" | "recipient") {
  setupResult.contactState.push(contact);
  setupResult.documentContactState.push({ documentId, contactId: contact.id, role, createdAt: new Date(0) });
}

describe("createPaymentsUseCases.runMatching", () => {
  it("auto-confirms an exact amount match whose invoice number is in the remittance text", async () => {
    const s = setup();
    const doc = documentRow({
      workspaceId: WORKSPACE,
      storageKey: "workspaces/w1/documents/d1/original.pdf",
      direction: "incoming",
      invoiceNumber: "RE-2026-001",
      totalAmountCents: 5000,
      paymentStatus: "open",
    });
    s.documentState.push(doc);
    const tx = transactionRow({ workspaceId: WORKSPACE, accountId: "a1", idempotencyKey: "k1", amountCents: -5000, remittanceText: "Zahlung RE-2026-001" });
    s.transactionState.push(tx);

    const result = await s.useCases.runMatching({ workspaceId: WORKSPACE, trigger: "document_done" });

    expect(result.autoConfirmed).toBe(1);
    expect(s.documentTransactionState).toHaveLength(1);
    expect(s.documentTransactionState[0]).toMatchObject({ status: "confirmed", kind: "exact", matchedBy: "auto", allocatedAmountCents: 5000 });
    expect(s.documentState[0]?.paymentStatus).toBe("paid");
    expect(s.documentState[0]?.paidAt).not.toBeNull();
  });

  it("produces a suggestion (never auto-confirmed) when the amount matches but no invoice number is found", async () => {
    const s = setup({ autoConfirm: "none" });
    const doc = documentRow({
      workspaceId: WORKSPACE,
      storageKey: "workspaces/w1/documents/d1/original.pdf",
      direction: "incoming",
      invoiceNumber: "RE-2026-002",
      totalAmountCents: 3000,
      paymentStatus: "open",
    });
    s.documentState.push(doc);
    const contact = contactRow({ workspaceId: WORKSPACE, name: "Beispiel GmbH", nameNormalized: normalizeName("Beispiel GmbH"), source: "manual" });
    linkContact(s, doc.id, contact, "sender");
    const tx = transactionRow({ workspaceId: WORKSPACE, accountId: "a1", idempotencyKey: "k1", amountCents: -3000, counterpartyName: "Beispiel GmbH", remittanceText: "Überweisung" });
    s.transactionState.push(tx);

    const result = await s.useCases.runMatching({ workspaceId: WORKSPACE, trigger: "document_done" });

    expect(result.autoConfirmed).toBe(0);
    expect(s.documentTransactionState).toHaveLength(1);
    expect(s.documentTransactionState[0]).toMatchObject({ status: "suggested", kind: "exact" });
    expect(s.documentState[0]?.paymentStatus).toBe("open"); // never recomputed until a human decides
  });

  // decisions/0044: the admin's auto-confirm mode decides what the same unambiguous match does.
  it.each([
    { mode: "system" as const, expected: "confirmed", paymentStatus: "paid" },
    { mode: "all" as const, expected: "confirmed", paymentStatus: "paid" },
    { mode: "none" as const, expected: "suggested", paymentStatus: "open" },
  ])("an unambiguous rules match is $expected in mode $mode", async ({ mode, expected, paymentStatus }) => {
    const s = setup({ autoConfirm: mode });
    const doc = documentRow({ workspaceId: WORKSPACE, storageKey: "workspaces/w1/documents/d1/original.pdf", direction: "incoming", invoiceNumber: "RE-2026-002", totalAmountCents: 3000, paymentStatus: "open" });
    s.documentState.push(doc);
    linkContact(s, doc.id, contactRow({ workspaceId: WORKSPACE, name: "Beispiel GmbH", nameNormalized: normalizeName("Beispiel GmbH"), source: "manual" }), "sender");
    s.transactionState.push(transactionRow({ workspaceId: WORKSPACE, accountId: "a1", idempotencyKey: "k1", amountCents: -3000, counterpartyName: "Beispiel GmbH", remittanceText: "Überweisung" }));

    await s.useCases.runMatching({ workspaceId: WORKSPACE, trigger: "document_done" });

    expect(s.documentTransactionState).toHaveLength(1);
    expect(s.documentTransactionState[0]).toMatchObject({ status: expected, kind: "exact" });
    expect(s.documentState[0]?.paymentStatus).toBe(paymentStatus);
  });

  it("applies a learned alias to corroborate a name the bank statement spells differently", async () => {
    const s = setup({ autoConfirm: "none" });
    const doc = documentRow({
      workspaceId: WORKSPACE,
      storageKey: "workspaces/w1/documents/d1/original.pdf",
      direction: "incoming",
      invoiceNumber: "RE-2026-003",
      totalAmountCents: 4200,
      paymentStatus: "open",
    });
    s.documentState.push(doc);
    const contact = contactRow({ workspaceId: WORKSPACE, name: "Beispiel GmbH", nameNormalized: normalizeName("Beispiel GmbH"), source: "manual" });
    linkContact(s, doc.id, contact, "sender");
    s.paymentAliasState.push({ id: crypto.randomUUID(), workspaceId: WORKSPACE, counterpartyNameNormalized: normalizeName("BSP GMBH TRADING"), contactId: contact.id, learnedFromUserId: null, createdAt: new Date(0) });
    const tx = transactionRow({ workspaceId: WORKSPACE, accountId: "a1", idempotencyKey: "k1", amountCents: -4200, counterpartyName: "BSP GMBH TRADING", remittanceText: "Überweisung" });
    s.transactionState.push(tx);

    await s.useCases.runMatching({ workspaceId: WORKSPACE, trigger: "document_done" });

    expect(s.documentTransactionState).toHaveLength(1);
    expect(s.documentTransactionState[0]).toMatchObject({ status: "suggested", kind: "exact" });
    expect((s.documentTransactionState[0]!.reasons as string[]).includes("alias_learned")).toBe(true);
  });

  it("never re-suggests a pairing a human already rejected", async () => {
    const s = setup();
    const doc = documentRow({
      workspaceId: WORKSPACE,
      storageKey: "workspaces/w1/documents/d1/original.pdf",
      direction: "incoming",
      invoiceNumber: "RE-2026-004",
      totalAmountCents: 1000,
      paymentStatus: "open",
    });
    s.documentState.push(doc);
    const tx = transactionRow({ workspaceId: WORKSPACE, accountId: "a1", idempotencyKey: "k1", amountCents: -1000, remittanceText: "Zahlung RE-2026-004" });
    s.transactionState.push(tx);
    s.paymentRejectionState.push({ id: crypto.randomUUID(), workspaceId: WORKSPACE, documentId: doc.id, transactionId: tx.id, rejectedBy: null, createdAt: new Date(0) });

    const result = await s.useCases.runMatching({ workspaceId: WORKSPACE, trigger: "document_done" });

    expect(result.autoConfirmed).toBe(0);
    expect(s.documentTransactionState).toHaveLength(0);
  });

  // decisions/0068-supplier-clearing-accounts.md: the point of the feature, in both
  // directions. Modelled on the real Meta data: two 2,00 EUR invoices, one 2,00 EUR card
  // debit whose merchant name is a learned payment name of the same contact - exactly the
  // constellation that produced the wrong suggestions the owner rejected by hand.
  it("proposes nothing for a contact settled through its own clearing account, in either direction", async () => {
    const meta = contactRow({ workspaceId: WORKSPACE, name: "Meta Platforms Ireland Limited", nameNormalized: normalizeName("Meta Platforms Ireland Limited"), source: "auto" });
    const s = setup({ accounts: [accountRow({ workspaceId: WORKSPACE, type: "clearing", name: "Meta (Verrechnungskonto)", contactId: meta.id })] });

    const metaInvoice = documentRow({
      workspaceId: WORKSPACE,
      storageKey: "workspaces/w1/documents/d1/original.pdf",
      direction: "incoming",
      invoiceNumber: "FBADS-101-200000003",
      totalAmountCents: 200,
      paymentStatus: "open",
    });
    s.documentState.push(metaInvoice);
    linkContact(s, metaInvoice.id, meta, "sender");

    // A second supplier's invoice of the SAME amount: the Meta charge must not be offered for
    // it either, and this invoice must still be matchable by its own payment.
    const other = contactRow({ workspaceId: WORKSPACE, name: "IONOS SE", nameNormalized: normalizeName("IONOS SE"), source: "auto" });
    const otherInvoice = documentRow({
      workspaceId: WORKSPACE,
      storageKey: "workspaces/w1/documents/d2/original.pdf",
      direction: "incoming",
      invoiceNumber: "RE-2026-010",
      totalAmountCents: 200,
      paymentStatus: "open",
    });
    s.documentState.push(otherInvoice);
    linkContact(s, otherInvoice.id, other, "sender");

    const metaCharge = transactionRow({
      workspaceId: WORKSPACE,
      accountId: "a1",
      idempotencyKey: "k-meta",
      amountCents: -200,
      counterpartyName: "FACEBK *QX7MNP41KD,fb.me/ads",
      remittanceText: "FACEBK *QX7MNP41KD,fb.me/ads",
    });
    s.transactionState.push(metaCharge);
    s.paymentAliasState.push({
      id: crypto.randomUUID(),
      workspaceId: WORKSPACE,
      counterpartyNameNormalized: aliasKeyForCounterparty("FACEBK"),
      contactId: meta.id,
      learnedFromUserId: null,
      createdAt: new Date(0),
    });

    const result = await s.useCases.runMatching({ workspaceId: WORKSPACE, trigger: "document_done" });

    expect(result.suggestionsCreated).toBe(0);
    expect(result.autoConfirmed).toBe(0);
    expect(s.documentTransactionState).toHaveLength(0);
  });

  it("caches an AI-stage answer and never calls the arbiter twice for the same (transaction, candidate set) pairing", async () => {
    let calls = 0;
    const fakeArbiter: PaymentArbiter = {
      version: "test:1",
      async rank(input: PaymentArbiterInput): Promise<PaymentArbiterRawResult> {
        calls++;
        const first = input.candidates[0];
        return { bestDocumentId: first?.id ?? null, confidence: 0.7, reason: "Der Betrag und das Datum passen gut zusammen." };
      },
    };
    const s = setup({ arbiter: fakeArbiter });
    const doc = documentRow({
      workspaceId: WORKSPACE,
      storageKey: "workspaces/w1/documents/d1/original.pdf",
      direction: "incoming",
      invoiceNumber: "RE-2026-005",
      totalAmountCents: 7500,
      paymentStatus: "open",
    });
    s.documentState.push(doc);
    // Exact amount but no invoice number, iban or name: stages 1/2 never suggest from an amount
    // alone, so stage 3 runs, and the exact amount is the hard evidence decisions/0039's gate
    // requires for the arbiter's pick to survive.
    const tx = transactionRow({ workspaceId: WORKSPACE, accountId: "a1", idempotencyKey: "k1", amountCents: -7500, remittanceText: "Danke" });
    s.transactionState.push(tx);

    const first = await s.useCases.runMatching({ workspaceId: WORKSPACE, trigger: "document_done" });
    const second = await s.useCases.runMatching({ workspaceId: WORKSPACE, trigger: "cron" });

    expect(first.aiCalls).toBe(1);
    expect(second.aiCalls).toBe(0); // identical candidate set - the cached suggestion is reused
    expect(calls).toBe(1);
    expect(s.documentTransactionState.filter((r) => r.kind === "ai")).toHaveLength(1);
  });

  describe("the arbiter answer cache (decisions/0077-arbiter-answer-cache.md)", () => {
    /** Counts calls; answers with `answer(input)` (default: "no match"). */
    function countingArbiter(answer: (input: PaymentArbiterInput) => PaymentArbiterRawResult = () => ({ bestDocumentId: null, confidence: 0, reason: "Keine passt." }), version = "test:1") {
      const calls: PaymentArbiterInput[] = [];
      const arbiter: PaymentArbiter = {
        version,
        async rank(input) {
          calls.push(input);
          return answer(input);
        },
      };
      return { arbiter, calls };
    }

    function openInvoice(id: string, totalAmountCents: number) {
      return documentRow({
        id,
        workspaceId: WORKSPACE,
        storageKey: `workspaces/w1/documents/${id}/original.pdf`,
        direction: "incoming",
        invoiceNumber: `RE-${id}`,
        totalAmountCents,
        paymentStatus: "open",
      });
    }

    // A debit no stage 1/2 rule explains (no signal, amount far off), so stage 3 is asked.
    function unexplainedDebit(id: string) {
      return transactionRow({ id, workspaceId: WORKSPACE, accountId: "a1", idempotencyKey: id, amountCents: -1_000, remittanceText: "Lastschrift", counterpartyName: "Unbekannt" });
    }

    it("asks once and never again while the question is unchanged, also when the answer was no match", async () => {
      const { arbiter, calls } = countingArbiter();
      const s = setup({ arbiter, autoConfirm: "none" });
      s.documentState.push(openInvoice("d1", 50_000));
      s.transactionState.push(unexplainedDebit("t1"), unexplainedDebit("t2"));

      const first = await s.useCases.runMatching({ workspaceId: WORKSPACE, trigger: "document_done" });
      const second = await s.useCases.runMatching({ workspaceId: WORKSPACE, trigger: "import_batch" });
      // decisions/0039's six-hour follow-up is an ordinary run with `trigger: "cron"`.
      const followUp = await s.useCases.runMatching({ workspaceId: WORKSPACE, trigger: "cron" });

      expect(first.aiCalls).toBe(2);
      expect(second.aiCalls).toBe(0);
      expect(followUp.aiCalls).toBe(0);
      expect(calls).toHaveLength(2);
      expect(s.paymentArbiterAnswerState).toHaveLength(2);
      expect(s.paymentArbiterAnswerState[0]).toMatchObject({ workspaceId: WORKSPACE, bestDocumentId: null });
      expect(s.documentTransactionState).toHaveLength(0);
    });

    it("asks again, once, only for the transaction whose candidate set gained a document", async () => {
      const { arbiter, calls } = countingArbiter();
      const s = setup({ arbiter, autoConfirm: "none" });
      s.documentState.push(openInvoice("d1", 50_000));
      s.transactionState.push(unexplainedDebit("t1"));
      // An incoming payment: an incoming invoice is never its candidate, so it is not affected.
      s.transactionState.push(transactionRow({ id: "t-credit", workspaceId: WORKSPACE, accountId: "a1", idempotencyKey: "t-credit", amountCents: 2_000, remittanceText: "Gutschrift" }));
      s.documentState.push(documentRow({ id: "d-out", workspaceId: WORKSPACE, storageKey: "workspaces/w1/documents/d-out/original.pdf", direction: "outgoing", invoiceNumber: "AR-1", totalAmountCents: 90_000, paymentStatus: "open" }));

      expect((await s.useCases.runMatching({ workspaceId: WORKSPACE, trigger: "document_done" })).aiCalls).toBe(2);

      s.documentState.push(openInvoice("d2", 30_000));
      const afterNewDocument = await s.useCases.runMatching({ workspaceId: WORKSPACE, trigger: "document_done" });

      expect(afterNewDocument.aiCalls).toBe(1);
      expect(calls).toHaveLength(3);
      expect(calls[2]!.transaction.id).toBe("t1");
      expect(calls[2]!.candidates.map((c) => c.id).sort()).toEqual(["d1", "d2"]);
      // One row per transaction: the new answer replaced the old one.
      expect(s.paymentArbiterAnswerState.filter((r) => r.transactionId === "t1")).toHaveLength(1);
      expect((await s.useCases.runMatching({ workspaceId: WORKSPACE, trigger: "cron" })).aiCalls).toBe(0);
    });

    it("asks again when a candidate's fields change (a re-extracted amount)", async () => {
      const { arbiter } = countingArbiter();
      const s = setup({ arbiter, autoConfirm: "none" });
      s.documentState.push(openInvoice("d1", 50_000));
      s.transactionState.push(unexplainedDebit("t1"));
      await s.useCases.runMatching({ workspaceId: WORKSPACE, trigger: "document_done" });

      s.documentState[0]!.totalAmountCents = 40_000;
      expect((await s.useCases.runMatching({ workspaceId: WORKSPACE, trigger: "document_done" })).aiCalls).toBe(1);
    });

    it("asks again when the arbiter's model or prompt version changes", async () => {
      const s = setup({ arbiter: countingArbiter().arbiter, autoConfirm: "none" });
      s.documentState.push(openInvoice("d1", 50_000));
      s.transactionState.push(unexplainedDebit("t1"));
      await s.useCases.runMatching({ workspaceId: WORKSPACE, trigger: "document_done" });

      // The same stored answers, read by use cases bound to a newer arbiter.
      const { arbiter: newer, calls } = countingArbiter(undefined, "test:2");
      const s2 = setup({ arbiter: newer, autoConfirm: "none" });
      s2.documentState.push(...s.documentState);
      s2.transactionState.push(...s.transactionState);
      s2.paymentArbiterAnswerState.push(...s.paymentArbiterAnswerState);
      expect((await s2.useCases.runMatching({ workspaceId: WORKSPACE, trigger: "cron" })).aiCalls).toBe(1);
      expect(calls).toHaveLength(1);
    });

    it("keeps a pick that fails the code checks, and re-validates it without asking", async () => {
      // The arbiter picks the only candidate, but the amount is far off and nothing else links
      // them: decisions/0039's hard-evidence gate discards it, now and on every reuse.
      const { arbiter, calls } = countingArbiter((input) => ({ bestDocumentId: input.candidates[0]!.id, confidence: 0.9, reason: "Vielleicht." }));
      const s = setup({ arbiter, autoConfirm: "none" });
      s.documentState.push(openInvoice("d1", 50_000));
      s.transactionState.push(unexplainedDebit("t1"));

      await s.useCases.runMatching({ workspaceId: WORKSPACE, trigger: "document_done" });
      await s.useCases.runMatching({ workspaceId: WORKSPACE, trigger: "cron" });

      expect(calls).toHaveLength(1);
      expect(s.paymentArbiterAnswerState[0]).toMatchObject({ bestDocumentId: "d1", confidence: 0.9 });
      expect(s.documentTransactionState).toHaveLength(0);
    });

    it("rebuilds a removed AI suggestion from the stored answer instead of asking again", async () => {
      const { arbiter, calls } = countingArbiter((input) => ({ bestDocumentId: input.candidates[0]!.id, confidence: 0.7, reason: "Betrag passt." }));
      const s = setup({ arbiter, autoConfirm: "none" });
      s.documentState.push(openInvoice("d1", 7_500));
      s.transactionState.push(transactionRow({ id: "t1", workspaceId: WORKSPACE, accountId: "a1", idempotencyKey: "t1", amountCents: -7_500, remittanceText: "Danke" }));

      await s.useCases.runMatching({ workspaceId: WORKSPACE, trigger: "document_done" });
      expect(s.documentTransactionState.filter((r) => r.kind === "ai")).toHaveLength(1);
      s.documentTransactionState.splice(0); // e.g. withdrawn by a later rule (decisions/0045)

      const again = await s.useCases.runMatching({ workspaceId: WORKSPACE, trigger: "cron" });
      expect(again.aiCalls).toBe(0);
      expect(calls).toHaveLength(1);
      expect(s.documentTransactionState.filter((r) => r.kind === "ai")).toHaveLength(1);
    });

    it("does not store anything when the arbiter fails, so the retry asks again", async () => {
      let fail = true;
      const arbiter: PaymentArbiter = {
        version: "test:1",
        async rank() {
          if (fail) throw new Error("rate limited");
          return { bestDocumentId: null, confidence: 0, reason: "Keine passt." };
        },
      };
      const s = setup({ arbiter, autoConfirm: "none" });
      s.documentState.push(openInvoice("d1", 50_000));
      s.transactionState.push(unexplainedDebit("t1"));

      await expect(s.useCases.runMatching({ workspaceId: WORKSPACE, trigger: "document_done" })).rejects.toThrow("rate limited");
      expect(s.paymentArbiterAnswerState).toHaveLength(0);
      fail = false;
      expect((await s.useCases.runMatching({ workspaceId: WORKSPACE, trigger: "document_done" })).aiCalls).toBe(1);
    });
  });

  // decisions/0033-contradicting-invoice-number-vetoes-a-match.md: the exact observed
  // production case. Outgoing invoice 12 (480,00 EUR) is correctly auto-confirmed against its
  // own transaction ("Re.Nr. 12 vom 02.07.25 Beratung und Hosting"). A second, unrelated transaction
  // ("Re Nr. 15", 905,00 EUR) must never be suggested for the same document, even though it
  // is the only document in the workspace and the fake arbiter would otherwise be free to pick
  // it (no dueDate/documentDate on the document at all, so it is never excluded by the
  // candidate date window either).
  it("produces no suggestion for a transaction whose remittance text contradicts the only candidate's invoice number, while still auto-confirming the correct one", async () => {
    const s = setup();
    const doc = documentRow({
      workspaceId: WORKSPACE,
      storageKey: "workspaces/w1/documents/d1/original.pdf",
      direction: "outgoing",
      invoiceNumber: "12",
      totalAmountCents: 48_000,
      paymentStatus: "open",
    });
    s.documentState.push(doc);

    // The bogus transaction is evaluated first, while document 12 is still fully open - if the
    // veto did not exist, this is exactly the shape of the observed defect (the AI stage would
    // be the only one left to ask, since stage 1/2 also find nothing else to go on).
    const bogusTx = transactionRow({
      workspaceId: WORKSPACE,
      accountId: "a1",
      idempotencyKey: "k-bogus",
      amountCents: 90_500,
      counterpartyName: "BAUWERK GENERALBAU MUNCHEN, GMBH",
      remittanceText: "Re Nr. 15",
      bookingDate: "2025-11-14",
    });
    s.transactionState.push(bogusTx);

    const bogusResult = await s.useCases.runMatching({ workspaceId: WORKSPACE, trigger: "document_done" });

    expect(bogusResult.suggestionsCreated).toBe(0);
    expect(bogusResult.autoConfirmed).toBe(0);
    expect(s.documentTransactionState).toHaveLength(0);
    expect(s.documentState[0]?.paymentStatus).toBe("open");

    // The real transaction now arrives and still auto-confirms exactly as decisions/0031 left it.
    const realTx = transactionRow({
      workspaceId: WORKSPACE,
      accountId: "a1",
      idempotencyKey: "k-real",
      amountCents: 48_000,
      remittanceText: "Re.Nr. 12 vom 02.07.25 Beratung und Hosting",
      bookingDate: "2025-07-02",
    });
    s.transactionState.push(realTx);

    const realResult = await s.useCases.runMatching({ workspaceId: WORKSPACE, trigger: "cron" });

    expect(realResult.autoConfirmed).toBe(1);
    expect(s.documentTransactionState).toHaveLength(1);
    expect(s.documentTransactionState[0]).toMatchObject({ status: "confirmed", kind: "exact", matchedBy: "auto", transactionId: realTx.id });
    expect(s.documentState[0]?.paymentStatus).toBe("paid");
  });

  it("schedules a follow-up match-payments job while an unresolved suggestion remains", async () => {
    const s = setup({ autoConfirm: "none" });
    const doc = documentRow({
      workspaceId: WORKSPACE,
      storageKey: "workspaces/w1/documents/d1/original.pdf",
      direction: "incoming",
      invoiceNumber: "RE-2026-006",
      totalAmountCents: 2000,
      paymentStatus: "open",
    });
    s.documentState.push(doc);
    const contact = contactRow({ workspaceId: WORKSPACE, name: "Beispiel GmbH", nameNormalized: normalizeName("Beispiel GmbH"), source: "manual" });
    linkContact(s, doc.id, contact, "sender");
    const tx = transactionRow({ workspaceId: WORKSPACE, accountId: "a1", idempotencyKey: "k1", amountCents: -2000, counterpartyName: "Beispiel GmbH" });
    s.transactionState.push(tx);

    await s.useCases.runMatching({ workspaceId: WORKSPACE, trigger: "document_done" });

    const followUps = s.jobState.filter((j) => j.kind === "match-payments");
    expect(followUps).toHaveLength(1);
    expect(followUps[0]?.payload).toMatchObject({ trigger: "cron" });
  });

  it("queues no follow-up while an immediate run is already queued: that run schedules its own (decisions/0076)", async () => {
    const now = new Date("2026-03-15T12:00:00.000Z");
    const s = setup({ autoConfirm: "none", now });
    s.transactionState.push(transactionRow({ workspaceId: WORKSPACE, accountId: "a1", idempotencyKey: "k1", amountCents: -2000, counterpartyName: "Gehalt" }));
    // A document finished while this run was going: its run is queued, due now, not leased.
    s.jobState.push(jobRow({ kind: "match-payments", workspaceId: WORKSPACE, payload: { workspaceId: WORKSPACE, trigger: "document_done" }, runAt: now }));

    await s.useCases.runMatching({ workspaceId: WORKSPACE, trigger: "document_done" });

    const matchJobs = s.jobState.filter((j) => j.kind === "match-payments");
    expect(matchJobs).toHaveLength(1);
    expect(matchJobs[0]?.runAt).toEqual(now);
  });

  it("scheduleMatching pulls a queued six-hour follow-up forward to now instead of adding a second run (decisions/0076)", async () => {
    const now = new Date("2026-03-15T12:00:00.000Z");
    const s = setup({ now });
    s.jobState.push(jobRow({ kind: "match-payments", workspaceId: WORKSPACE, payload: { workspaceId: WORKSPACE, trigger: "cron" }, runAt: new Date(now.getTime() + 6 * 3_600_000) }));

    await s.useCases.scheduleMatching({ workspaceId: WORKSPACE });

    const matchJobs = s.jobState.filter((j) => j.kind === "match-payments");
    expect(matchJobs).toHaveLength(1);
    expect(matchJobs[0]?.runAt).toEqual(now);
  });
});

describe("createPaymentsUseCases decisions", () => {
  it("confirming a suggestion recomputes the document's payment status and learns an alias", async () => {
    const s = setup();
    const doc = documentRow({ workspaceId: WORKSPACE, storageKey: "x", direction: "incoming", totalAmountCents: 1000, paymentStatus: "open" });
    s.documentState.push(doc);
    const contact = contactRow({ workspaceId: WORKSPACE, name: "Beispiel GmbH", nameNormalized: normalizeName("Beispiel GmbH"), source: "manual" });
    linkContact(s, doc.id, contact, "sender");
    const tx = transactionRow({ workspaceId: WORKSPACE, accountId: "a1", idempotencyKey: "k1", amountCents: -1000, counterpartyName: "PRIVAT MUSTERMANN" }); // decisions/0047: a name that differs from the contact's
    s.transactionState.push(tx);

    // Seed a suggested row directly (bypassing `runMatching`, since this test is about the decision action itself).
    s.documentTransactionState.push({
      id: "dt1",
      workspaceId: WORKSPACE,
      documentId: doc.id,
      transactionId: tx.id,
      status: "suggested",
      kind: "exact",
      confidence: 0.8,
      reasons: ["amount_exact"],
      explanation: null,
      matchedBy: "auto",
      allocatedAmountCents: 1000,
      arbiterCacheKey: null,
      createdAt: new Date(0),
      decidedAt: null,
      decidedByUserId: null,
    });

    await s.useCases.confirmSuggestion({ workspaceId: WORKSPACE, documentTransactionId: "dt1", actingUserId: "u1" });

    expect(s.documentTransactionState[0]).toMatchObject({ status: "confirmed", matchedBy: "user", decidedByUserId: "u1" });
    expect(s.documentState[0]?.paymentStatus).toBe("paid");
    expect(s.paymentAliasState).toHaveLength(1);
    expect(s.paymentAliasState[0]).toMatchObject({ contactId: contact.id, counterpartyNameNormalized: "privat mustermann" });
  });

  // decisions/0047: nothing to learn when the payment already carries the contact's own name, and a
  // card debit is remembered by its stable merchant part, not the per-payment reference.
  it.each([
    { counterpartyName: "Beispiel GmbH", learned: null },
    { counterpartyName: "FACEBK *AB12CD34EF,fb.me/ads", learned: "facebk" },
  ])("learns $learned from a payment by $counterpartyName", async ({ counterpartyName, learned }) => {
    const s = setup();
    const doc = documentRow({ workspaceId: WORKSPACE, storageKey: "x", direction: "incoming", totalAmountCents: 1000, paymentStatus: "open" });
    s.documentState.push(doc);
    linkContact(s, doc.id, contactRow({ workspaceId: WORKSPACE, name: "Beispiel GmbH", nameNormalized: normalizeName("Beispiel GmbH"), source: "manual" }), "sender");
    const tx = transactionRow({ workspaceId: WORKSPACE, accountId: "a1", idempotencyKey: "k1", amountCents: -1000, counterpartyName });
    s.transactionState.push(tx);
    s.documentTransactionState.push({ id: "dt1", workspaceId: WORKSPACE, documentId: doc.id, transactionId: tx.id, status: "suggested", kind: "exact", confidence: 0.8, reasons: ["amount_exact"], explanation: null, matchedBy: "auto", allocatedAmountCents: 1000, arbiterCacheKey: null, createdAt: new Date(0), decidedAt: null, decidedByUserId: null });

    await s.useCases.confirmSuggestion({ workspaceId: WORKSPACE, documentTransactionId: "dt1", actingUserId: "u1" });

    expect(s.paymentAliasState.map((a) => a.counterpartyNameNormalized)).toEqual(learned ? [learned] : []);
  });

  it("rejecting a suggestion writes a rejection and never touches the document's payment status", async () => {
    const s = setup();
    const doc = documentRow({ workspaceId: WORKSPACE, storageKey: "x", direction: "incoming", totalAmountCents: 1000, paymentStatus: "open" });
    s.documentState.push(doc);
    const tx = transactionRow({ workspaceId: WORKSPACE, accountId: "a1", idempotencyKey: "k1", amountCents: -1000 });
    s.transactionState.push(tx);
    s.documentTransactionState.push({
      id: "dt1",
      workspaceId: WORKSPACE,
      documentId: doc.id,
      transactionId: tx.id,
      status: "suggested",
      kind: "exact",
      confidence: 0.8,
      reasons: [],
      explanation: null,
      matchedBy: "auto",
      allocatedAmountCents: 1000,
      arbiterCacheKey: null,
      createdAt: new Date(0),
      decidedAt: null,
      decidedByUserId: null,
    });

    await s.useCases.rejectSuggestion({ workspaceId: WORKSPACE, documentTransactionId: "dt1", actingUserId: "u1" });

    expect(s.documentTransactionState[0]?.status).toBe("rejected");
    expect(s.paymentRejectionState).toHaveLength(1);
    expect(s.documentState[0]?.paymentStatus).toBe("open");
  });

  it("rejects confirming an already-decided row", async () => {
    const s = setup();
    s.documentTransactionState.push({
      id: "dt1",
      workspaceId: WORKSPACE,
      documentId: "doc1",
      transactionId: "tx1",
      status: "confirmed",
      kind: "exact",
      confidence: 0.8,
      reasons: [],
      explanation: null,
      matchedBy: "auto",
      allocatedAmountCents: 100,
      arbiterCacheKey: null,
      createdAt: new Date(0),
      decidedAt: new Date(0),
      decidedByUserId: null,
    });

    await expect(s.useCases.confirmSuggestion({ workspaceId: WORKSPACE, documentTransactionId: "dt1", actingUserId: "u1" })).rejects.toThrow(UseCaseError);
  });

  it("linkManually rejects a cross-direction pairing", async () => {
    const s = setup();
    const doc = documentRow({ workspaceId: WORKSPACE, storageKey: "x", direction: "incoming", totalAmountCents: 1000, paymentStatus: "open" });
    s.documentState.push(doc);
    const tx = transactionRow({ workspaceId: WORKSPACE, accountId: "a1", idempotencyKey: "k1", amountCents: 1000 }); // positive = money in, wrong direction for "incoming"
    s.transactionState.push(tx);

    try {
      await s.useCases.linkManually({ workspaceId: WORKSPACE, documentId: doc.id, transactionId: tx.id, actingUserId: "u1" });
      throw new Error("expected to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(UseCaseError);
      expect((err as UseCaseError).code).toBe(PAYMENT_ERROR.crossDirection);
    }
  });

  it("linkManually confirms the pairing and recomputes the document's payment status", async () => {
    const s = setup();
    const doc = documentRow({ workspaceId: WORKSPACE, storageKey: "x", direction: "incoming", totalAmountCents: 1000, paymentStatus: "open" });
    s.documentState.push(doc);
    const tx = transactionRow({ workspaceId: WORKSPACE, accountId: "a1", idempotencyKey: "k1", amountCents: -1000 });
    s.transactionState.push(tx);

    await s.useCases.linkManually({ workspaceId: WORKSPACE, documentId: doc.id, transactionId: tx.id, actingUserId: "u1" });

    expect(s.documentTransactionState[0]).toMatchObject({ status: "confirmed", kind: "manual", matchedBy: "user" });
    expect(s.documentState[0]?.paymentStatus).toBe("paid");
  });

  it("unlink removes a confirmed row and reopens the document", async () => {
    const s = setup();
    const doc = documentRow({ workspaceId: WORKSPACE, storageKey: "x", direction: "incoming", totalAmountCents: 1000, paymentStatus: "paid", paidAt: new Date(0) });
    s.documentState.push(doc);
    const tx = transactionRow({ workspaceId: WORKSPACE, accountId: "a1", idempotencyKey: "k1", amountCents: -1000 });
    s.transactionState.push(tx);
    s.documentTransactionState.push({
      id: "dt1",
      workspaceId: WORKSPACE,
      documentId: doc.id,
      transactionId: tx.id,
      status: "confirmed",
      kind: "manual",
      confidence: 1,
      reasons: [],
      explanation: null,
      matchedBy: "user",
      allocatedAmountCents: 1000,
      arbiterCacheKey: null,
      createdAt: new Date(0),
      decidedAt: new Date(0),
      decidedByUserId: "u1",
    });

    await s.useCases.unlink({ workspaceId: WORKSPACE, documentTransactionId: "dt1", actingUserId: "u1" });

    expect(s.documentTransactionState).toHaveLength(0);
    expect(s.documentState[0]?.paymentStatus).toBe("open");
  });

  it("markNoDocumentNeeded marks the given transactions, and 'für diese Gegenpartei immer' applies retroactively", async () => {
    const s = setup();
    const tx1 = transactionRow({ workspaceId: WORKSPACE, accountId: "a1", idempotencyKey: "k1", amountCents: -500, counterpartyName: "Interne Buchung" });
    const tx2 = transactionRow({ workspaceId: WORKSPACE, accountId: "a1", idempotencyKey: "k2", amountCents: -700, counterpartyName: "Interne Buchung" });
    s.transactionState.push(tx1, tx2);

    await s.useCases.markNoDocumentNeeded({ workspaceId: WORKSPACE, transactionIds: [tx1.id], forCounterparty: true, actingUserId: "u1" });

    expect(s.transactionState.find((t) => t.id === tx1.id)?.noDocumentNeeded).toBe(true);
    expect(s.transactionState.find((t) => t.id === tx2.id)?.noDocumentNeeded).toBe(true); // retroactively applied by the standing rule
  });

  it("markSettledWithoutPayment sets the document to no_document_needed", async () => {
    const s = setup();
    const doc = documentRow({ workspaceId: WORKSPACE, storageKey: "x", direction: "incoming", totalAmountCents: 1000, paymentStatus: "open" });
    s.documentState.push(doc);

    await s.useCases.markSettledWithoutPayment({ workspaceId: WORKSPACE, documentId: doc.id, actingUserId: "u1" });

    expect(s.documentState[0]?.paymentStatus).toBe("no_document_needed");
  });
});

// decisions/0048-app-store-reports.md: the owner's own actual goal - every Apple/Google credit
// on the bank account gets its report as the document that explains it. `runMatching` is the
// entry point a bank-statement import's own `match-payments` job actually calls.
// decisions/0025: the same 50,00 EUR debit was confirmed against two copies of one letter, so
// the transaction ended up allocated twice. Confirming or linking past the transaction's
// unallocated amount is now an error; the suggestion itself stays `suggested`.
describe("createPaymentsUseCases - a transaction is never allocated past its amount", () => {
  function suggestedRow(id: string, documentId: string, transactionId: string, allocatedAmountCents: number, kind: "exact" | "skonto" = "exact") {
    return {
      id,
      workspaceId: WORKSPACE,
      documentId,
      transactionId,
      status: "suggested" as const,
      kind,
      confidence: 0.8,
      reasons: ["amount_exact"],
      explanation: null,
      matchedBy: "auto" as const,
      allocatedAmountCents,
      arbiterCacheKey: null,
      createdAt: new Date(0),
      decidedAt: null,
      decidedByUserId: null,
    };
  }

  function twoCopiesOfOneLetter() {
    const s = setup();
    const first = documentRow({ workspaceId: WORKSPACE, storageKey: "a", direction: "incoming", totalAmountCents: 5000, paymentStatus: "open" });
    const copy = documentRow({ workspaceId: WORKSPACE, storageKey: "b", direction: "incoming", totalAmountCents: 5000, paymentStatus: "open" });
    s.documentState.push(first, copy);
    const tx = transactionRow({ workspaceId: WORKSPACE, accountId: "a1", idempotencyKey: "k1", amountCents: -5000, counterpartyName: "Stadt Beispielstadt" });
    s.transactionState.push(tx);
    s.documentTransactionState.push(suggestedRow("dt1", first.id, tx.id, 5000), suggestedRow("dt2", copy.id, tx.id, 5000));
    return { s, first, copy, tx };
  }

  it("refuses to confirm a second suggestion for an already fully allocated transaction, and leaves it suggested", async () => {
    const { s, copy } = twoCopiesOfOneLetter();
    await s.useCases.confirmSuggestion({ workspaceId: WORKSPACE, documentTransactionId: "dt1", actingUserId: "u1" });

    await expect(s.useCases.confirmSuggestion({ workspaceId: WORKSPACE, documentTransactionId: "dt2", actingUserId: "u1" })).rejects.toMatchObject({
      code: "amount_exceeds_transaction",
    });
    expect(s.documentTransactionState.find((r) => r.id === "dt2")?.status).toBe("suggested");
    expect(s.paymentRejectionState).toHaveLength(0);
    expect(s.documentState.find((d) => d.id === copy.id)?.paymentStatus).toBe("open");
  });

  it("refuses a manual link that claims more than the transaction has left", async () => {
    const { s, copy, tx } = twoCopiesOfOneLetter();
    await s.useCases.confirmSuggestion({ workspaceId: WORKSPACE, documentTransactionId: "dt1", actingUserId: "u1" });

    await expect(s.useCases.linkManually({ workspaceId: WORKSPACE, documentId: copy.id, transactionId: tx.id, actingUserId: "u1" })).rejects.toMatchObject({
      code: "amount_exceeds_transaction",
    });
  });

  it("still lets one transaction pay several documents up to its amount", async () => {
    const s = setup();
    const a = documentRow({ workspaceId: WORKSPACE, storageKey: "a", direction: "incoming", totalAmountCents: 1200, paymentStatus: "open" });
    const b = documentRow({ workspaceId: WORKSPACE, storageKey: "b", direction: "incoming", totalAmountCents: 30464, paymentStatus: "open" });
    s.documentState.push(a, b);
    const tx = transactionRow({ workspaceId: WORKSPACE, accountId: "a1", idempotencyKey: "k1", amountCents: -31664, counterpartyName: "IONOS SE" });
    s.transactionState.push(tx);

    await s.useCases.linkManually({ workspaceId: WORKSPACE, documentId: a.id, transactionId: tx.id, allocatedAmountCents: 1200, actingUserId: "u1" });
    await s.useCases.linkManually({ workspaceId: WORKSPACE, documentId: b.id, transactionId: tx.id, allocatedAmountCents: 30464, actingUserId: "u1" });

    expect(s.documentTransactionState.filter((r) => r.status === "confirmed")).toHaveLength(2);
  });

  it("allows a skonto suggestion to settle more than the discounted payment", async () => {
    const s = setup();
    const doc = documentRow({ workspaceId: WORKSPACE, storageKey: "a", direction: "incoming", totalAmountCents: 10000, paymentStatus: "open" });
    s.documentState.push(doc);
    const tx = transactionRow({ workspaceId: WORKSPACE, accountId: "a1", idempotencyKey: "k1", amountCents: -9800 });
    s.transactionState.push(tx);
    s.documentTransactionState.push(suggestedRow("dt1", doc.id, tx.id, 10000, "skonto"));

    await s.useCases.confirmSuggestion({ workspaceId: WORKSPACE, documentTransactionId: "dt1", actingUserId: "u1" });

    expect(s.documentTransactionState[0]?.status).toBe("confirmed");
  });
});

describe("createPaymentsUseCases - app-store payout pairing (decisions/0048-app-store-reports.md)", () => {
  function appleReportDocument(overrides: { period?: string; payoutAmountCents?: number } = {}) {
    const intakeResult = buildTabularConfirmedIntakeResult({
      documentKind: "payout_report",
      platform: "apple",
      rows: [],
      appStorePayout: {
        platform: "apple",
        period: overrides.period ?? "2025-01",
        payoutAmountCents: overrides.payoutAmountCents ?? 6151,
        payoutCurrency: "EUR",
      },
    });
    return documentRow({
      workspaceId: WORKSPACE,
      storageKey: "workspaces/w1/documents/d1/original.csv",
      kind: "payout_report",
      platform: "apple",
      intakeStatus: "confirmed",
      intakeResult,
    });
  }

  it("links the Apple report to its bank credit and confirms it automatically in mode 'system'", async () => {
    const s = setup({ autoConfirm: "system" });
    const doc = appleReportDocument();
    s.documentState.push(doc);
    const tx = transactionRow({
      workspaceId: WORKSPACE,
      accountId: "bank-1",
      idempotencyKey: "k-apple-payout",
      amountCents: 6151,
      creditDebit: "credit",
      bookingDate: "2025-03-06",
      counterpartyName: "Apple Inc",
    });
    s.transactionState.push(tx);

    await s.useCases.runMatching({ workspaceId: WORKSPACE, trigger: "import_batch" });

    expect(s.documentTransactionState).toHaveLength(1);
    expect(s.documentTransactionState[0]).toMatchObject({
      documentId: doc.id,
      transactionId: tx.id,
      status: "confirmed",
      kind: "collective",
      matchedBy: "auto",
      allocatedAmountCents: 6151,
    });
  });

  it("leaves a suggestion (never auto-confirms) in mode 'none', and the credit still shows suggestions", async () => {
    const s = setup({ autoConfirm: "none" });
    const doc = appleReportDocument();
    s.documentState.push(doc);
    const tx = transactionRow({
      workspaceId: WORKSPACE,
      accountId: "bank-1",
      idempotencyKey: "k-apple-payout",
      amountCents: 6151,
      creditDebit: "credit",
      bookingDate: "2025-03-06",
      counterpartyName: "Apple Inc",
    });
    s.transactionState.push(tx);

    await s.useCases.runMatching({ workspaceId: WORKSPACE, trigger: "import_batch" });

    expect(s.documentTransactionState).toHaveLength(1);
    expect(s.documentTransactionState[0]).toMatchObject({ documentId: doc.id, transactionId: tx.id, status: "suggested", kind: "collective" });
  });

  it("does not pair when no candidate matches yet (not booked, not an error)", async () => {
    const s = setup({ autoConfirm: "system" });
    const doc = appleReportDocument();
    s.documentState.push(doc);

    await s.useCases.runMatching({ workspaceId: WORKSPACE, trigger: "import_batch" });

    expect(s.documentTransactionState).toHaveLength(0);
  });
});
