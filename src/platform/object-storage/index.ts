// Neutral entrypoint of src/platform/object-storage: the storage port, key builders, and
// pure errors. Safe for client-reachable code (no vendor SDK, no credentials; the real
// S3-backed client lives behind server.ts).
export type { ObjectStorage, PutObjectInput, PresignDownloadInput } from "./core/object-storage";
export { documentOriginalKey, documentSearchableKey, workspaceStoragePrefix } from "./core/keys";
export { InvalidObjectKeySegmentError, ObjectNotFoundError } from "./core/errors";
