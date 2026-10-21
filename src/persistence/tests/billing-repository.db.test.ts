// Real Postgres (WEBAPP_TEMPLATE_SPEC.md §10.1/§10.3).
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { getDb } from "@/persistence/foundation/client";
import { createDrizzleBillingRepository } from "@/persistence/repositories/drizzle/billing-repository";
import { createDrizzleWorkspaceRepository } from "@/persistence/repositories/drizzle/workspaces-repository";
import { quotaPackagePurchases, workspaceTierChanges } from "@/persistence/schema/billing";
import { user } from "@/persistence/schema/auth";
import { randomUUID } from "node:crypto";

const db = getDb();

async function createTestWorkspace(name: string) {
  return createDrizzleWorkspaceRepository(db).create({ name });
}

async function createTestUser(label = "user") {
  const email = `${label}-${randomUUID()}@example.test`;
  const [row] = await db.insert(user).values({ name: "Test User", email, emailVerified: false }).returning({ id: user.id });
  if (!row) throw new Error("failed to insert test user fixture");
  return row;
}

describe("createDrizzleBillingRepository", () => {
  it("findMonthlyUsage returns null when no row exists yet", async () => {
    const workspace = await createTestWorkspace("Usage Co A");
    const repo = createDrizzleBillingRepository(db);
    expect(await repo.findMonthlyUsage(workspace.id, "2026-03-01")).toBeNull();
  });

  it("incrementDocumentsCreated upserts: creates the row, then adds to it", async () => {
    const workspace = await createTestWorkspace("Usage Co B");
    const repo = createDrizzleBillingRepository(db);

    const first = await repo.incrementDocumentsCreated(workspace.id, "2026-03-01", 1);
    expect(first.documentsCreated).toBe(1);

    const second = await repo.incrementDocumentsCreated(workspace.id, "2026-03-01", 1);
    expect(second.documentsCreated).toBe(2);

    expect(await repo.findMonthlyUsage(workspace.id, "2026-03-01")).toMatchObject({ documentsCreated: 2 });
  });

  it("increments are scoped per period: a different period gets its own row", async () => {
    const workspace = await createTestWorkspace("Usage Co C");
    const repo = createDrizzleBillingRepository(db);

    await repo.incrementDocumentsCreated(workspace.id, "2026-03-01", 5);
    await repo.incrementDocumentsCreated(workspace.id, "2026-04-01", 1);

    expect(await repo.findMonthlyUsage(workspace.id, "2026-03-01")).toMatchObject({ documentsCreated: 5 });
    expect(await repo.findMonthlyUsage(workspace.id, "2026-04-01")).toMatchObject({ documentsCreated: 1 });
  });

  it("sumExtraDocumentsForPeriod sums only the matching workspace and period", async () => {
    const workspace = await createTestWorkspace("Usage Co D");
    const otherWorkspace = await createTestWorkspace("Usage Co E");
    const purchaser = await createTestUser("purchaser");
    const repo = createDrizzleBillingRepository(db);

    await db.insert(quotaPackagePurchases).values([
      {
        workspaceId: workspace.id,
        packageKey: "s",
        extraDocuments: 250,
        priceCents: 1900,
        period: "2026-03-01",
        purchasedByUserId: purchaser.id,
        provider: "test",
      },
      {
        workspaceId: workspace.id,
        packageKey: "m",
        extraDocuments: 1000,
        priceCents: 5900,
        period: "2026-03-01",
        purchasedByUserId: purchaser.id,
        provider: "test",
      },
      {
        workspaceId: workspace.id,
        packageKey: "l",
        extraDocuments: 5000,
        priceCents: 24_900,
        period: "2026-04-01",
        purchasedByUserId: purchaser.id,
        provider: "test",
      },
      {
        workspaceId: otherWorkspace.id,
        packageKey: "l",
        extraDocuments: 5000,
        priceCents: 24_900,
        period: "2026-03-01",
        purchasedByUserId: purchaser.id,
        provider: "test",
      },
    ]);

    expect(await repo.sumExtraDocumentsForPeriod(workspace.id, "2026-03-01")).toBe(1250);
    expect(await repo.sumExtraDocumentsForPeriod(workspace.id, "2026-04-01")).toBe(5000);
    expect(await repo.sumExtraDocumentsForPeriod(workspace.id, "2026-05-01")).toBe(0);
  });

  it("insertPurchase + listPurchasesForPeriod: scoped by workspace and period, newest first", async () => {
    const workspace = await createTestWorkspace("Purchases Co A");
    const otherWorkspace = await createTestWorkspace("Purchases Co B");
    const purchaser = await createTestUser("purchaser");
    const repo = createDrizzleBillingRepository(db);

    const first = await repo.insertPurchase({
      workspaceId: workspace.id,
      packageKey: "s",
      extraDocuments: 250,
      priceCents: 1900,
      period: "2026-03-01",
      purchasedByUserId: purchaser.id,
      provider: "test",
    });
    const second = await repo.insertPurchase({
      workspaceId: workspace.id,
      packageKey: "m",
      extraDocuments: 1000,
      priceCents: 5900,
      period: "2026-03-01",
      purchasedByUserId: purchaser.id,
      provider: "test",
    });
    await repo.insertPurchase({
      workspaceId: workspace.id,
      packageKey: "l",
      extraDocuments: 5000,
      priceCents: 24_900,
      period: "2026-04-01",
      purchasedByUserId: purchaser.id,
      provider: "test",
    });
    await repo.insertPurchase({
      workspaceId: otherWorkspace.id,
      packageKey: "l",
      extraDocuments: 5000,
      priceCents: 24_900,
      period: "2026-03-01",
      purchasedByUserId: purchaser.id,
      provider: "test",
    });

    const list = await repo.listPurchasesForPeriod(workspace.id, "2026-03-01");
    expect(list.map((p) => p.id).sort()).toEqual([first.id, second.id].sort());
  });

  it("insertTierChange records the ledger row", async () => {
    const workspace = await createTestWorkspace("Tier Co A");
    const admin = await createTestUser("admin");
    const repo = createDrizzleBillingRepository(db);

    const row = await repo.insertTierChange({
      workspaceId: workspace.id,
      previousTier: "free",
      newTier: "starter",
      changedByUserId: admin.id,
      provider: "test",
    });

    expect(row).toMatchObject({ workspaceId: workspace.id, previousTier: "free", newTier: "starter", provider: "test" });
  });

  it(
    "quota_package_purchases and workspace_tier_changes survive the purchasing/changing " +
      "user's account being deleted: the row stays, purchasedByUserId/changedByUserId " +
      "become null (P6 review finding A9)",
    async () => {
      const workspace = await createTestWorkspace("Deleted User FK Co");
      const actor = await createTestUser("actor");
      const repo = createDrizzleBillingRepository(db);

      const purchase = await repo.insertPurchase({
        workspaceId: workspace.id,
        packageKey: "s",
        extraDocuments: 250,
        priceCents: 1900,
        period: "2026-03-01",
        purchasedByUserId: actor.id,
        provider: "test",
      });
      const tierChange = await repo.insertTierChange({
        workspaceId: workspace.id,
        previousTier: "free",
        newTier: "starter",
        changedByUserId: actor.id,
        provider: "test",
      });

      // Deleting the user (paid capacity and audit rows must not cascade-delete with them -
      // before the fix, this `db.delete` would have deleted `purchase` and `tierChange` too).
      await db.delete(user).where(eq(user.id, actor.id));

      const [purchaseRow] = await db
        .select()
        .from(quotaPackagePurchases)
        .where(eq(quotaPackagePurchases.id, purchase.id));
      expect(purchaseRow).toMatchObject({ id: purchase.id, extraDocuments: 250, purchasedByUserId: null });

      const [tierChangeRow] = await db.select().from(workspaceTierChanges).where(eq(workspaceTierChanges.id, tierChange.id));
      expect(tierChangeRow).toMatchObject({ id: tierChange.id, newTier: "starter", changedByUserId: null });

      // The monthly quota computed from this table is unaffected by the purchaser's account
      // being gone - it must still count towards the workspace's capacity.
      expect(await repo.sumExtraDocumentsForPeriod(workspace.id, "2026-03-01")).toBe(250);
    },
  );

  it("markWarned sets only the requested marker(s), clearWarnings nulls them again", async () => {
    const workspace = await createTestWorkspace("Warnings Co A");
    const repo = createDrizzleBillingRepository(db);
    await repo.incrementDocumentsCreated(workspace.id, "2026-03-01", 16);

    const warnedAt = new Date("2026-03-15T00:00:00.000Z");
    await repo.markWarned(workspace.id, "2026-03-01", { total: true }, warnedAt);

    let row = await repo.findMonthlyUsage(workspace.id, "2026-03-01");
    expect(row?.warnedTotalAt?.toISOString()).toBe(warnedAt.toISOString());
    expect(row?.warnedMonthlyAt).toBeNull();

    await repo.markWarned(workspace.id, "2026-03-01", { monthly: true }, warnedAt);
    row = await repo.findMonthlyUsage(workspace.id, "2026-03-01");
    expect(row?.warnedMonthlyAt?.toISOString()).toBe(warnedAt.toISOString());

    await repo.clearWarnings(workspace.id, "2026-03-01", { total: true, monthly: true });
    row = await repo.findMonthlyUsage(workspace.id, "2026-03-01");
    expect(row?.warnedTotalAt).toBeNull();
    expect(row?.warnedMonthlyAt).toBeNull();
  });

  it("clearWarnings is a no-op when no usage row exists yet for the period", async () => {
    const workspace = await createTestWorkspace("Warnings Co B");
    const repo = createDrizzleBillingRepository(db);
    await expect(repo.clearWarnings(workspace.id, "2026-03-01", { total: true })).resolves.toBeUndefined();
  });
});
