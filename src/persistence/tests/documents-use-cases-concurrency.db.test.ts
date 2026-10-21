// Real Postgres (WEBAPP_TEMPLATE_SPEC.md §10.1/§10.3): proves the row lock
// (`workspace.lockForUpdate`, `select ... for update`) actually serializes two concurrent
// uploads against the same quota, using the real Drizzle repositories and Unit of Work (a
// fake `ObjectStorage` stands in for MinIO - only the transaction/locking behavior is under
// test here, not storage itself, which `tests/integration/http/documents-upload.integration.test.ts`
// covers against real MinIO).
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { getDb } from "@/persistence/foundation/client";
import { createDrizzleRepositories } from "@/persistence/repositories/drizzle/create-repositories";
import { createDrizzleUnitOfWork } from "@/persistence/repositories/drizzle/unit-of-work";
import { createDrizzleWorkspaceRepository } from "@/persistence/repositories/drizzle/workspaces-repository";
import { jobs } from "@/persistence/schema/jobs";
import { createTestPaymentProvider } from "@/modules/billing";
import { createBillingUseCases } from "@/persistence/use-cases/billing-use-cases";
import { createContactUseCases } from "@/persistence/use-cases/contacts-use-cases";
import { createDocumentUseCases, DOCUMENT_ERROR } from "@/persistence/use-cases/documents-use-cases";
import { createFakeObjectStorage } from "@/platform/object-storage/tests/support/fake-object-storage";
import { createFakeDocumentAnalyzer, createFakeOcrEngine } from "@/modules/documents";
import { createFakeIntakeClassifier } from "@/modules/intake";

const db = getDb();

