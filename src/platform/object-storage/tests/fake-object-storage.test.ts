import { describe, expect, it } from "vitest";

import { ObjectNotFoundError } from "../index";
import { createFakeObjectStorage } from "./support/fake-object-storage";

describe("createFakeObjectStorage", () => {
  it("round-trips put and get", async () => {
    const { storage } = createFakeObjectStorage();
    const body = new TextEncoder().encode("hello world");

    await storage.putObject({ key: "workspaces/w1/documents/d1/original.pdf", body, contentType: "application/pdf" });

    await expect(storage.getObject("workspaces/w1/documents/d1/original.pdf")).resolves.toEqual(body);
  });

  it("throws ObjectNotFoundError for a missing key", async () => {
    const { storage } = createFakeObjectStorage();
    await expect(storage.getObject("missing")).rejects.toBeInstanceOf(ObjectNotFoundError);
  });

  it("removes the object on delete, and a later get fails", async () => {
    const { storage } = createFakeObjectStorage();
    const body = new TextEncoder().encode("data");
    await storage.putObject({ key: "k", body, contentType: "application/pdf" });

    await storage.deleteObject("k");

    await expect(storage.getObject("k")).rejects.toBeInstanceOf(ObjectNotFoundError);
  });

  it("deleting a key that was never stored is a no-op", async () => {
    const { storage } = createFakeObjectStorage();
    await expect(storage.deleteObject("never-existed")).resolves.toBeUndefined();
  });

  it("presigns a download URL for a stored object, carrying the file name and expiry", async () => {
    const { storage } = createFakeObjectStorage();
    await storage.putObject({ key: "k", body: new Uint8Array([1, 2, 3]), contentType: "application/pdf" });

    const url = await storage.presignDownload({ key: "k", fileName: "rechnung.pdf", expiresInSeconds: 60 });

    expect(url).toContain(encodeURIComponent("k"));
    expect(url).toContain("fileName=rechnung.pdf");
    expect(url).toContain("expiresInSeconds=60");
  });

  it("defaults presignDownload's expiry to 300 seconds", async () => {
    const { storage } = createFakeObjectStorage();
    await storage.putObject({ key: "k", body: new Uint8Array([1]), contentType: "application/pdf" });

    const url = await storage.presignDownload({ key: "k", fileName: "f.pdf" });
    expect(url).toContain("expiresInSeconds=300");
  });

  it("refuses to presign a download for a key that was never stored", async () => {
    const { storage } = createFakeObjectStorage();
    await expect(storage.presignDownload({ key: "missing", fileName: "f.pdf" })).rejects.toBeInstanceOf(
      ObjectNotFoundError,
    );
  });

  it("exposes the underlying map for assertions on content type", async () => {
    const { storage, objects } = createFakeObjectStorage();
    await storage.putObject({ key: "k", body: new Uint8Array([1]), contentType: "image/png" });

    expect(objects.get("k")?.contentType).toBe("image/png");
  });

  describe("listObjects (F5, decisions/0027-hardening-and-deletion.md)", () => {
    it("lists only keys under the given prefix", async () => {
      const { storage } = createFakeObjectStorage();
      await storage.putObject({ key: "workspaces/w1/documents/d1/original.pdf", body: new Uint8Array(), contentType: "application/pdf" });
      await storage.putObject({ key: "workspaces/w1/documents/d2/original.pdf", body: new Uint8Array(), contentType: "application/pdf" });
      await storage.putObject({ key: "workspaces/w2/documents/d3/original.pdf", body: new Uint8Array(), contentType: "application/pdf" });

      const keys = await storage.listObjects("workspaces/w1/");

      expect(keys.sort()).toEqual(["workspaces/w1/documents/d1/original.pdf", "workspaces/w1/documents/d2/original.pdf"]);
    });

    it("returns an empty list for a prefix with no objects", async () => {
      const { storage } = createFakeObjectStorage();
      await expect(storage.listObjects("workspaces/never-used/")).resolves.toEqual([]);
    });
  });

  describe("deleteObjects (F5, decisions/0027-hardening-and-deletion.md)", () => {
    it("deletes every listed key and reports no failures", async () => {
      const { storage, objects } = createFakeObjectStorage();
      await storage.putObject({ key: "a", body: new Uint8Array(), contentType: "application/pdf" });
      await storage.putObject({ key: "b", body: new Uint8Array(), contentType: "application/pdf" });

      const result = await storage.deleteObjects(["a", "b"]);

      expect(result.failedKeys).toEqual([]);
      expect(objects.size).toBe(0);
    });

    it("deleting a mix of existing and never-stored keys is a no-op for the missing ones", async () => {
      const { storage } = createFakeObjectStorage();
      await storage.putObject({ key: "a", body: new Uint8Array(), contentType: "application/pdf" });

      const result = await storage.deleteObjects(["a", "never-existed"]);

      expect(result.failedKeys).toEqual([]);
    });
  });
});
