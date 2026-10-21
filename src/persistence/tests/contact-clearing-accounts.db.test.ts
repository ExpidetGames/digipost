// Real Postgres (WEBAPP_TEMPLATE_SPEC.md §10.1/§10.3) for
// decisions/0068-supplier-clearing-accounts.md. Proves what a fake cannot: the partial unique
// index that allows at most one clearing account per contact, the check constraint that stops
// a clearing account being owned by a platform AND a contact, and - the heart of the feature -
// that creating the account books BOTH sides of the real Meta constellation (twelve invoices
// totalling 51,00 EUR, six FACEBK charges totalling 50,40 EUR, balance -0,60 EUR), that the
// booked charges stop counting as "Buchungen ohne Beleg", and that a second pass changes
// nothing.
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { normalizeName } from "@/modules/contacts";
import { aliasKeyForCounterparty } from "@/modules/payments";
import { getDb } from "@/persistence/foundation/client";
import { createDrizzleRepositories } from "@/persistence/repositories/drizzle/create-repositories";
import { createDrizzleUnitOfWork } from "@/persistence/repositories/drizzle/unit-of-work";
import { accounts, transactions } from "@/persistence/schema/accounts";
import type { ObjectStorage } from "@/platform/object-storage";
import { ACCOUNT_ERROR, createAccountsUseCases } from "@/persistence/use-cases/accounts-use-cases";
import { UseCaseError } from "@/persistence/use-cases/errors";

const db = getDb();
const repos = createDrizzleRepositories(db);
const uow = createDrizzleUnitOfWork(db);

/** The import service is the only part of this owner that touches object storage, and no
 * test here imports a document - a port that throws is more honest than a fake that pretends. */
const unusedObjectStorage = new Proxy({} as ObjectStorage, {
  get(_target, prop) {
    throw new Error(`ObjectStorage.${String(prop)} must not be used by this test`);
  },
});

const useCases = createAccountsUseCases({ repos, uow, objectStorage: unusedObjectStorage });

/** Invoice totals and charge amounts modelled on the sample table of decisions/0068. */
const INVOICE_CENTS = [200, 200, 200, 200, 300, 400, 500, 500, 700, 800, 900, 200];
const CHARGE_CENTS = [2000, 2000, 200, 200, 200, 440];

async function createWorkspace(name: string) {
  return repos.workspace.create({ name });
}

async function createContact(workspaceId: string, name: string) {
  return repos.contact.create({ workspaceId, name, source: "auto", verifiedAt: null, nameNormalized: normalizeName(name) });
}

async function createBankAccount(workspaceId: string) {
  return repos.account.create({
    workspaceId,
    type: "bank",
    name: "Testbank",
    iban: null,
    bic: null,
    currency: "EUR",
    holder: null,
    platform: null,
  });
}

async function createIncomingInvoice(
  workspaceId: string,
  contactId: string,
  input: { amountCents: number; documentDate: string; invoiceNumber: string },
) {
  const doc = await repos.document.create({
    id: randomUUID(),
    workspaceId,
    uploadedByUserId: null,
    originalFileName: `${input.invoiceNumber}.pdf`,
    mimeType: "application/pdf",
    pageCount: 1,
    sizeBytes: 1,
    storageKey: `workspaces/${workspaceId}/documents/${randomUUID()}/original.pdf`,
    fileHash: randomUUID(),
  });
  await repos.document.markDone(workspaceId, doc.id, {
    ocrText: "",
    ocrBlocks: null,
    title: input.invoiceNumber,
    sender: "Meta Platforms Ireland Limited",
    documentDate: input.documentDate,
    summary: null,
    searchablePdfKey: `workspaces/${workspaceId}/documents/${doc.id}/searchable.pdf`,
    direction: "incoming",
    invoiceNumber: input.invoiceNumber,
    totalAmountCents: input.amountCents,
    currency: "EUR",
    dueDate: null,
    paymentIban: null,
    paymentReference: null,
    paidNote: null,
    kind: "incoming_invoice",
    paymentStatus: "open",
  });
  await repos.documentContact.link({ documentId: doc.id, contactId, role: "sender" });
  return doc;
}

