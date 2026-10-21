// Owner-crossing integration test (WEBAPP_TEMPLATE_SPEC.md §10.1): the real
// `GET /api/cron/purge-rejected-intake` route handler against real Postgres and real MinIO
// (decisions/0027-hardening-and-deletion.md's retention cron) - proves the whole chain (find
// eligible documents -> enqueue a job per one -> run the job -> delete the row and its
// storage object) works end to end, not just each layer's own unit/DB test in isolation.
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { getDb } from "@/persistence/foundation/client";
import { createDrizzleDocumentRepository } from "@/persistence/repositories/drizzle/documents-repository";
import { createDrizzleWorkspaceRepository } from "@/persistence/repositories/drizzle/workspaces-repository";
import { documents } from "@/persistence/schema/documents";
import { documentOriginalKey, ObjectNotFoundError } from "@/platform/object-storage";
import { getObjectStorage } from "@/platform/object-storage/server";
import { serverEnv } from "@/platform/env/server";

import { GET } from "@/app/api/cron/purge-rejected-intake/route";

const db = getDb();

function requestWithAuth(): Request {
  return new Request("http://localhost/api/cron/purge-rejected-intake", {
    headers: { authorization: `Bearer ${serverEnv().CRON_SECRET}` },
  });
}

async function createRejectedDocument(workspaceId: string, updatedAt: Date): Promise<{ id: string; storageKey: string }> {
  const documentId = randomUUID();
  const storageKey = documentOriginalKey({ workspaceId, documentId, extension: "csv" });
  await getObjectStorage().putObject({ key: storageKey, body: new TextEncoder().encode("a,b,c"), contentType: "text/csv" });
  const repo = createDrizzleDocumentRepository(db);
  await repo.create({
    id: documentId,
    workspaceId,
    uploadedByUserId: null,
    originalFileName: "export.csv",
    mimeType: "text/csv",
    pageCount: 1,
    sizeBytes: 5,
    storageKey,
    fileHash: randomUUID(),
  });
  // `create`/`rejectIntake` both always stamp `updatedAt` with "now" - this directly
  // backdates it so the fixture actually falls outside the retention window, since real
  // time cannot be traveled in a test.
  await db.update(documents).set({ intakeStatus: "rejected", updatedAt }).where(eq(documents.id, documentId));
  return { id: documentId, storageKey };
}

describe("GET /api/cron/purge-rejected-intake (real Postgres + MinIO)", () => {
  it("returns 401 without an Authorization header", async () => {
    const response = await GET(new Request("http://localhost/api/cron/purge-rejected-intake"), {} as never);
    expect(response.status).toBe(401);
  });

  it("deletes a rejected intake document older than 30 days, including its storage object", async () => {
    const workspaceRepo = createDrizzleWorkspaceRepository(db);
    const workspace = await workspaceRepo.create({ name: "Purge Co" });
    const thirtyOneDaysAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    const { id: documentId, storageKey } = await createRejectedDocument(workspace.id, thirtyOneDaysAgo);

    const response = await GET(requestWithAuth(), {} as never);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { enqueued: number; processed: number };
    expect(body.enqueued).toBeGreaterThanOrEqual(1);

    const documentRepo = createDrizzleDocumentRepository(db);
    expect(await documentRepo.findById(workspace.id, documentId)).toBeNull();
    await expect(getObjectStorage().getObject(storageKey)).rejects.toBeInstanceOf(ObjectNotFoundError);
  });

  it("never deletes a rejected intake document within the retention window", async () => {
    const workspaceRepo = createDrizzleWorkspaceRepository(db);
    const workspace = await workspaceRepo.create({ name: "Keep Co" });
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const { id: documentId, storageKey } = await createRejectedDocument(workspace.id, yesterday);

    const response = await GET(requestWithAuth(), {} as never);
    expect(response.status).toBe(200);

    const documentRepo = createDrizzleDocumentRepository(db);
    expect(await documentRepo.findById(workspace.id, documentId)).not.toBeNull();
    await expect(getObjectStorage().getObject(storageKey)).resolves.toBeDefined();
  });

  it("never deletes a confirmed intake document, however old", async () => {
    const workspaceRepo = createDrizzleWorkspaceRepository(db);
    const workspace = await workspaceRepo.create({ name: "Confirmed Co" });
    const documentId = randomUUID();
    const storageKey = documentOriginalKey({ workspaceId: workspace.id, documentId, extension: "csv" });
    await getObjectStorage().putObject({ key: storageKey, body: new TextEncoder().encode("a,b,c"), contentType: "text/csv" });
    const repo = createDrizzleDocumentRepository(db);
    await repo.create({
      id: documentId,
      workspaceId: workspace.id,
      uploadedByUserId: null,
      originalFileName: "export.csv",
      mimeType: "text/csv",
      pageCount: 1,
      sizeBytes: 5,
      storageKey,
      fileHash: randomUUID(),
    });
    const veryOld = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
    await db.update(documents).set({ intakeStatus: "confirmed", updatedAt: veryOld }).where(eq(documents.id, documentId));

    await GET(requestWithAuth(), {} as never);

    expect(await repo.findById(workspace.id, documentId)).not.toBeNull();
    await expect(getObjectStorage().getObject(storageKey)).resolves.toBeDefined();
  });
});
