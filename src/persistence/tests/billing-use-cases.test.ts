// Unit tests for createBillingUseCases (WEBAPP_TEMPLATE_SPEC.md §10.2): typed fakes via
// dependency injection, no DB. Covers `changeTier` (unknown tier, downgrade below the
// stored count, test-mode gating), `purchasePackage` (Free rejected, test-mode gating), and
// `recordDocumentsCreated`'s warning-crossing/enqueue/reset behavior
// (decisions/0017-billing-tiers-and-packages.md).
import { describe, expect, it } from "vitest";

import { createNotConfiguredPaymentProvider, createTestPaymentProvider } from "@/modules/billing";
import { createFakeBillingRepository, monthlyUsageRow } from "@/persistence/tests/support/fake-billing-repositories";
import { createFakeDocumentRepository, documentRow } from "@/persistence/tests/support/fake-documents-repositories";
import { createFakeJobsRepository } from "@/persistence/tests/support/fake-jobs-repository";
import { createFakeWorkspaceRepository, workspaceRow } from "@/persistence/tests/support/fake-workspaces-repositories";
import { withUnusedRepositories } from "@/persistence/tests/support/unused-repositories";
import type { Repositories, UnitOfWork } from "@/persistence/repositories/contracts";
import { BILLING_ERROR, createBillingUseCases } from "@/persistence/use-cases/billing-use-cases";

const FIXED_NOW = new Date("2026-03-15T00:00:00.000Z");

function setup(options: {
  workspaces?: Parameters<typeof createFakeWorkspaceRepository>[0];
  documents?: Parameters<typeof createFakeDocumentRepository>[0];
  usage?: Parameters<typeof createFakeBillingRepository>[0];
  purchases?: Parameters<typeof createFakeBillingRepository>[1];
  testMode?: boolean;
} = {}) {
  const { repo: workspace, state: workspaceState } = createFakeWorkspaceRepository(options.workspaces);
  const { repo: document } = createFakeDocumentRepository(options.documents);
  const { repo: billing, usageState, purchasesState, tierChangesState } = createFakeBillingRepository(options.usage, options.purchases);
  const { repo: jobs } = createFakeJobsRepository();

  const repos: Repositories = withUnusedRepositories({ workspace, document, billing, jobs });
  const uow: UnitOfWork = { transaction: (work) => work(repos) };

  const paymentProvider = options.testMode === false ? createNotConfiguredPaymentProvider() : createTestPaymentProvider();

  const useCases = createBillingUseCases({ repos, uow, paymentProvider, now: () => FIXED_NOW });

  return { useCases, workspaceState, usageState, purchasesState, tierChangesState };
}

/** `recordDocumentsCreated` always receives an explicit, transaction-bound `Repositories`
 * (`documents-use-cases.ts`'s own convention) - this helper builds a fresh, minimal set for
 * each test rather than reusing `setup()`'s request-scoped one. */
function setupRecordDocumentsCreated(usageSeed?: Parameters<typeof createFakeBillingRepository>[0]) {
  const workspace = workspaceRow({ name: "Muster GmbH", tier: "free" });
  const { repo: workspaceRepo } = createFakeWorkspaceRepository([workspace]);
  const { repo: billingRepo, usageState } = createFakeBillingRepository(usageSeed);
  const { repo: jobsRepo, state: jobState } = createFakeJobsRepository();
  const repos: Repositories = withUnusedRepositories({ workspace: workspaceRepo, billing: billingRepo, jobs: jobsRepo });
  const uow: UnitOfWork = { transaction: (work) => work(repos) };
  const useCases = createBillingUseCases({ repos, uow, paymentProvider: createTestPaymentProvider(), now: () => FIXED_NOW });
  return { useCases, workspace, repos, usageState, jobState };
}

