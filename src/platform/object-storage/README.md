# src/platform/object-storage

Document type: reference
Lifecycle: active
Owner: src/platform/object-storage
Scope: The S3-compatible object storage client, key layout, and presigned downloads for
documents' `original.pdf`/`searchable.pdf` files
Canonical responsibility: The only code that talks to object storage and the only holder
of storage credentials (`decisions/0012-object-storage.md`)
Maintenance triggers:
- The key layout changes, or a new kind of object is stored
- The `ObjectStorage` interface's methods or their inputs change
- `S3_*` environment variables change (`src/platform/env/server/env.ts`)
- The MinIO image or setup in `docker/compose.yml` / `docker/compose.test.yml` changes
Last verified: 2026-09-20, F5 (decisions/0027-hardening-and-deletion.md): added
`listObjects(prefix)`/`deleteObjects(keys)` (paginated `ListObjectsV2`/batched
`DeleteObjects`) and `workspaceStoragePrefix(workspaceId)` - workspace deletion's storage
cleanup needs to remove every object under a prefix, not one known key at a time, the first
caller with that need since this owner's original `putObject`/`getObject`/`deleteObject`/
`presignDownload` shape. 2026-09-19, P2a (documents core + quota enforcement): first real consumer

## Purpose

Files never pass through Postgres (`decisions/0012-object-storage.md`). This owner wraps
`@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` behind a small, provider-neutral
port (`ObjectStorage`), so any S3-compatible provider (Cloudflare R2 in production, MinIO
locally and in the test stack) works by changing `S3_*` environment variables, not code.
It knows nothing about workspaces or documents; callers pass keys built with the key
builders below.

## Public interfaces

`index.ts` (neutral, safe for client-reachable code; no vendor SDK, no credentials):

| Export | Kind | Meaning |
|---|---|---|
| `ObjectStorage` | interface | `putObject`, `getObject`, `deleteObject`, `presignDownload`, `listObjects`, `deleteObjects` |
| `PutObjectInput` | type | `{ key, body: Uint8Array, contentType }` |
| `PresignDownloadInput` | type | `{ key, fileName, contentType?, expiresInSeconds? }` |
| `documentOriginalKey({ workspaceId, documentId })` | function | `workspaces/<workspaceId>/documents/<documentId>/original.pdf` |
| `documentSearchableKey({ workspaceId, documentId })` | function | `workspaces/<workspaceId>/documents/<documentId>/searchable.pdf` |
| `workspaceStoragePrefix(workspaceId)` | function | `workspaces/<workspaceId>/` (F5) - the common prefix of every object a workspace owns |
| `InvalidObjectKeySegmentError` | class | Thrown by the key builders when `workspaceId`/`documentId` is not a syntactically valid UUID |
| `ObjectNotFoundError` | class | Thrown by `getObject` for a missing key |

`server.ts` (`import "server-only"`, never imported from client-reachable code):

- `getObjectStorage(): ObjectStorage` - the lazy, memoized singleton built from
  `serverEnv()`'s `S3_*` variables. What every other owner should call.
- `createS3ObjectStorage(config: S3ObjectStorageConfig): ObjectStorage` - the pure
  constructor `getObjectStorage()` wraps; takes an explicit config instead of reading env
  itself, so it stays testable without `src/platform/env`. `S3ObjectStorageConfig = { region,
  bucket, accessKeyId, secretAccessKey, endpoint?, forcePathStyle? }`.
- `resetObjectStorageForTests()` - test-only: drops the memoized client.

## Env vars

