// Owner-crossing wiring test (WEBAPP_TEMPLATE_SPEC.md §10.1): proves
// src/platform/object-storage actually talks to an S3 API, not just that it type-checks
// against the `ObjectStorage` interface. Runs against the real MinIO of the Docker test
// stack (docker/compose.test.yml, decisions/0012-object-storage.md); relies on
// `serverEnv()` for `S3_*` (set by the test stack's `x-app-env` anchor), never a hosted
// bucket.
import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { documentOriginalKey, ObjectNotFoundError, workspaceStoragePrefix } from "@/platform/object-storage";
import { getObjectStorage } from "@/platform/object-storage/server";

describe("object storage against real MinIO", () => {
  it("round-trips putObject, getObject, presignDownload and deleteObject", async () => {
    const storage = getObjectStorage();
    const key = documentOriginalKey({ workspaceId: randomUUID(), documentId: randomUUID() });
    const body = new TextEncoder().encode("hello object storage");

    await storage.putObject({ key, body, contentType: "application/pdf" });

    await expect(storage.getObject(key)).resolves.toEqual(body);

    const url = await storage.presignDownload({
      key,
      // Non-ASCII display name: exercises the RFC 5987 Content-Disposition encoding.
      fileName: "Übernahme müller.pdf",
      contentType: "application/pdf",
    });
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(body);
    expect(response.headers.get("content-disposition")).toContain("attachment");
    expect(response.headers.get("content-disposition")).toContain("filename*=UTF-8''");

    await storage.deleteObject(key);

    await expect(storage.getObject(key)).rejects.toBeInstanceOf(ObjectNotFoundError);
  });

  it("presignDownload defaults to a 300 second expiry", async () => {
    const storage = getObjectStorage();
    const key = documentOriginalKey({ workspaceId: randomUUID(), documentId: randomUUID() });
    await storage.putObject({ key, body: new TextEncoder().encode("x"), contentType: "application/pdf" });

    const url = new URL(await storage.presignDownload({ key, fileName: "short.pdf" }));
    const expiresParam = url.searchParams.get("X-Amz-Expires") ?? url.searchParams.get("Expires") ?? undefined;
    expect(expiresParam).toBe("300");

    await storage.deleteObject(key);
  });

  it("getObject throws ObjectNotFoundError for a key that was never written", async () => {
    const storage = getObjectStorage();
    const key = documentOriginalKey({ workspaceId: randomUUID(), documentId: randomUUID() });

    await expect(storage.getObject(key)).rejects.toBeInstanceOf(ObjectNotFoundError);
  });

  // F5 (decisions/0027-hardening-and-deletion.md): workspace deletion's storage cleanup
  // lists every object under `workspaces/<id>/` and batch-deletes them - proves the real
  // ListObjectsV2/DeleteObjects commands against MinIO, not just the fake's Map-based
  // approximation (src/platform/object-storage/tests/fake-object-storage.test.ts).
  it("listObjects finds every object under a workspace prefix, and deleteObjects removes them all", async () => {
    const storage = getObjectStorage();
    const workspaceId = randomUUID();
    const prefix = workspaceStoragePrefix(workspaceId);
    const keyA = documentOriginalKey({ workspaceId, documentId: randomUUID() });
    const keyB = documentOriginalKey({ workspaceId, documentId: randomUUID() });
    const otherWorkspaceKey = documentOriginalKey({ workspaceId: randomUUID(), documentId: randomUUID() });
    await Promise.all(
      [keyA, keyB, otherWorkspaceKey].map((key) =>
        storage.putObject({ key, body: new TextEncoder().encode("x"), contentType: "application/pdf" }),
      ),
    );

    const keys = await storage.listObjects(prefix);
    expect(keys.sort()).toEqual([keyA, keyB].sort());

    const { failedKeys } = await storage.deleteObjects(keys);
    expect(failedKeys).toEqual([]);
    await expect(storage.getObject(keyA)).rejects.toBeInstanceOf(ObjectNotFoundError);
    await expect(storage.getObject(keyB)).rejects.toBeInstanceOf(ObjectNotFoundError);
    // The other workspace's object is untouched - `listObjects` never over-matched the prefix.
    await expect(storage.getObject(otherWorkspaceKey)).resolves.toBeDefined();

    await storage.deleteObject(otherWorkspaceKey);
  });

  it("listObjects returns an empty list for a prefix with no objects", async () => {
    const storage = getObjectStorage();
    await expect(storage.listObjects(workspaceStoragePrefix(randomUUID()))).resolves.toEqual([]);
  });
});
