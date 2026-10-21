// Typed fake for `ObjectStorage` (WEBAPP_TEMPLATE_SPEC.md §10.2's "fakes instead of
// mocks" rule): an in-memory store other owners' unit tests inject instead of mocking
// `@aws-sdk/client-s3` (STRUCTURE.md's `tests` block exempts this path from the
// `.test.ts` suffix rule, same as src/platform/mailer/tests/support).
import { ObjectNotFoundError, type ObjectStorage } from "@/platform/object-storage";

export type FakeStoredObject = { body: Uint8Array; contentType: string };

export function createFakeObjectStorage(): {
  storage: ObjectStorage;
  objects: Map<string, FakeStoredObject>;
} {
  const objects = new Map<string, FakeStoredObject>();

  const storage: ObjectStorage = {
    async putObject({ key, body, contentType }) {
      objects.set(key, { body, contentType });
    },

    async getObject(key) {
      const found = objects.get(key);
      if (!found) throw new ObjectNotFoundError(key);
      return found.body;
    },

    async deleteObject(key) {
      objects.delete(key);
    },

    async listObjects(prefix) {
      return Array.from(objects.keys()).filter((key) => key.startsWith(prefix));
    },

    async deleteObjects(keys) {
      for (const key of keys) objects.delete(key);
      return { failedKeys: [] };
    },

    async presignDownload({ key, fileName, expiresInSeconds }) {
      if (!objects.has(key)) throw new ObjectNotFoundError(key);
      const params = new URLSearchParams({
        fileName,
        expiresInSeconds: String(expiresInSeconds ?? 300),
      });
      return `https://fake-object-storage.test/${encodeURIComponent(key)}?${params.toString()}`;
    },
  };

  return { storage, objects };
}