Read only here and in `src/platform/env` (`STRUCTURE.md`'s `env-access` rule):

- `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` (required).
- `S3_ENDPOINT` (optional URL; unset means AWS S3's own default endpoint for `S3_REGION`,
  set it for MinIO/Cloudflare R2/other S3-compatible providers).
- `S3_FORCE_PATH_STYLE` (optional boolean, default `false`; `true` for MinIO, which needs
  the bucket in the URL path instead of the host name).

## Local MinIO usage

`pnpm infra:up` starts MinIO (`docker/compose.yml`, API port `54346`, console `54347`)
and creates the bucket `digipost-documents`. The Docker test stack
(`docker/compose.test.yml`, `pnpm test:docker`) runs its own MinIO with no host ports; a
`minio-init` service creates the bucket before `tests`/`app` (and through `app`, `e2e`)
start. Local env values (also in `.env.example`):

```
S3_ENDPOINT=http://localhost:54346
S3_REGION=us-east-1
S3_BUCKET=digipost-documents
S3_ACCESS_KEY_ID=minioadmin
S3_SECRET_ACCESS_KEY=minioadmin
S3_FORCE_PATH_STYLE=true
```

## Structure

- `core/object-storage.ts`: the `ObjectStorage` port and its input types.
- `core/keys.ts`: `documentOriginalKey`, `documentSearchableKey`, `workspaceStoragePrefix` (F5),
  `InvalidObjectKeySegmentError`. Pure, no I/O.
- `core/errors.ts`: `ObjectNotFoundError`.
- `server/s3-object-storage.ts`: `createS3ObjectStorage`, the one file in the codebase
  that imports `@aws-sdk/client-s3` / `@aws-sdk/s3-request-presigner`.
- `server/get-object-storage.ts`: `getObjectStorage`, the `serverEnv()`-backed lazy
  singleton (memoized on `globalThis`, like `src/platform/mailer/server/transport.ts`'s
  `getMailTransport`, so Next's dev-server HMR does not leak sockets).
- `server.ts`: the public, privileged entrypoint.
- `index.ts`: the neutral entrypoint.
- `tests/`: unit tests; `tests/support/fake-object-storage.ts`: the typed, in-memory fake
  other owners' unit tests inject instead of mocking `@aws-sdk/client-s3` (`STRUCTURE.md`'s
  `tests` block exempts this path from the `.test.ts` suffix rule).

## Behavior notes

- **Private bucket, no public URLs.** Every browser read either goes through an
  authenticated same-origin route handler that streams the object, or through
  `presignDownload`, a short-lived (default 300 seconds) presigned GET URL. The calling
  module must check workspace access first.
- **Key layout is fixed, not filename-based.** Every document has exactly two possible
  objects, `original.pdf` and `searchable.pdf`, keyed only by `workspaceId`/`documentId`
  (both server-side UUIDs); the original uploaded file name is stored as data on the
  document row, never in the object key.
- **`getObject`** returns the full object as `Uint8Array` and throws
  `ObjectNotFoundError` for a missing key (mapped from the S3/MinIO `NoSuchKey` error).
- **Uploads go through a route handler** (not Server Actions, not presigned uploads): the
  handler authenticates, checks workspace access, enforces the 4 MB size limit (Vercel's
  4.5 MB request body limit) and content type (magic-byte sniffed PDF/JPEG/PNG), then
  calls `putObject`. This owner has no upload-size or content-type opinion of its own;
  that policy lives with the caller (`src/modules/documents`).
- **Key builders reject anything that is not a UUID**: `workspaceId`/`documentId` must
  match the RFC 4122 textual form; anything else throws `InvalidObjectKeySegmentError`
  rather than building an unscoped or path-traversing key.
- **`listObjects`/`deleteObjects` (F5)**: `listObjects(prefix)` paginates internally
  (`ListObjectsV2`'s own 1000-key page limit) and always returns the complete list in one
  call; `deleteObjects(keys)` never throws for an individual key's failure, it returns
  `{ failedKeys }` (batched in groups of 1000, `DeleteObjects`' own limit) so the caller can
  decide whether to retry. Only ever called with a whole-prefix argument built by
  `workspaceStoragePrefix`, never a partial/untrusted string.

## Consumers

`src/persistence/use-cases/documents-use-cases.ts` (P2a, decisions/0015-documents-and-quotas.md):
the only caller, bound in `src/persistence/composition/create-request-services.ts`
(`getObjectStorage()`, handed to `createDocumentUseCases` as the `objectStorage` port) -
`documentOriginalKey`/`putObject` on upload, `getObject` for `getFileForDownload` (the
detail view's download route), `deleteObject` for both keys on document deletion (with
compensation: an upload's transaction failing after the object was already stored deletes
it again). `presignDownload` has no caller yet - the MVP's only download path is the
authenticated route handler streaming bytes, never a presigned URL to the browser. P2b's
processing pipeline (a later phase) is `documentSearchableKey`'s first writer.
Repositories still never call this owner directly: they store the document row, they do
not build or resolve object keys - only the use case does. F5
(decisions/0027-hardening-and-deletion.md): `src/modules/workspaces/actions.ts`'s
`deleteWorkspaceAction` calls `getObjectStorage()` directly (a module importing a
platform owner's own `server.ts`, the same pattern `createSmtpMailer`/`serverEnv` already
use there) for an immediate best-effort `listObjects`/`deleteObjects` after the workspace
row is deleted; `src/persistence/composition/job-handlers.ts`'s `cleanup-workspace-storage`
handler is the durable retry for the same work.

## Tests

- `tests/keys.test.ts`: `documentOriginalKey`/`documentSearchableKey`'s layout and
  rejection of anything that is not a syntactically valid UUID.
- `tests/get-object-storage.test.ts`: env boundary (builds without throwing given valid
  `S3_*`) and singleton caching. No I/O: constructing an `S3Client` does not itself open
  a connection.
- `tests/fake-object-storage.test.ts`: the fake's put/get/delete/presign round trip, its
  `ObjectNotFoundError` behavior, and (F5) `listObjects`/`deleteObjects`.
- `tests/integration/workflows/object-storage.integration.test.ts`: put/get/presign/delete
  round trip against the real MinIO of the Docker test stack (`pnpm test:docker`), plus
  (F5) `listObjects` finding every object under a workspace prefix and `deleteObjects`
  removing them all, against the real `ListObjectsV2`/`DeleteObjects` S3 API.
- No unit test for `server/s3-object-storage.ts`'s actual AWS SDK calls: exercised by the
  integration test above instead (WEBAPP_TEMPLATE_SPEC.md §10.2: unit tests must not
  touch the network).
