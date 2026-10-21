// Real Postgres (WEBAPP_TEMPLATE_SPEC.md §10.1/§10.3). Every fixture uses its own
// workspace/user (no shared rows, no outer rollback wrapper), mirroring
// `workspaces-repository.db.test.ts`'s pattern.
import { and, eq, inArray } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { normalizeName } from "@/modules/contacts";
import { joinOcrText } from "@/modules/documents";
import { getDb } from "@/persistence/foundation/client";
import { createDrizzleDocumentRepository } from "@/persistence/repositories/drizzle/documents-repository";
import { createDrizzleContactRepository } from "@/persistence/repositories/drizzle/contacts-repository";
import { createDrizzleWorkspaceRepository } from "@/persistence/repositories/drizzle/workspaces-repository";
import { documentContacts } from "@/persistence/schema/contacts";
import { documents } from "@/persistence/schema/documents";
import { randomUUID } from "node:crypto";

const db = getDb();

async function createTestWorkspace(name: string): Promise<{ id: string }> {
  const repo = createDrizzleWorkspaceRepository(db);
  return repo.create({ name });
}

function documentInput(workspaceId: string, overrides: Partial<Parameters<ReturnType<typeof createDrizzleDocumentRepository>["create"]>[0]> = {}) {
  return {
    id: randomUUID(),
    workspaceId,
    uploadedByUserId: null,
    originalFileName: "brief.pdf",
    mimeType: "application/pdf",
    pageCount: 1,
    sizeBytes: 1024,
    storageKey: `workspaces/${workspaceId}/documents/${randomUUID()}/original.pdf`,
    fileHash: randomUUID(),
    ...overrides,
  };
}