describe("createBillingUseCases", () => {
  describe("changeTier", () => {
    it("upgrades the tier and records a ledger entry", async () => {
      const workspace = workspaceRow({ name: "Muster GmbH", tier: "free" });
      const { useCases, workspaceState, tierChangesState } = setup({ workspaces: [workspace] });

      const result = await useCases.changeTier({ workspaceId: workspace.id, newTier: "starter", actingUserId: "u1" });

      expect(result).toEqual({ tier: "starter" });
      expect(workspaceState[0]?.tier).toBe("starter");
      expect(tierChangesState).toHaveLength(1);
      expect(tierChangesState[0]).toMatchObject({ previousTier: "free", newTier: "starter", provider: "test" });
    });

    it("rejects an unknown tier", async () => {
      const workspace = workspaceRow({ name: "Muster GmbH", tier: "free" });
      const { useCases } = setup({ workspaces: [workspace] });

      await expect(
        // @ts-expect-error deliberately invalid input, exercising the use case's own defense
        useCases.changeTier({ workspaceId: workspace.id, newTier: "enterprise", actingUserId: "u1" }),
      ).rejects.toMatchObject({ code: BILLING_ERROR.unknownTier });
    });

    it("rejects a downgrade whose total limit is below the stored document count", async () => {
      const workspace = workspaceRow({ name: "Muster GmbH", tier: "pro" });
      const documents = Array.from({ length: 25 }, (_, i) => documentRow({ workspaceId: workspace.id, storageKey: `k${i}` }));
      const { useCases, workspaceState } = setup({ workspaces: [workspace], documents });

      // free's total limit (20) is below the 25 documents currently stored.
      await expect(useCases.changeTier({ workspaceId: workspace.id, newTier: "free", actingUserId: "u1" })).rejects.toMatchObject({
        code: BILLING_ERROR.downgradeBelowStoredCount,
      });
      expect(workspaceState[0]?.tier).toBe("pro"); // unchanged
    });

    it("allows a downgrade whose total limit is still above the stored document count", async () => {
      const workspace = workspaceRow({ name: "Muster GmbH", tier: "pro" });
      const documents = Array.from({ length: 5 }, (_, i) => documentRow({ workspaceId: workspace.id, storageKey: `k${i}` }));
      const { useCases, workspaceState } = setup({ workspaces: [workspace], documents });

      await useCases.changeTier({ workspaceId: workspace.id, newTier: "free", actingUserId: "u1" });
      expect(workspaceState[0]?.tier).toBe("free");
    });

    it("refuses with billing_not_configured when test mode is off, even for a valid upgrade", async () => {
      const workspace = workspaceRow({ name: "Muster GmbH", tier: "free" });
      const { useCases } = setup({ workspaces: [workspace], testMode: false });

      await expect(useCases.changeTier({ workspaceId: workspace.id, newTier: "starter", actingUserId: "u1" })).rejects.toMatchObject({
        code: BILLING_ERROR.notConfigured,
      });
    });

    it("resets both warning markers for the current period", async () => {
      const workspace = workspaceRow({ name: "Muster GmbH", tier: "starter" });
      const usage = [
        monthlyUsageRow({
          workspaceId: workspace.id,
          period: "2026-03-01",
          documentsCreated: 90,
          warnedTotalAt: new Date("2026-03-10"),
          warnedMonthlyAt: new Date("2026-03-10"),
        }),
      ];
      const { useCases, usageState } = setup({ workspaces: [workspace], usage });

      await useCases.changeTier({ workspaceId: workspace.id, newTier: "pro", actingUserId: "u1" });

      expect(usageState[0]?.warnedTotalAt).toBeNull();
      expect(usageState[0]?.warnedMonthlyAt).toBeNull();
    });
  });

  describe("purchasePackage", () => {
    it("rejects a purchase on Free", async () => {
      const workspace = workspaceRow({ name: "Muster GmbH", tier: "free" });
      const { useCases } = setup({ workspaces: [workspace] });

      await expect(useCases.purchasePackage({ workspaceId: workspace.id, packageKey: "s", actingUserId: "u1" })).rejects.toMatchObject({
        code: BILLING_ERROR.packagesNotAvailableOnFree,
      });
    });

    it("records the purchase for starter and above", async () => {
      const workspace = workspaceRow({ name: "Muster GmbH", tier: "starter" });
      const { useCases, purchasesState } = setup({ workspaces: [workspace] });

      const purchase = await useCases.purchasePackage({ workspaceId: workspace.id, packageKey: "m", actingUserId: "u1" });

      expect(purchase).toMatchObject({ packageKey: "m", extraDocuments: 1000, priceEurCents: 5900, provider: "test" });
      expect(purchasesState).toHaveLength(1);
    });

    it("resets only the monthly warning marker (a package never raises the total limit)", async () => {
      const workspace = workspaceRow({ name: "Muster GmbH", tier: "starter" });
      const usage = [
        monthlyUsageRow({
          workspaceId: workspace.id,
          period: "2026-03-01",
          documentsCreated: 90,
          warnedTotalAt: new Date("2026-03-10"),
          warnedMonthlyAt: new Date("2026-03-10"),
        }),
      ];
      const { useCases, usageState } = setup({ workspaces: [workspace], usage });

      await useCases.purchasePackage({ workspaceId: workspace.id, packageKey: "s", actingUserId: "u1" });

      expect(usageState[0]?.warnedMonthlyAt).toBeNull();
      expect(usageState[0]?.warnedTotalAt).not.toBeNull(); // untouched
    });

    it("refuses with billing_not_configured when test mode is off", async () => {
      const workspace = workspaceRow({ name: "Muster GmbH", tier: "starter" });
      const { useCases } = setup({ workspaces: [workspace], testMode: false });

      await expect(useCases.purchasePackage({ workspaceId: workspace.id, packageKey: "s", actingUserId: "u1" })).rejects.toMatchObject({
        code: BILLING_ERROR.notConfigured,
      });
    });
  });

  describe("recordDocumentsCreated (80% warning crossing)", () => {
    it("enqueues a send-quota-warning job and sets warnedTotalAt on first crossing", async () => {
      const { useCases, workspace, repos, usageState, jobState } = setupRecordDocumentsCreated();

      await useCases.recordDocumentsCreated(repos, {
        workspaceId: workspace.id,
        period: "2026-03-01",
        count: 16, // 16/20 = 80%
        totalRatio: 0.8,
        monthlyRatio: null,
      });

      expect(usageState[0]?.warnedTotalAt).not.toBeNull();
      expect(jobState).toHaveLength(1);
      expect(jobState[0]?.kind).toBe("send-quota-warning");
      expect(jobState[0]?.payload).toMatchObject({ workspaceId: workspace.id, limit: "total" });
    });

    it("never enqueues twice: a marker already set suppresses a further crossing", async () => {
      const workspace = workspaceRow({ name: "Muster GmbH", tier: "free" });
      const usage = [
        monthlyUsageRow({ workspaceId: workspace.id, period: "2026-03-01", documentsCreated: 16, warnedTotalAt: new Date() }),
      ];
      const { useCases, repos, jobState } = setupRecordDocumentsCreated(usage);

      await useCases.recordDocumentsCreated(repos, {
        workspaceId: workspace.id,
        period: "2026-03-01",
        count: 1,
        totalRatio: 0.85,
        monthlyRatio: null,
      });

      expect(jobState).toHaveLength(0);
    });

    it("enqueues both a total and a monthly warning when both cross at once", async () => {
      const { useCases, workspace, repos, usageState, jobState } = setupRecordDocumentsCreated();

      await useCases.recordDocumentsCreated(repos, {
        workspaceId: workspace.id,
        period: "2026-03-01",
        count: 80,
        totalRatio: 0.9,
        monthlyRatio: 0.9,
      });

      expect(jobState.map((j) => j.payload)).toEqual(
        expect.arrayContaining([expect.objectContaining({ limit: "total" }), expect.objectContaining({ limit: "monthly" })]),
      );
      expect(usageState[0]?.warnedTotalAt).not.toBeNull();
      expect(usageState[0]?.warnedMonthlyAt).not.toBeNull();
    });

    it("does not enqueue below the 80% threshold", async () => {
      const { useCases, workspace, repos, jobState } = setupRecordDocumentsCreated();

      await useCases.recordDocumentsCreated(repos, {
        workspaceId: workspace.id,
        period: "2026-03-01",
        count: 5,
        totalRatio: 0.25,
        monthlyRatio: null,
      });

      expect(jobState).toHaveLength(0);
    });
  });
});