describe("createFromUpload concurrency", () => {
  it("serializes two concurrent creates at the limit: exactly one succeeds", async () => {
    const workspaceRepo = createDrizzleWorkspaceRepository(db);
    const workspace = await workspaceRepo.create({ name: "Concurrency Co" });

    const repos = createDrizzleRepositories(db);
    const uow = createDrizzleUnitOfWork(db);
    const { storage } = createFakeObjectStorage();
    const billing = createBillingUseCases({ repos, uow, paymentProvider: createTestPaymentProvider() });
    const contacts = createContactUseCases({ repos, uow });
    const useCases = createDocumentUseCases({
      repos,
      uow,
      objectStorage: storage,
      billing,
      contacts,
      ocrEngine: createFakeOcrEngine(),
      analyzer: createFakeDocumentAnalyzer(),
      intakeClassifier: createFakeIntakeClassifier(),
    });

    // Free tier's total limit is 20; fill 19 slots directly so exactly one more upload fits.
    for (let i = 0; i < 19; i += 1) {
      await useCases.createFromUpload({
        workspaceId: workspace.id,
        uploadedByUserId: null,
        originalFileName: `seed-${i}.pdf`,
        bytes: new Uint8Array([1]),
        mimeType: "application/pdf",
        extension: "pdf",
        pageCount: 1,
        fileHash: crypto.randomUUID(),
      });
    }

    const results = await Promise.allSettled([
      useCases.createFromUpload({
        workspaceId: workspace.id,
        uploadedByUserId: null,
        originalFileName: "race-a.pdf",
        bytes: new Uint8Array([1]),
        mimeType: "application/pdf",
        extension: "pdf",
        pageCount: 1,
        fileHash: crypto.randomUUID(),
      }),
      useCases.createFromUpload({
        workspaceId: workspace.id,
        uploadedByUserId: null,
        originalFileName: "race-b.pdf",
        bytes: new Uint8Array([1]),
        mimeType: "application/pdf",
        extension: "pdf",
        pageCount: 1,
        fileHash: crypto.randomUUID(),
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: DOCUMENT_ERROR.quotaTotalExceeded });

    expect(await repos.document.countByWorkspace(workspace.id)).toBe(20);
  });

  it(
    "at the 80% warning threshold, two concurrent creates enqueue exactly one warning job " +
      "(decisions/0017-billing-tiers-and-packages.md: 'never twice per period', proved under concurrency)",
    async () => {
      const workspaceRepo = createDrizzleWorkspaceRepository(db);
      const workspace = await workspaceRepo.create({ name: "Warning Race Co" });

      const repos = createDrizzleRepositories(db);
      const uow = createDrizzleUnitOfWork(db);
      const { storage } = createFakeObjectStorage();
      const billing = createBillingUseCases({ repos, uow, paymentProvider: createTestPaymentProvider() });
      const contacts = createContactUseCases({ repos, uow });
      const useCases = createDocumentUseCases({
        repos,
        uow,
        objectStorage: storage,
        billing,
        contacts,
        ocrEngine: createFakeOcrEngine(),
        analyzer: createFakeDocumentAnalyzer(),
      intakeClassifier: createFakeIntakeClassifier(),
    });

      // Free tier: total limit 20, no monthly limit. Fill 15 slots (75%) directly, so the
      // 16th document crosses 80% - fire two concurrent uploads right at that crossing.
      for (let i = 0; i < 15; i += 1) {
        await useCases.createFromUpload({
          workspaceId: workspace.id,
          uploadedByUserId: null,
          originalFileName: `seed-${i}.pdf`,
          bytes: new Uint8Array([1]),
          mimeType: "application/pdf",
          extension: "pdf",
          pageCount: 1,
          fileHash: crypto.randomUUID(),
        });
      }

      await Promise.all([
        useCases.createFromUpload({
          workspaceId: workspace.id,
          uploadedByUserId: null,
          originalFileName: "race-a.pdf",
          bytes: new Uint8Array([1]),
          mimeType: "application/pdf",
          extension: "pdf",
          pageCount: 1,
          fileHash: crypto.randomUUID(),
        }),
        useCases.createFromUpload({
          workspaceId: workspace.id,
          uploadedByUserId: null,
          originalFileName: "race-b.pdf",
          bytes: new Uint8Array([1]),
          mimeType: "application/pdf",
          extension: "pdf",
          pageCount: 1,
          fileHash: crypto.randomUUID(),
        }),
      ]);

      expect(await repos.document.countByWorkspace(workspace.id)).toBe(17);

      const warningJobs = await db.select().from(jobs).where(eq(jobs.workspaceId, workspace.id));
      const quotaWarnings = warningJobs.filter((j) => j.kind === "send-quota-warning");
      expect(quotaWarnings).toHaveLength(1);
      expect(quotaWarnings[0]?.payload).toMatchObject({ limit: "total" });
    },
  );

  it(
    "serializes two concurrent creates at the MONTHLY limit (starter tier, one slot left): " +
      "exactly one succeeds (P6 review finding D2)",
    async () => {
      const workspaceRepo = createDrizzleWorkspaceRepository(db);
      const workspace = await workspaceRepo.create({ name: "Monthly Concurrency Co" });
      await db.execute(sql`update workspaces set tier = 'starter' where id = ${workspace.id}`);

      const repos = createDrizzleRepositories(db);
      const uow = createDrizzleUnitOfWork(db);
      const { storage } = createFakeObjectStorage();
      const billing = createBillingUseCases({ repos, uow, paymentProvider: createTestPaymentProvider() });
      const contacts = createContactUseCases({ repos, uow });
      const useCases = createDocumentUseCases({
        repos,
        uow,
        objectStorage: storage,
        billing,
        contacts,
        ocrEngine: createFakeOcrEngine(),
        analyzer: createFakeDocumentAnalyzer(),
      intakeClassifier: createFakeIntakeClassifier(),
    });

      // Starter tier: monthly limit 100, total limit 750 (well above what this test creates,
      // so only the monthly limit can bind here). Fill 99 slots this month directly, so
      // exactly one more upload fits before the monthly limit - not the total limit - would
      // reject.
      for (let i = 0; i < 99; i += 1) {
        await useCases.createFromUpload({
          workspaceId: workspace.id,
          uploadedByUserId: null,
          originalFileName: `seed-${i}.pdf`,
          bytes: new Uint8Array([1]),
          mimeType: "application/pdf",
          extension: "pdf",
          pageCount: 1,
          fileHash: crypto.randomUUID(),
        });
      }

      const results = await Promise.allSettled([
        useCases.createFromUpload({
          workspaceId: workspace.id,
          uploadedByUserId: null,
          originalFileName: "race-a.pdf",
          bytes: new Uint8Array([1]),
          mimeType: "application/pdf",
          extension: "pdf",
          pageCount: 1,
          fileHash: crypto.randomUUID(),
        }),
        useCases.createFromUpload({
          workspaceId: workspace.id,
          uploadedByUserId: null,
          originalFileName: "race-b.pdf",
          bytes: new Uint8Array([1]),
          mimeType: "application/pdf",
          extension: "pdf",
          pageCount: 1,
          fileHash: crypto.randomUUID(),
        }),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: DOCUMENT_ERROR.quotaMonthlyExceeded });

      // Exactly 100 documents created this month - the monthly limit, not one over it - and
      // the total document count (well under the 750 total limit) matches.
      expect(await repos.document.countByWorkspace(workspace.id)).toBe(100);
    },
  );
});
