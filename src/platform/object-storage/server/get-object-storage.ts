// The lazy, memoized singleton other owners actually call (decisions/0012-object-storage.md).
// Reads `serverEnv()` once, on first access, so `next build` and any test that never
// calls `getObjectStorage()` can run without every `S3_*` variable set.
import "server-only";

import { serverEnv } from "@/platform/env/server";

import type { ObjectStorage } from "../core/object-storage";
import { createS3ObjectStorage } from "./s3-object-storage";

declare global {
  // Memoized on `globalThis` so Next's dev-server HMR does not leak S3 client sockets
  // (same pattern as src/platform/mailer/server/transport.ts's `getMailTransport`).
  var __objectStorage: ObjectStorage | undefined;
}

export function getObjectStorage(): ObjectStorage {
  return (globalThis.__objectStorage ??= createS3ObjectStorage({
    region: serverEnv().S3_REGION,
    bucket: serverEnv().S3_BUCKET,
    accessKeyId: serverEnv().S3_ACCESS_KEY_ID,
    secretAccessKey: serverEnv().S3_SECRET_ACCESS_KEY,
    endpoint: serverEnv().S3_ENDPOINT,
    forcePathStyle: serverEnv().S3_FORCE_PATH_STYLE,
  }));
}

/** Test hook: drop the memoized client. */
export function resetObjectStorageForTests(): void {
  globalThis.__objectStorage = undefined;
}
