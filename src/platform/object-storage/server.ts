import "server-only";

/**
 * Privileged entrypoint of src/platform/object-storage (decisions/0012-object-storage.md).
 * Never imported from client-reachable code; the only file allowed to hold storage
 * credentials besides src/platform/env.
 */
export { createS3ObjectStorage, type S3ObjectStorageConfig } from "./server/s3-object-storage";
export { getObjectStorage, resetObjectStorageForTests } from "./server/get-object-storage";
