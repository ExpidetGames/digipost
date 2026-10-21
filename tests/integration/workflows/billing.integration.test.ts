// Owner-crossing integration test (WEBAPP_TEMPLATE_SPEC.md §10.1,
// decisions/0017-billing-tiers-and-packages.md): the real `POST /api/documents` route
// handler and the real `src/modules/billing/actions.ts` Server Actions against real
// Postgres and MinIO, with only the session (`@/platform/auth/server`) and `next/cache`
// mocked - `getRequestServices()`, the real (test-mode) `PaymentProvider`, and the real SMTP
// mailer (unmocked, unlike `workspaces-onboarding.integration.test.ts`'s mocked mailer) all
// run for real, so the last test below proves a warning e-mail actually reaches the test
// stack's Mailpit container over SMTP, not just that `Mailer.send` was called with the right
// arguments.
import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

let currentUser: { id: string; email: string } | null = null;
vi.mock("@/platform/auth/server", () => ({
  getCurrentUser: async () => currentUser,
}));

const revalidatePathMock = vi.fn();
vi.mock("next/cache", () => ({
  revalidatePath: (path: string) => revalidatePathMock(path),
}));

import { getDb } from "@/persistence/foundation/client";
import { createDrizzleDocumentRepository } from "@/persistence/repositories/drizzle/documents-repository";
import { createDrizzleWorkspaceMemberRepository, createDrizzleWorkspaceRepository } from "@/persistence/repositories/drizzle/workspaces-repository";
import { user } from "@/persistence/schema/auth";
import { changeTierAction, purchasePackageAction } from "@/modules/billing/actions";
import { getRequestServices } from "@/persistence/composition/request-services";
import { runDueJobs } from "@/platform/jobs/server";

import { POST } from "@/app/api/documents/route";

const PNG_1X1_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function pngFile(name = "seite-1.png"): File {
  return new File([Buffer.from(PNG_1X1_B64, "base64")], name, { type: "image/png" });
}

function postRequest(formData: FormData): Request {
  return new Request("http://localhost/api/documents", { method: "POST", body: formData });
}

async function createTestUser(label = "billing-user"): Promise<{ id: string; email: string }> {
  const email = `${label}-${randomUUID()}@example.test`;
  const [row] = await getDb().insert(user).values({ name: "Billing Test User", email, emailVerified: false }).returning({ id: user.id });
  if (!row) throw new Error("failed to insert test user fixture");
  return { id: row.id, email };
}

async function createWorkspaceForAdmin(userId: string, name: string) {
  const workspace = await createDrizzleWorkspaceRepository(getDb()).create({ name });
  await createDrizzleWorkspaceMemberRepository(getDb()).create({ workspaceId: workspace.id, userId, role: "admin" });
  return workspace;
}

async function seedDocuments(workspaceId: string, count: number, uploadedByUserId: string | null = null) {
  const documentRepo = createDrizzleDocumentRepository(getDb());
  for (let i = 0; i < count; i += 1) {
    await documentRepo.create({
      id: randomUUID(),
      workspaceId,
      uploadedByUserId,
      originalFileName: `seed-${i}.pdf`,
      mimeType: "application/pdf",
      pageCount: 1,
      sizeBytes: 10,
      storageKey: `workspaces/${workspaceId}/documents/${randomUUID()}/original.pdf`,
      fileHash: randomUUID(),
    });
  }
}

type MailpitMessage = { ID: string; To: { Address: string }[]; Subject: string };

/** Polls Mailpit's own HTTP API (`docker/compose.test.yml`'s `tests` service sets
 * `MAILPIT_API_URL`, the same value the `e2e` service already uses) for a message to
 * `email` whose subject contains `subjectContains` - proves the warning e-mail travelled
 * the real SMTP path (`src/platform/mailer/server`'s `createSmtpMailer`), not just that a
 * mock was called. */
async function waitForMailpitMessage(email: string, subjectContains: string, timeoutMs = 15_000): Promise<MailpitMessage> {
  const apiUrl = process.env.MAILPIT_API_URL ?? "http://localhost:8025";
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const res = await fetch(`${apiUrl}/api/v1/messages?limit=200`);
    if (res.ok) {
      const data = (await res.json()) as { messages: MailpitMessage[] };
      const match = data.messages.find((m) => m.To.some((to) => to.Address === email) && m.Subject.includes(subjectContains));
      if (match) return match;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  throw new Error(`Mailpit never received a message to ${email} with subject containing "${subjectContains}" within ${timeoutMs}ms`);
}

describe("billing flow (real Postgres + MinIO)", () => {
  it("free workspace at the total limit gets 402; upgrading (test mode) then lets the upload through", async () => {
    const admin = await createTestUser("upgrade-admin");
    currentUser = admin;
    const workspace = await createWorkspaceForAdmin(admin.id, "Upgrade Flow GmbH");
    await seedDocuments(workspace.id, 20, admin.id);

    const blockedForm = new FormData();
    blockedForm.append("files", pngFile());
    const blocked = await POST(postRequest(blockedForm), {} as never);
    expect(blocked.status).toBe(402);
    expect(await blocked.json()).toEqual({ errorCode: "quota_total_exceeded" });

    const tierResult = await changeTierAction({ tier: "starter" });
    expect(tierResult).toMatchObject({ status: "success", data: { tier: "starter" } });

    const allowedForm = new FormData();
    allowedForm.append("files", pngFile());
    const allowed = await POST(postRequest(allowedForm), {} as never);
    expect(allowed.status).toBe(201);
  });

  it("buying a package raises the effective monthly capacity for the current period", async () => {
    const admin = await createTestUser("package-admin");
    currentUser = admin;
    const workspace = await createWorkspaceForAdmin(admin.id, "Package Flow GmbH");

    // Packages are not purchasable on Free (product decision 6) - upgrade first.
    await changeTierAction({ tier: "starter" });

    const before = await getRequestServices().billing.getUsage(workspace.id);
    expect(before.extraMonthlyQuota).toBe(0);

    const purchaseResult = await purchasePackageAction({ packageKey: "s" });
    expect(purchaseResult).toMatchObject({ status: "success", data: { packageKey: "s", extraDocuments: 250 } });

    const after = await getRequestServices().billing.getUsage(workspace.id);
    expect(after.extraMonthlyQuota).toBe(250);
  });

  it("crossing the 80% warning threshold enqueues a job whose e-mail actually reaches Mailpit", async () => {
    const admin = await createTestUser("warning-admin");
    currentUser = admin;
    const workspace = await createWorkspaceForAdmin(admin.id, "Warning Flow GmbH");

    // Free tier: total limit 20. Seed 15 (75%), then upload one more via the real route so
    // the 16th document crosses 80% - exactly the path `createFromUpload` -> `billing.recordDocumentsCreated`
    // -> `evaluateWarningCrossing` takes in production.
    await seedDocuments(workspace.id, 15, admin.id);

    const formData = new FormData();
    formData.append("files", pngFile());
    const response = await POST(postRequest(formData), {} as never);
    expect(response.status).toBe(201);

    // The upload route's own `after()` never runs in a test - run the job queue directly,
    // exactly like the cron sweeper or the UI "kick" would (decisions/0016).
    await runDueJobs({ workspaceId: workspace.id, limit: 10 });

    const message = await waitForMailpitMessage(admin.email, "Speicherlimit");
    expect(message.Subject).toContain("Speicherlimit");
  });
});
