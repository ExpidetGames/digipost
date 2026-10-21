// Pure error types (decisions/0012-object-storage.md). Neutral so callers can catch them
// without importing the privileged server.ts.

/** Thrown by the key builders in `core/keys.ts` for a `workspaceId`/`documentId` that is
 * not a valid UUID. Every document object key is scoped by these two ids, so a caller
 * passing anything else (client input, a malformed string) must never reach a real
 * object key. */
export class InvalidObjectKeySegmentError extends Error {
  override readonly name = "InvalidObjectKeySegmentError";

  constructor(
    readonly field: string,
    readonly value: string,
  ) {
    super(`invalid object key segment for "${field}": ${JSON.stringify(value)}, expected a UUID`);
  }
}

/** Thrown by `getObject` (both the real S3-backed implementation and the fake) for a
 * missing key. */
export class ObjectNotFoundError extends Error {
  override readonly name = "ObjectNotFoundError";

  constructor(readonly key: string) {
    super(`object not found: ${key}`);
  }
}
