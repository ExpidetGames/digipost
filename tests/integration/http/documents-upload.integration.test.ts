// Owner-crossing integration test (WEBAPP_TEMPLATE_SPEC.md §10.1): the real
// `POST /api/documents` route handler against real Postgres and real MinIO. The session
// (`@/platform/auth/server`) and `next/cache` are mocked, mirroring
// `tests/integration/workflows/workspaces-onboarding.integration.test.ts`'s pattern -
// `getRequestServices()`, `src/platform/access/server`'s `workspaceAccess`, and
// `src/platform/object-storage`'s real S3 client all run for real. `next/cache` needs
// mocking because the route calls `revalidatePath("/dashboard")` on success (P6 review
// finding A3: a fresh upload previously did not revalidate the inbox at all); calling this
// exported `POST` directly, outside Next's own request dispatch, has no request-scoped
// cache context for the real implementation to write to.
import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { vi } from "vitest";

let currentUser: { id: string; email: string } | null = null;
vi.mock("@/platform/auth/server", () => ({
  getCurrentUser: async () => currentUser,
}));

const revalidatePathMock = vi.fn();
vi.mock("next/cache", () => ({
  revalidatePath: (path: string) => revalidatePathMock(path),
}));

import { getDb } from "@/persistence/foundation/client";
import { createDrizzleWorkspaceMemberRepository, createDrizzleWorkspaceRepository } from "@/persistence/repositories/drizzle/workspaces-repository";
import { createDrizzleDocumentRepository } from "@/persistence/repositories/drizzle/documents-repository";
import { user } from "@/persistence/schema/auth";
import { getObjectStorage } from "@/platform/object-storage/server";
import { documentOriginalKey } from "@/platform/object-storage";

import { POST } from "@/app/api/documents/route";

const PNG_1X1_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function pngFile(name = "seite-1.png"): File {
  return new File([Buffer.from(PNG_1X1_B64, "base64")], name, { type: "image/png" });
}

async function createTestUser(): Promise<{ id: string; email: string }> {
  const email = `${randomUUID()}@example.test`;
  const [row] = await getDb().insert(user).values({ name: "Upload Test User", email, emailVerified: false }).returning({ id: user.id });
  if (!row) throw new Error("failed to insert test user fixture");
  return { id: row.id, email };
}

async function createWorkspaceForUser(userId: string, name: string, tier: "free" | "starter" = "free") {
  const workspaceRepo = createDrizzleWorkspaceRepository(getDb());
  const memberRepo = createDrizzleWorkspaceMemberRepository(getDb());
  const workspace = await workspaceRepo.create({ name });
  if (tier !== "free") {
    await getDb().execute(sql`update workspaces set tier = ${tier} where id = ${workspace.id}`);
  }
  await memberRepo.create({ workspaceId: workspace.id, userId, role: "admin" });
  return workspace;
}

function postRequest(formData: FormData): Request {
  return new Request("http://localhost/api/documents", { method: "POST", body: formData });
}

