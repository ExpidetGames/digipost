// Owner-crossing integration test (WEBAPP_TEMPLATE_SPEC.md §10.1) for the P6 review finding
// that `POST /api/documents` never actually triggered processing, even though
// decisions/0016-processing-pipeline-and-ai.md and `src/modules/documents/actions.ts` both
// claimed it called `after(() => runDueJobs(...))`: before the fix, a freshly uploaded
// document only started processing once a client happened to mount the polling component
// (`kickProcessingAction`) or a cron sweep ran.
//
// `next/server`'s real `after()` throws when called outside an active request scope
// (Next's `workUnitAsyncStorage`), which does not exist when this exported `POST` function
// is invoked directly in a test harness rather than through Next's own request dispatch -
// exactly like `src/modules/documents/tests/actions.test.ts`'s unit tests already do for
// the Server Actions, this test mocks `next/server` to capture the scheduled callback
// instead. Running ONLY that captured callback - never `kickProcessingAction`, never
// `GET /api/cron/process-jobs` - proves the upload route's own trigger is sufficient by
// itself for a document to reach `done`.
import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

let currentUser: { id: string; email: string } | null = null;
vi.mock("@/platform/auth/server", () => ({
  getCurrentUser: async () => currentUser,
}));

const afterCallbacks: Array<() => unknown> = [];
vi.mock("next/server", () => ({
  after: (cb: () => unknown) => {
    afterCallbacks.push(cb);
  },
}));

vi.mock("next/cache", () => ({
  revalidatePath: () => {},
}));

import { getDb } from "@/persistence/foundation/client";
import { createDrizzleDocumentRepository } from "@/persistence/repositories/drizzle/documents-repository";
import {
  createDrizzleWorkspaceMemberRepository,
  createDrizzleWorkspaceRepository,
} from "@/persistence/repositories/drizzle/workspaces-repository";
import { user } from "@/persistence/schema/auth";

import { POST } from "@/app/api/documents/route";

const PNG_1X1_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function pngFile(name = "seite-1.png"): File {
  return new File([Buffer.from(PNG_1X1_B64, "base64")], name, { type: "image/png" });
}

async function createTestUser(): Promise<{ id: string; email: string }> {
  const email = `${randomUUID()}@example.test`;
  const [row] = await getDb().insert(user).values({ name: "After Trigger Test User", email, emailVerified: false }).returning({ id: user.id });
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

describe("POST /api/documents schedules its own after() processing trigger", () => {
  it("reaches done from the route's own after() callback alone (no kick action, no cron route)", async () => {
    const founder = await createTestUser();
    currentUser = founder;
    const workspace = await createWorkspaceForUser(founder.id, "Auto Trigger GmbH");

    const formData = new FormData();
    formData.append("files", pngFile());
    formData.append("fileName", "rechnung-telekom.pdf");

    const callbacksBefore = afterCallbacks.length;
    const uploadResponse = await POST(postRequest(formData), {} as never);
    expect(uploadResponse.status).toBe(201);
    const { documentId } = (await uploadResponse.json()) as { documentId: string };

    // The route scheduled exactly one after() callback for this upload - this is the bug
    // this test guards against: before the fix, afterCallbacks stayed empty.
    expect(afterCallbacks.length).toBe(callbacksBefore + 1);

    const documentRepo = createDrizzleDocumentRepository(getDb());
    const uploaded = await documentRepo.findById(workspace.id, documentId);
    expect(uploaded?.status).toBe("uploaded");

    // Run ONLY the callback the route itself scheduled - never kickProcessingAction, never
    // the cron route - proving the route's own after() trigger is sufficient by itself.
    await afterCallbacks[afterCallbacks.length - 1]!();

    const processed = await documentRepo.findById(workspace.id, documentId);
    expect(processed?.status).toBe("done");
    expect(processed?.errorCode).toBeNull();
  });

  it("does not schedule an after() callback when the upload is rejected", async () => {
    const founder = await createTestUser();
    currentUser = founder;
    await createWorkspaceForUser(founder.id, "Rejected Upload GmbH");

    const formData = new FormData();
    formData.append("files", new File([new Uint8Array([1, 2, 3, 4])], "not-a-file.bin", { type: "application/octet-stream" }));

    const callbacksBefore = afterCallbacks.length;
    const response = await POST(postRequest(formData), {} as never);
    expect(response.status).toBe(415);
    expect(afterCallbacks.length).toBe(callbacksBefore);
  });
});