async function importCharge(workspaceId: string, accountId: string, input: { amountCents: number; bookingDate: string; counterpartyName: string }) {
  const [row] = await repos.transaction.insertManyIdempotent([
    {
      workspaceId,
      accountId,
      bookingDate: input.bookingDate,
      valueDate: null,
      amountCents: -input.amountCents,
      currency: "EUR",
      creditDebit: "debit",
      counterpartyName: input.counterpartyName,
      counterpartyIban: null,
      counterpartyBic: null,
      remittanceText: input.counterpartyName,
      endToEndId: null,
      mandateId: null,
      creditorId: null,
      bankTxCode: null,
      bankReference: null,
      idempotencyKey: `charge-${randomUUID()}`,
      importBatchId: null,
      sourceDocumentId: null,
      raw: null,
    },
  ]);
  return row!;
}

/** The whole Meta constellation, plus the learned payment name without which the FACEBK
 * charges cannot be resolved to the contact at all (decisions/0047's key, stated by the admin
 * when creating the account rather than learned from a confirmation that can never happen). */
async function seedMetaWorkspace(name: string) {
  const workspace = await createWorkspace(name);
  const contact = await createContact(workspace.id, "Meta Platforms Ireland Limited");
  const bank = await createBankAccount(workspace.id);

  for (const [index, amountCents] of INVOICE_CENTS.entries()) {
    await createIncomingInvoice(workspace.id, contact.id, {
      amountCents,
      documentDate: `2025-01-${String(index + 1).padStart(2, "0")}`,
      invoiceNumber: `FBADS-101-20000${index}`,
    });
  }
  const charges = [];
  for (const [index, amountCents] of CHARGE_CENTS.entries()) {
    charges.push(
      await importCharge(workspace.id, bank.id, {
        amountCents,
        bookingDate: `2025-01-${String(index + 1).padStart(2, "0")}`,
        counterpartyName: `FACEBK *REF${index}X7,fb.me/ads`,
      }),
    );
  }

  await repos.paymentAlias.upsert({
    workspaceId: workspace.id,
    counterpartyNameNormalized: aliasKeyForCounterparty("FACEBK"),
    contactId: contact.id,
    learnedFromUserId: null,
  });

  return { workspace, contact, bank, charges };
}

