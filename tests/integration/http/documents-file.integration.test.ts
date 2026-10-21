// Owner-crossing integration test (WEBAPP_TEMPLATE_SPEC.md §10.1): the real
// `GET /api/documents/[id]/file` route handler against real Postgres and MinIO. Only the
// session is mocked, mirroring the sibling upload integration test.
import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

let currentUser: { id: string; email: string } | null = null;
vi.mock("@/platform/auth/server", () => ({
  getCurrentUser: async () => currentUser,
}));

import { getDb } from "@/persistence/foundation/client";
import { createDrizzleWorkspaceMemberRepository, createDrizzleWorkspaceRepository } from "@/persistence/repositories/drizzle/workspaces-repository";
import { createDrizzleDocumentRepository } from "@/persistence/repositories/drizzle/documents-repository";
import { user } from "@/persistence/schema/auth";
import { documentOriginalKey } from "@/platform/object-storage";
import { getObjectStorage } from "@/platform/object-storage/server";

import { GET } from "@/app/api/documents/[id]/file/route";

async function createTestUser(): Promise<{ id: string; email: string }> {
  const email = `${randomUUID()}@example.test`;
  const [row] = await getDb().insert(user).values({ name: "File Test User", email, emailVerified: false }).returning({ id: user.id });
  if (!row) throw new Error("failed to insert test user fixture");
  return { id: row.id, email };
}

async function createWorkspaceWithAdmin(userId: string, name: string) {
  const workspaceRepo = createDrizzleWorkspaceRepository(getDb());
  const memberRepo = createDrizzleWorkspaceMemberRepository(getDb());
  const workspace = await workspaceRepo.create({ name });
  await memberRepo.create({ workspaceId: workspace.id, userId, role: "admin" });
  return workspace;
}

async function createDocumentWithStoredPdf(workspaceId: string, fileName: string) {
  const documentId = randomUUID();
  const key = documentOriginalKey({ workspaceId, documentId });
  const body = new TextEncoder().encode("%PDF-1.7 fake pdf bytes");
  await getObjectStorage().putObject({ key, body, contentType: "application/pdf" });

  const documentRepo = createDrizzleDocumentRepository(getDb());
  await documentRepo.create({
    id: documentId,
    workspaceId,
    uploadedByUserId: null,
    originalFileName: fileName,
    mimeType: "application/pdf",
    pageCount: 1,
    sizeBytes: body.byteLength,
    storageKey: key,
    fileHash: randomUUID(),
  });
  return { documentId, body };
}

function fileRequest(id: string, download = false): { request: Request; context: { params: Promise<{ id: string }> } } {
  const url = `http://localhost/api/documents/${id}/file${download ? "?download=1" : ""}`;
  return { request: new Request(url), context: { params: Promise.resolve({ id }) } };
}

describe("GET /api/documents/[id]/file (real Postgres + MinIO)", () => {
  it("streams the stored PDF for the owning workspace", async () => {
    const founder = await createTestUser();
    currentUser = founder;
    const workspace = await createWorkspaceWithAdmin(founder.id, "File Owner GmbH");
    const { documentId, body } = await createDocumentWithStoredPdf(workspace.id, "Übernahme müller.pdf");

    const { request, context } = fileRequest(documentId);
    const response = await GET(request, context);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-disposition")).toContain("inline");
    expect(response.headers.get("content-disposition")).toContain("filename*=UTF-8''");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(body);
  });

  it("sets Content-Disposition: attachment when ?download=1", async () => {
    const founder = await createTestUser();
    currentUser = founder;
    const workspace = await createWorkspaceWithAdmin(founder.id, "Download GmbH");
    const { documentId } = await createDocumentWithStoredPdf(workspace.id, "brief.pdf");

    const { request, context } = fileRequest(documentId, true);
    const response = await GET(request, context);

    expect(response.headers.get("content-disposition")).toContain("attachment");
  });

  it("404s for a document belonging to a different workspace", async () => {
    const founder = await createTestUser();
    currentUser = founder;
    await createWorkspaceWithAdmin(founder.id, "Requester GmbH");

    const otherFounder = await createTestUser();
    const otherWorkspace = await createWorkspaceWithAdmin(otherFounder.id, "Other Co");
    const { documentId } = await createDocumentWithStoredPdf(otherWorkspace.id, "not-yours.pdf");

    const { request, context } = fileRequest(documentId);
    const response = await GET(request, context);

    expect(response.status).toBe(404);
  });

  it("rejects an unauthenticated request with 401", async () => {
    currentUser = null;
    const { request, context } = fileRequest(randomUUID());
    const response = await GET(request, context);
    expect(response.status).toBe(401);
  });
});