describe("createDrizzleDocumentRepository", () => {
  it("creates a document with the given id and finds it scoped to its workspace", async () => {
    const workspace = await createTestWorkspace("Doc Co A");
    const otherWorkspace = await createTestWorkspace("Doc Co B");
    const repo = createDrizzleDocumentRepository(db);
    const created = await repo.create(documentInput(workspace.id));

    expect(await repo.findById(workspace.id, created.id)).toMatchObject({ id: created.id, originalFileName: "brief.pdf" });
    expect(await repo.findById(otherWorkspace.id, created.id)).toBeNull();
  });

  it("countByWorkspace only counts the given workspace's documents", async () => {
    const workspaceA = await createTestWorkspace("Count Co A");
    const workspaceB = await createTestWorkspace("Count Co B");
    const repo = createDrizzleDocumentRepository(db);
    await repo.create(documentInput(workspaceA.id));
    await repo.create(documentInput(workspaceA.id));
    await repo.create(documentInput(workspaceB.id));

    expect(await repo.countByWorkspace(workspaceA.id)).toBe(2);
    expect(await repo.countByWorkspace(workspaceB.id)).toBe(1);
  });

  it("countByWorkspace runs a real SQL count(*), not a client-side count of every row (P6 review finding A7)", async () => {
    // Before the fix, `countByWorkspace` did `select id from documents where ...` and
    // returned `rows.length` - Postgres itself would hand back one row PER document. A real
    // `count(*)` always hands back exactly one row, an aggregate, no matter how many
    // documents match. Intercepting the underlying `pg` client's `query` (via drizzle's
    // `$client`, the real `Pool` instance) observes the actual wire-level result Postgres
    // sent back, which is the one thing that differs between the two implementations even
    // though both return the same final JS number.
    const workspace = await createTestWorkspace("Count SQL Shape Co");
    const repo = createDrizzleDocumentRepository(db);
    for (let i = 0; i < 5; i += 1) {
      await repo.create(documentInput(workspace.id));
    }

    const pool = db.$client;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- intercepting pg.Pool.query for a test-only spy; its overloaded signature does not fit a narrower type or a tuple-typed spread.
    const originalQuery = pool.query.bind(pool) as (...args: any[]) => Promise<any>;
    let lastDocumentsQueryRowCount: number | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- intercepting pg.Pool.query for a test-only spy; its overloaded signature does not fit a narrower type.
    (pool as any).query = async (...args: any[]) => {
      const result = await originalQuery(...args);
      const text: string | undefined = typeof args[0] === "string" ? args[0] : args[0]?.text;
      if (text?.includes('"documents"') && text.toLowerCase().includes("workspace_id")) {
        lastDocumentsQueryRowCount = Array.isArray(result?.rows) ? result.rows.length : null;
      }
      return result;
    };

    try {
      const count = await repo.countByWorkspace(workspace.id);
      expect(count).toBe(5);
      // The 5 seeded documents proves this: a per-row `select id` would have come back as 5
      // rows; a real `count(*)` comes back as exactly 1 (the aggregate) regardless of how
      // many documents matched.
      expect(lastDocumentsQueryRowCount).toBe(1);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- restoring the spy, same justification as the assignment above.
      (pool as any).query = originalQuery;
    }
  });

  it("list scopes to the workspace and paginates with hasMore", async () => {
    const workspace = await createTestWorkspace("List Co");
    const otherWorkspace = await createTestWorkspace("List Co Other");
    const repo = createDrizzleDocumentRepository(db);
    for (let i = 0; i < 3; i += 1) {
      await repo.create(documentInput(workspace.id, { originalFileName: `doc-${i}.pdf` }));
    }
    await repo.create(documentInput(otherWorkspace.id));

    const firstPage = await repo.list(workspace.id, { page: 1, pageSize: 2 });
    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.hasMore).toBe(true);

    const secondPage = await repo.list(workspace.id, { page: 2, pageSize: 2 });
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.hasMore).toBe(false);

    const otherWorkspaceList = await repo.list(otherWorkspace.id, { page: 1, pageSize: 50 });
    expect(otherWorkspaceList.items).toHaveLength(1);
  });

  it("filters by status", async () => {
    const workspace = await createTestWorkspace("Filter Co");
    const repo = createDrizzleDocumentRepository(db);

    await repo.create(documentInput(workspace.id, { originalFileName: "one.pdf" }));
    await repo.create(documentInput(workspace.id, { originalFileName: "two.pdf" }));

    const byStatus = await repo.list(workspace.id, { status: "uploaded", page: 1, pageSize: 50 });
    expect(byStatus.items.length).toBeGreaterThanOrEqual(2);
  });

  it("German full-text search finds a stemmed match in ocr_text", async () => {
    const workspace = await createTestWorkspace("Search Co");
    const repo = createDrizzleDocumentRepository(db);
    const created = await repo.create(documentInput(workspace.id, { originalFileName: "unrelated.pdf" }));
    // ocr_text is set directly (P2b's job normally); the generated search_vector column
    // recomputes automatically.
    await db.update(documents).set({ ocrText: "Diese Rechnung ist bereits bezahlt." }).where(eq(documents.id, created.id));

    const result = await repo.list(workspace.id, { q: "Rechnungen", page: 1, pageSize: 50 });
    expect(result.items.map((d) => d.id)).toContain(created.id);
  });

  it("German full-text search finds a document by an invoice table's amount or item name (D1)", async () => {
    const workspace = await createTestWorkspace("Invoice Search Co");
    const repo = createDrizzleDocumentRepository(db);
    const created = await repo.create(documentInput(workspace.id, { originalFileName: "unrelated-invoice.pdf" }));

    // Shaped like the real Mistral OCR output for a German invoice (D1, P7): a markdown
    // table with item names, quantities, prices and a "19 %" tax rate, plus a totals line -
    // run through the same `joinOcrText` the processing pipeline uses, proving the table's
    // content actually survives into `ocr_text` and is found by Postgres full-text search,
    // not just that the plain-text function returns something non-empty.
    const invoiceMarkdown = [
      "# Rechnung Nr. 2026-0817",
      "",
      "| Pos | Beschreibung | Menge | Einzelpreis | USt-Satz | Gesamtpreis |",
      "| --- | --- | --- | --- | --- | --- |",
      "| 1 | Fachbücher Wirtschaftsrecht | 12 | 45,00 € | 19 % | 540,00 € |",
      "",
      "**Gesamtbetrag: 1.083,68 €**",
    ].join("\n");
    const ocrText = joinOcrText([{ index: 0, markdown: invoiceMarkdown, dimensions: null, blocks: null }]);
    await db.update(documents).set({ ocrText }).where(eq(documents.id, created.id));

    const byItemName = await repo.list(workspace.id, { q: "Fachbuch", page: 1, pageSize: 50 });
    expect(byItemName.items.map((d) => d.id)).toContain(created.id);

    const byAmount = await repo.list(workspace.id, { q: "1.083,68", page: 1, pageSize: 50 });
    expect(byAmount.items.map((d) => d.id)).toContain(created.id);
  });

  it("ranks a title match (weight A) above an ocr_text-only match (weight C) for the same term", async () => {
    const workspace = await createTestWorkspace("Search Rank Co");
    const repo = createDrizzleDocumentRepository(db);

    const ocrOnly = await repo.create(documentInput(workspace.id, { originalFileName: "unrelated.pdf" }));
    await db.update(documents).set({ ocrText: "Diese Rechnung ist bereits bezahlt." }).where(eq(documents.id, ocrOnly.id));

    const titleMatch = await repo.create(documentInput(workspace.id, { originalFileName: "unrelated-2.pdf" }));
    await db.update(documents).set({ title: "Rechnung Nr. 42" }).where(eq(documents.id, titleMatch.id));

    const result = await repo.list(workspace.id, { q: "Rechnung", page: 1, pageSize: 50 });
    const ids = result.items.map((d) => d.id);
    expect(ids.indexOf(titleMatch.id)).toBeLessThan(ids.indexOf(ocrOnly.id));
  });

  it(
    "breaks ts_rank ties with created_at desc, then id desc, so offset pagination neither " +
      "skips nor duplicates a row across pages (P6 review finding A8)",
    async () => {
      const workspace = await createTestWorkspace("Search Tie-Break Co");
      const repo = createDrizzleDocumentRepository(db);

      // Three documents whose ocr_text matches identically ("Rechnung" once each, nothing
      // else populated) - their ts_rank is exactly equal, so without an explicit tie-break
      // Postgres gives no guaranteed relative order between them.
      const docs: { id: string }[] = [];
      for (let i = 0; i < 3; i += 1) {
        const doc = await repo.create(documentInput(workspace.id, { originalFileName: `tie-${i}.pdf` }));
        await db.update(documents).set({ ocrText: "Rechnung" }).where(eq(documents.id, doc.id));
        docs.push(doc);
      }
      // Force all three to the exact same created_at, so the id tie-break is the only thing
      // left to make the order deterministic.
      const sameInstant = new Date("2026-01-01T00:00:00.000Z");
      await db
        .update(documents)
        .set({ createdAt: sameInstant })
        .where(
          and(
            eq(documents.workspaceId, workspace.id),
            inArray(
              documents.id,
              docs.map((d) => d.id),
            ),
          ),
        );

      const full = await repo.list(workspace.id, { q: "Rechnung", page: 1, pageSize: 50 });
      const fullIds = full.items.map((d) => d.id).filter((id) => docs.some((d) => d.id === id));
      // Deterministic: id desc, since created_at is now tied for all three.
      expect(fullIds).toEqual([...docs].map((d) => d.id).sort().reverse());

      // The same order, reproduced one row at a time across three pages of size 1 - no row
      // is skipped or seen twice.
      const paged: string[] = [];
      for (let page = 1; page <= 3; page += 1) {
        const result = await repo.list(workspace.id, { q: "Rechnung", page, pageSize: 1 });
        paged.push(...result.items.map((d) => d.id));
      }
      expect(paged).toEqual(fullIds);
    },
  );

  it("deleteById is scoped to the workspace and returns the row for compensation", async () => {
    const workspace = await createTestWorkspace("Delete Co");
    const otherWorkspace = await createTestWorkspace("Delete Co Other");
    const repo = createDrizzleDocumentRepository(db);
    const doc = await repo.create(documentInput(workspace.id));

    expect(await repo.deleteById(otherWorkspace.id, doc.id)).toBeNull();
    const deleted = await repo.deleteById(workspace.id, doc.id);
    expect(deleted).toMatchObject({ id: doc.id, storageKey: doc.storageKey });
    expect(await repo.findById(workspace.id, doc.id)).toBeNull();
  });

  // decisions/0058-inbox-sorts-by-the-document-s-own-date.md: the inbox is ordered by the date
  // the document itself carries, not by when it reached us. The trigger: dozens of
  // receipts uploaded in one afternoon all shared an upload timestamp while carrying dates
  // spread over a year.
  describe("list ordering", () => {
    /** Three documents created in a known upload order, then given document dates that run the
     * OTHER way, so an assertion can never pass by accident on the insertion order. */
    async function seedForOrdering(workspaceId: string) {
      const repo = createDrizzleDocumentRepository(db);
      const first = await repo.create(documentInput(workspaceId, { originalFileName: "uploaded-first.pdf" }));
      const second = await repo.create(documentInput(workspaceId, { originalFileName: "uploaded-second.pdf" }));
      const third = await repo.create(documentInput(workspaceId, { originalFileName: "uploaded-third.pdf" }));
      await db.update(documents).set({ documentDate: "2025-03-01" }).where(eq(documents.id, first.id));
      await db.update(documents).set({ documentDate: "2025-01-01" }).where(eq(documents.id, second.id));
      // `third` deliberately keeps no document date: it stands for a tabular import (a bank
      // statement or an app-store report covers a period, not a day).
      return { repo, first, second, third };
    }

    const listNames = async (repo: ReturnType<typeof createDrizzleDocumentRepository>, workspaceId: string, sort: "documentDate" | "uploaded") =>
      (await repo.list(workspaceId, { page: 1, pageSize: 50, sort })).items.map((row) => row.originalFileName);

    it("orders by the document's own date, newest first", async () => {
      const workspace = await createTestWorkspace("Sort Co A");
      const { repo } = await seedForOrdering(workspace.id);

      // The undated one falls back to its upload time, which is the newest of the three.
      expect(await listNames(repo, workspace.id, "documentDate")).toEqual(["uploaded-third.pdf", "uploaded-first.pdf", "uploaded-second.pdf"]);
    });

    it("keeps an undated document in the timeline instead of sinking it to the end", async () => {
      const workspace = await createTestWorkspace("Sort Co B");
      const { repo, third } = await seedForOrdering(workspace.id);
      // Backdate the undated document's arrival to BETWEEN the other two document dates: a
      // `nulls last` ordering would put it last, `coalesce` puts it where it belongs.
      await db.update(documents).set({ createdAt: new Date("2025-02-01T12:00:00Z") }).where(eq(documents.id, third.id));

      expect(await listNames(repo, workspace.id, "documentDate")).toEqual(["uploaded-first.pdf", "uploaded-third.pdf", "uploaded-second.pdf"]);
    });

    // decisions/0060-app-store-reports-are-named-by-their-period.md
    it("places an app-store report at the end of the month it covers", async () => {
      const workspace = await createTestWorkspace("Sort Co D");
      const repo = createDrizzleDocumentRepository(db);
      const invoiceBefore = await repo.create(documentInput(workspace.id, { originalFileName: "invoice-before.pdf" }));
      const report = await repo.create(documentInput(workspace.id, { originalFileName: "financial_report.csv" }));
      const invoiceAfter = await repo.create(documentInput(workspace.id, { originalFileName: "invoice-after.pdf" }));
      await db.update(documents).set({ documentDate: "2025-03-10" }).where(eq(documents.id, invoiceBefore.id));
      await db.update(documents).set({ documentDate: "2025-04-05" }).where(eq(documents.id, invoiceAfter.id));
      await db
        .update(documents)
        .set({ kind: "payout_report", platform: "apple", intakeResult: { appStorePayout: { period: "2025-03" } } })
        .where(eq(documents.id, report.id));

      const result = await repo.list(workspace.id, { page: 1, pageSize: 50 });
      expect(result.items.map((row) => row.originalFileName)).toEqual(["invoice-after.pdf", "financial_report.csv", "invoice-before.pdf"]);
      expect(result.items.find((row) => row.originalFileName === "financial_report.csv")?.reportPeriod).toBe("2025-03");
    });

    // decisions/0061-a-statement-is-dated-by-its-last-booking.md
    it("places a bank statement at its last booking", async () => {
      const workspace = await createTestWorkspace("Sort Co F");
      const repo = createDrizzleDocumentRepository(db);
      const before = await repo.create(documentInput(workspace.id, { originalFileName: "invoice-before.pdf" }));
      const statement = await repo.create(documentInput(workspace.id, { originalFileName: "statement.xml" }));
      const after = await repo.create(documentInput(workspace.id, { originalFileName: "invoice-after.pdf" }));
      await db.update(documents).set({ documentDate: "2026-05-01" }).where(eq(documents.id, before.id));
      await db.update(documents).set({ documentDate: "2026-06-01" }).where(eq(documents.id, after.id));
      await db
        .update(documents)
        .set({ kind: "bank_statement", intakeResult: { type: "bank_statement", lastBookingDate: "2026-05-20" } })
        .where(eq(documents.id, statement.id));

      const result = await repo.list(workspace.id, { page: 1, pageSize: 50 });
      expect(result.items.map((row) => row.originalFileName)).toEqual(["invoice-after.pdf", "statement.xml", "invoice-before.pdf"]);
      expect(result.items.find((row) => row.originalFileName === "statement.xml")?.statementLastBooking).toBe("2026-05-20");
    });

    it("ignores an intake result whose period is not a period", async () => {
      // The `to_date` call must never see anything but `YYYY-MM`, or the whole list query
      // fails for every row.
      const workspace = await createTestWorkspace("Sort Co E");
      const repo = createDrizzleDocumentRepository(db);
      const report = await repo.create(documentInput(workspace.id, { originalFileName: "broken-period.csv" }));
      await db
        .update(documents)
        .set({ kind: "payout_report", platform: "apple", intakeResult: { appStorePayout: { period: "not-a-period" } } })
        .where(eq(documents.id, report.id));

      const result = await repo.list(workspace.id, { page: 1, pageSize: 50 });
      expect(result.items).toHaveLength(1);
      expect(result.items[0]!.reportPeriod).toBe("not-a-period");
    });

    it("still offers the old upload order", async () => {
      const workspace = await createTestWorkspace("Sort Co C");
      const { repo } = await seedForOrdering(workspace.id);

      expect(await listNames(repo, workspace.id, "uploaded")).toEqual(["uploaded-third.pdf", "uploaded-second.pdf", "uploaded-first.pdf"]);
    });
  });

  // decisions/0059-generated-document-names.md: the inbox names a row after the contact the
  // document is WITH, which its direction decides. Resolved by a correlated subquery, so this
  // also pins down that a second contact in the same role can never duplicate a row.
  describe("list resolves the counterparty", () => {
    async function linkContact(workspaceId: string, documentId: string, name: string, role: "sender" | "recipient", createdAt: Date) {
      const contactRepo = createDrizzleContactRepository(db);
      const contact = await contactRepo.create({ workspaceId, name, nameNormalized: normalizeName(name), source: "auto", verifiedAt: null });
      await db.insert(documentContacts).values({ documentId, contactId: contact.id, role, createdAt });
      return contact;
    }

    it("takes the sender of an incoming document and the recipient of an outgoing one", async () => {
      const workspace = await createTestWorkspace("Counterparty Co A");
      const repo = createDrizzleDocumentRepository(db);
      const incoming = await repo.create(documentInput(workspace.id, { originalFileName: "incoming.pdf" }));
      const outgoing = await repo.create(documentInput(workspace.id, { originalFileName: "outgoing.pdf" }));
      await db.update(documents).set({ direction: "incoming" }).where(eq(documents.id, incoming.id));
      await db.update(documents).set({ direction: "outgoing" }).where(eq(documents.id, outgoing.id));

      await linkContact(workspace.id, incoming.id, "IONOS SE", "sender", new Date("2025-01-01T00:00:00Z"));
      // The outgoing document carries BOTH roles: we are its sender, the customer its
      // recipient. Only the customer may end up in the name.
      await linkContact(workspace.id, outgoing.id, "musterfirma", "sender", new Date("2025-01-01T00:00:00Z"));
      await linkContact(workspace.id, outgoing.id, "Bauwerk Bau", "recipient", new Date("2025-01-01T00:00:00Z"));

      const byName = new Map((await repo.list(workspace.id, { page: 1, pageSize: 50 })).items.map((row) => [row.originalFileName, row.counterpartyName]));
      expect(byName.get("incoming.pdf")).toBe("IONOS SE");
      expect(byName.get("outgoing.pdf")).toBe("Bauwerk Bau");
    });

    it("returns one row, not two, when a document carries two contacts in the same role", async () => {
      // decisions/0019-contacts.md allows this on purpose: a debt collector writing for a
      // creditor, a lawyer for a client. A join would have duplicated the document and broken
      // offset pagination.
      const workspace = await createTestWorkspace("Counterparty Co B");
      const repo = createDrizzleDocumentRepository(db);
      const doc = await repo.create(documentInput(workspace.id, { originalFileName: "two-senders.pdf" }));
      await db.update(documents).set({ direction: "incoming" }).where(eq(documents.id, doc.id));
      await linkContact(workspace.id, doc.id, "Inkasso Zweitkontakt", "sender", new Date("2025-02-01T00:00:00Z"));
      await linkContact(workspace.id, doc.id, "Gläubiger Erstkontakt", "sender", new Date("2025-01-01T00:00:00Z"));

      const result = await repo.list(workspace.id, { page: 1, pageSize: 50 });
      expect(result.items).toHaveLength(1);
      // Oldest link first, so the choice is stable across runs.
      expect(result.items[0]!.counterpartyName).toBe("Gläubiger Erstkontakt");
    });

    it("is null for a document with no linked contact at all", async () => {
      const workspace = await createTestWorkspace("Counterparty Co C");
      const repo = createDrizzleDocumentRepository(db);
      await repo.create(documentInput(workspace.id, { originalFileName: "financial_report.csv" }));

      const result = await repo.list(workspace.id, { page: 1, pageSize: 50 });
      expect(result.items[0]!.counterpartyName).toBeNull();
    });
  });

  describe("listIntakeRejectedBefore (F5, decisions/0027-hardening-and-deletion.md)", () => {
    async function insertWithIntakeStatus(
      workspaceId: string,
      intakeStatus: "rejected" | "confirmed" | "pending_confirmation",
      updatedAt: Date,
    ): Promise<string> {
      const repo = createDrizzleDocumentRepository(db);
      const doc = await repo.create(documentInput(workspaceId));
      await db.update(documents).set({ intakeStatus, updatedAt }).where(eq(documents.id, doc.id));
      return doc.id;
    }

    it("finds a rejected document older than the cutoff, across every workspace, and reports its workspace id", async () => {
      const workspaceA = await createTestWorkspace("Retention Co A");
      const workspaceB = await createTestWorkspace("Retention Co B");
      const cutoff = new Date("2026-01-01T00:00:00.000Z");
      const oldEnoughA = await insertWithIntakeStatus(workspaceA.id, "rejected", new Date("2025-11-01T00:00:00.000Z"));
      const oldEnoughB = await insertWithIntakeStatus(workspaceB.id, "rejected", new Date("2025-11-01T00:00:00.000Z"));
      const repo = createDrizzleDocumentRepository(db);

      const eligible = await repo.listIntakeRejectedBefore(cutoff);
      const eligibleIds = eligible.map((d) => d.id);

      expect(eligibleIds).toEqual(expect.arrayContaining([oldEnoughA, oldEnoughB]));
      expect(eligible.find((d) => d.id === oldEnoughA)).toMatchObject({ workspaceId: workspaceA.id });
      expect(eligible.find((d) => d.id === oldEnoughB)).toMatchObject({ workspaceId: workspaceB.id });
    });

    it("excludes a rejected document not yet older than the cutoff", async () => {
      const workspace = await createTestWorkspace("Retention Co C");
      const cutoff = new Date("2026-01-01T00:00:00.000Z");
      const tooRecent = await insertWithIntakeStatus(workspace.id, "rejected", new Date("2026-01-02T00:00:00.000Z"));

      const repo = createDrizzleDocumentRepository(db);
      const eligible = await repo.listIntakeRejectedBefore(cutoff);

      expect(eligible.map((d) => d.id)).not.toContain(tooRecent);
    });

    it("excludes a document with any other intake status, however old", async () => {
      const workspace = await createTestWorkspace("Retention Co D");
      const cutoff = new Date("2026-01-01T00:00:00.000Z");
      const oldConfirmed = await insertWithIntakeStatus(workspace.id, "confirmed", new Date("2025-11-01T00:00:00.000Z"));
      const oldPending = await insertWithIntakeStatus(workspace.id, "pending_confirmation", new Date("2025-11-01T00:00:00.000Z"));

      const repo = createDrizzleDocumentRepository(db);
      const eligible = await repo.listIntakeRejectedBefore(cutoff);

      expect(eligible.map((d) => d.id)).not.toEqual(expect.arrayContaining([oldConfirmed, oldPending]));
    });
  });
});