describe("contact-owned clearing account", () => {
  it("books both sides when the account is created, and books nothing a second time", async () => {
    const { workspace, contact } = await seedMetaWorkspace("Meta Clearing Co");

    const account = await useCases.createContactClearingAccount({ workspaceId: workspace.id, contactId: contact.id });

    expect(account.type).toBe("clearing");
    expect(account.contactId).toBe(contact.id);
    expect(account.platform).toBeNull();

    const booked = await db.select().from(transactions).where(eq(transactions.accountId, account.id));
    expect(booked).toHaveLength(INVOICE_CENTS.length + CHARGE_CENTS.length);

    // The sign convention: an invoice grows the liability (negative), a charge pays it down
    // (positive). 51,00 EUR invoiced minus 50,40 EUR charged leaves -0,60 EUR.
    const balanceCents = booked.reduce((sum, row) => sum + row.amountCents, 0);
    expect(balanceCents).toBe(-60);
    const { amountCents: repositorySum } = await repos.transaction.sumAmountCents(workspace.id, account.id, "EUR");
    expect(repositorySum).toBe(-60);

    // Every invoice left `open`: settled, just not by a payment of its own.
    const candidates = await repos.document.listInvoiceCandidates(workspace.id);
    expect(candidates).toHaveLength(0);

    // No charge is left unexplained on the bank side: each one shares a transfer group with
    // its clearing-account booking.
    const { items: unexplained } = await repos.transaction.listUnmatched(workspace.id, { page: 1, pageSize: 100 });
    expect(unexplained).toHaveLength(0);

    const second = await useCases.bookContactClearingEntries({ workspaceId: workspace.id });
    expect(second).toEqual({ invoicesBooked: 0, chargesBooked: 0 });
    const afterSecondPass = await db.select().from(transactions).where(eq(transactions.accountId, account.id));
    expect(afterSecondPass).toHaveLength(booked.length);
  });

  it("books an invoice and a charge that only arrive after the account exists", async () => {
    const { workspace, contact, bank } = await seedMetaWorkspace("Meta Clearing Later Co");
    const account = await useCases.createContactClearingAccount({ workspaceId: workspace.id, contactId: contact.id });

    await createIncomingInvoice(workspace.id, contact.id, { amountCents: 1000, documentDate: "2025-04-02", invoiceNumber: "FBADS-101-999" });
    await importCharge(workspace.id, bank.id, { amountCents: 900, bookingDate: "2025-04-05", counterpartyName: "FACEBK *LATE42,fb.me/ads" });

    const result = await useCases.bookContactClearingEntries({ workspaceId: workspace.id });

    expect(result).toEqual({ invoicesBooked: 1, chargesBooked: 1 });
    const { amountCents } = await repos.transaction.sumAmountCents(workspace.id, account.id, "EUR");
    expect(amountCents).toBe(-160); // -60 - 1000 + 900
  });

  it("leaves a charge that resolves to nobody unexplained, and another contact's invoice alone", async () => {
    const { workspace, contact, bank } = await seedMetaWorkspace("Meta Clearing Conservative Co");
    const otherContact = await createContact(workspace.id, "IONOS SE");
    await createIncomingInvoice(workspace.id, otherContact.id, { amountCents: 350, documentDate: "2025-02-03", invoiceNumber: "RE-7" });
    const strangerCharge = await importCharge(workspace.id, bank.id, { amountCents: 777, bookingDate: "2025-02-04", counterpartyName: "Unbekannt GmbH" });

    const account = await useCases.createContactClearingAccount({ workspaceId: workspace.id, contactId: contact.id });

    const booked = await db.select().from(transactions).where(eq(transactions.accountId, account.id));
    expect(booked.some((row) => row.amountCents === 777)).toBe(false);

    const { items: unexplained } = await repos.transaction.listUnmatched(workspace.id, { page: 1, pageSize: 100 });
    expect(unexplained.map((row) => row.id)).toEqual([strangerCharge.id]);

    const candidates = await repos.document.listInvoiceCandidates(workspace.id);
    expect(candidates.map((row) => row.invoiceNumber)).toEqual(["RE-7"]);
  });

  it("allows at most one clearing account per contact", async () => {
    const workspace = await createWorkspace("Meta Clearing Unique Co");
    const contact = await createContact(workspace.id, "Meta Platforms Ireland Limited");

    await useCases.createContactClearingAccount({ workspaceId: workspace.id, contactId: contact.id });
    await expect(useCases.createContactClearingAccount({ workspaceId: workspace.id, contactId: contact.id })).rejects.toMatchObject({
      code: ACCOUNT_ERROR.clearingAccountExists,
    });

    const rows = await db.select().from(accounts).where(and(eq(accounts.workspaceId, workspace.id), eq(accounts.type, "clearing")));
    expect(rows).toHaveLength(1);
  });

  it("refuses a clearing account owned by a platform and a contact at once", async () => {
    const workspace = await createWorkspace("Meta Clearing Owner Co");
    const contact = await createContact(workspace.id, "Meta Platforms Ireland Limited");

    await expect(
      repos.account.create({
        workspaceId: workspace.id,
        type: "clearing",
        name: "Beides (Verrechnungskonto)",
        iban: null,
        bic: null,
        currency: "EUR",
        holder: null,
        platform: "stripe",
        contactId: contact.id,
      }),
    ).rejects.toThrow();
  });

  it("rejects a contact from another workspace", async () => {
    const workspace = await createWorkspace("Meta Clearing Scope Co");
    const otherWorkspace = await createWorkspace("Meta Clearing Other Co");
    const foreignContact = await createContact(otherWorkspace.id, "Fremd GmbH");

    await expect(useCases.createContactClearingAccount({ workspaceId: workspace.id, contactId: foreignContact.id })).rejects.toBeInstanceOf(UseCaseError);
  });
});
