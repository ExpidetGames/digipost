// The storage port (decisions/0012-object-storage.md): every caller depends on this
// interface, never on `@aws-sdk/client-s3` directly, so a unit test can inject
// `tests/support/fake-object-storage.ts` instead of mocking the AWS SDK. Pure types only;
// no vendor SDK import here.

export type PutObjectInput = {
  key: string;
  body: Uint8Array;
  contentType: string;
};

export type PresignDownloadInput = {
  key: string;
  /** The name offered to the browser as the download's file name
   * (`Content-Disposition`), not the object key; may contain non-ASCII characters. */
  fileName: string;
  contentType?: string;
  /** Default 300 seconds (decisions/0012-object-storage.md: "minutes, not hours"). */
  expiresInSeconds?: number;
};

export interface ObjectStorage {
  putObject(input: PutObjectInput): Promise<void>;
  /** Returns the object's bytes. Throws `ObjectNotFoundError` when `key` does not exist. */
  getObject(key: string): Promise<Uint8Array>;
  deleteObject(key: string): Promise<void>;
  /** A short-lived presigned GET URL; the caller must have already checked workspace
   * access before calling this. */
  presignDownload(input: PresignDownloadInput): Promise<string>;
  /** Lists every object key under `prefix` (only ever a whole "directory" prefix built by
   * `core/keys.ts`, e.g. `workspaces/<id>/`, never a partial/untrusted string), paginating
   * internally so the caller always gets the complete list in one call - F5 (workspace
   * deletion, decisions/0027-hardening-and-deletion.md): the only current use is finding
   * every object to remove for a deleted workspace. */
  listObjects(prefix: string): Promise<string[]>;
  /** Best-effort batch delete: never throws for an individual key failing, returns the
   * keys that could NOT be deleted (empty when everything succeeded) so the caller can
   * decide whether to retry - F5's workspace-storage cleanup job retries exactly these. */
  deleteObjects(keys: string[]): Promise<{ failedKeys: string[] }>;
}