// decisions/0063-no-category-no-assignment-no-routing.md's successor page: the "Start" work
// list's three member-level buckets. Each is a real `count(*)`; the point of testing them
// against real Postgres is that a count shown on Start must agree with what the list it links
// to actually shows, or the page teaches the user to distrust it.
describe("the Start work list's document counts", () => {
  it("counts only this workspace's documents waiting for confirmation", async () => {
    const workspace = await createTestWorkspace("Start Co A");
    const otherWorkspace = await createTestWorkspace("Start Co A Other");
    const repo = createDrizzleDocumentRepository(db);
    const waiting = await repo.create(documentInput(workspace.id));
    const done = await repo.create(documentInput(workspace.id));
    const foreign = await repo.create(documentInput(otherWorkspace.id));
    await db.update(documents).set({ intakeStatus: "pending_confirmation" }).where(inArray(documents.id, [waiting.id, foreign.id]));
    await db.update(documents).set({ intakeStatus: "confirmed" }).where(eq(documents.id, done.id));

    expect(await repo.countPendingIntakeConfirmation(workspace.id)).toBe(1);
    expect(await repo.countPendingIntakeConfirmation(otherWorkspace.id)).toBe(1);
  });

  it("counts failed documents only", async () => {
    const workspace = await createTestWorkspace("Start Co B");
    const repo = createDrizzleDocumentRepository(db);
    const failed = await repo.create(documentInput(workspace.id));
    await repo.create(documentInput(workspace.id));
    await db.update(documents).set({ status: "failed" }).where(eq(documents.id, failed.id));

    expect(await repo.countFailed(workspace.id)).toBe(1);
  });

  // The stored column is never clock-updated (see `resolveDisplayStatus`), so "overdue" is a
  // due date in the past on an open row. Both halves matter: a past due date that is already
  // paid must not count, and an open row that is not due yet must not either.
  it("counts an open document past its due date, and neither a paid one nor a future one", async () => {
    const workspace = await createTestWorkspace("Start Co C");
    const repo = createDrizzleDocumentRepository(db);
    const overdue = await repo.create(documentInput(workspace.id));
    const paidButPast = await repo.create(documentInput(workspace.id));
    const openButFuture = await repo.create(documentInput(workspace.id));
    await db.update(documents).set({ paymentStatus: "open", dueDate: "2020-01-01" }).where(eq(documents.id, overdue.id));
    await db.update(documents).set({ paymentStatus: "paid", dueDate: "2020-01-01" }).where(eq(documents.id, paidButPast.id));
    await db.update(documents).set({ paymentStatus: "open", dueDate: "2999-01-01" }).where(eq(documents.id, openButFuture.id));

    expect(await repo.countOverduePayments(workspace.id)).toBe(1);
  });
});