describe("POST /api/documents (real Postgres + MinIO)", () => {
  it("assembles an image set into a PDF, stores it, creates the row, and revalidates the inbox", async () => {
    const founder = await createTestUser();
    currentUser = founder;
    const workspace = await createWorkspaceForUser(founder.id, "Upload Flow GmbH");

    revalidatePathMock.mockClear();
    const formData = new FormData();
    formData.append("files", pngFile());
    formData.append("fileName", "Meine Rechnung");

    const response = await POST(postRequest(formData), {} as never);
    expect(response.status).toBe(201);
    const body = (await response.json()) as { documentId: string };
    expect(body.documentId).toBeTruthy();

    // P6 review finding A3: a fresh upload previously never revalidated "/dashboard", so it
    // could fail to show up in the inbox without a hard refresh.
    expect(revalidatePathMock).toHaveBeenCalledWith("/dashboard");

    const documentRepo = createDrizzleDocumentRepository(getDb());
    const stored = await documentRepo.findById(workspace.id, body.documentId);
    expect(stored).toMatchObject({ originalFileName: "Meine Rechnung", mimeType: "application/pdf", pageCount: 1 });

    const key = documentOriginalKey({ workspaceId: workspace.id, documentId: body.documentId });
    const objectBytes = await getObjectStorage().getObject(key);
    expect(objectBytes.byteLength).toBeGreaterThan(0);
  });

  it("rejects an unsupported file type with 415", async () => {
    const founder = await createTestUser();
    currentUser = founder;
    await createWorkspaceForUser(founder.id, "Wrong Type GmbH");

    const formData = new FormData();
    formData.append("files", new File([new Uint8Array([1, 2, 3, 4])], "not-a-file.bin", { type: "application/octet-stream" }));

    const response = await POST(postRequest(formData), {} as never);
    expect(response.status).toBe(415);
    expect(await response.json()).toEqual({ errorCode: "unsupported_file_type" });
  });

  it("rejects a request over the size limit with 413", async () => {
    const founder = await createTestUser();
    currentUser = founder;
    await createWorkspaceForUser(founder.id, "Too Large GmbH");

    const formData = new FormData();
    formData.append("files", new File([new Uint8Array(5 * 1024 * 1024)], "huge.png", { type: "image/png" }));

    const response = await POST(postRequest(formData), {} as never);
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ errorCode: "file_too_large" });
  });

  it(
    "rejects an oversized chunked request (no Content-Length header) with 413, aborting the " +
      "body stream instead of buffering all of it (P6 review finding B1)",
    async () => {
      const founder = await createTestUser();
      currentUser = founder;
      await createWorkspaceForUser(founder.id, "Chunked Too Large GmbH");

      // A streaming body with no Content-Length at all (like a real chunked-transfer-encoding
      // request, or one with a spoofed/absent length): the route's only pre-parse defense
      // before B1's fix was the optional Content-Length pre-check, which a request like this
      // one entirely skips.
      const chunkBytes = 1024 * 1024; // 1 MiB
      const totalChunksIfFullyRead = 200; // 200 MiB if ever fully consumed
      let chunksPulled = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (chunksPulled >= totalChunksIfFullyRead) {
            controller.close();
            return;
          }
          chunksPulled += 1;
          controller.enqueue(new Uint8Array(chunkBytes));
        },
      });
      const boundary = "----digipostTestBoundary";
      const request = new Request("http://localhost/api/documents", {
        method: "POST",
        headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
        body,
        duplex: "half",
      } as RequestInit);
      expect(request.headers.get("content-length")).toBeNull();

      const response = await POST(request, {} as never);
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({ errorCode: "file_too_large" });

      // The route stopped reading the stream soon after crossing the 4 MB cap - it never
      // buffered anywhere near the full 200 MiB the client offered to send.
      expect(chunksPulled).toBeLessThan(10);
    },
  );

  it("rejects an upload once the workspace is at its total quota, with 402", async () => {
    const founder = await createTestUser();
    currentUser = founder;
    const workspace = await createWorkspaceForUser(founder.id, "Quota GmbH");
    const documentRepo = createDrizzleDocumentRepository(getDb());
    for (let i = 0; i < 20; i += 1) {
      await documentRepo.create({
        id: randomUUID(),
        workspaceId: workspace.id,
        uploadedByUserId: null,
        originalFileName: `seed-${i}.pdf`,
        mimeType: "application/pdf",
        pageCount: 1,
        sizeBytes: 10,
        storageKey: `workspaces/${workspace.id}/documents/${randomUUID()}/original.pdf`,
        fileHash: randomUUID(),
      });
    }

    const formData = new FormData();
    formData.append("files", pngFile());

    const response = await POST(postRequest(formData), {} as never);
    expect(response.status).toBe(402);
    expect(await response.json()).toEqual({ errorCode: "quota_total_exceeded" });
  });

  it("rejects an unauthenticated request with 401", async () => {
    currentUser = null;
    const formData = new FormData();
    formData.append("files", pngFile());

    const response = await POST(postRequest(formData), {} as never);
    expect(response.status).toBe(401);
  });
});
