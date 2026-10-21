# Object storage: S3-compatible, private bucket, src/platform/object-storage

Document type: decision
Lifecycle: active
Owner: src/platform/object-storage
Scope: Where Digipost stores files (a document's original upload and its server-built
searchable PDF), which client and credentials it uses, how files get in and out, the
object key layout, and the local and test setup
Canonical responsibility: Active source for activating WEBAPP_TEMPLATE_SPEC.md §14's
object storage recipe in this repository: the `src/platform/object-storage` owner, the
S3-compatible client, the private bucket, presigned downloads, uploads through a route
handler, the key layout, and MinIO in `docker/compose.yml` and `docker/compose.test.yml`
Maintenance triggers:
- A storage provider is chosen for staging or production
- The key layout changes, or a new kind of object is stored
- Uploads or downloads change their path
- The `S3_*` environment variables change
- The MinIO image or its setup in `docker/compose.yml` / `docker/compose.test.yml` changes
Last verified: 2026-09-19, P0a infra phase, against `docker/compose.yml`,
`docker/compose.test.yml`, `src/platform/env/server/env.ts`, `.env.example`,
`STRUCTURE.md`'s `env-access`/`vendor-sdk` rules, and `src/platform/object-storage`

## Status
Accepted

## Context

The documents feature (the product's core value: scanning, OCR, categorizing, and
routing a small business's incoming paper mail) stores two files per document: the
original upload (a phone-camera-scanned PDF the client assembled) and a server-built
searchable PDF (page images plus an invisible OCR text layer, produced by
`src/modules/documents`'s processing pipeline once Mistral OCR finishes). These contain
personal and business data and must only ever reach the workspace that owns them.

Storing files in Postgres would bloat backups and the connection pool with binary data.
WEBAPP_TEMPLATE_SPEC.md §14 already describes an object storage recipe
(`src/platform/object-storage`, S3 client, per-tenant scope check, presigned URLs, MinIO
locally and in the test stack, only holder of storage credentials) and names
`@aws-sdk/client-s3`/`@aws-sdk/s3-request-presigner` for it. The hosting provider for
production is Vercel; Cloudflare R2 is chosen as the storage provider because it is
S3-API-compatible, has no egress fees, and is a common Vercel pairing.

## Decision

1. **Activate the recipe.** A new owner `src/platform/object-storage` is the only code
   that talks to object storage and the only holder of storage credentials. It uses
   `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` against any S3-compatible
   provider (Cloudflare R2 in production, MinIO locally and in the test stack).
   `STRUCTURE.md` confines `@aws-sdk/` imports to `src/platform/object-storage/`
   (`vendor-sdk`) and every `S3_*` variable to `src/platform/object-storage/` and
   `src/platform/env/` (`env-access`).
2. **Interface.** `putObject`, `getObject`, `deleteObject`, and `presignDownload`. The
   owner knows nothing about workspaces or documents; callers pass keys built with the
   key layout below.
3. **Private bucket.** The bucket has no public access and no public URLs. Every read by
   a browser goes through the application:
   - **Downloads**: the document detail view streams the searchable PDF through an
     authenticated same-origin route handler (native browser PDF viewer), after checking
     the requesting user's workspace membership; `presignDownload` (a short-lived,
     minutes-not-hours presigned GET URL) is available for any future path that needs a
     direct redirect instead of a streamed response.
   - **Uploads**: through a Next.js route handler (multipart), never Server Actions
     (their body size limit and multipart handling are the wrong tool for files) and
     never presigned uploads (the server could not enforce size, type, or a page-count
     check before the object exists). The handler authenticates, checks workspace
     membership, sniffs the magic bytes to confirm the declared content type (PDF/JPEG/
     PNG), enforces a 4 MB limit, then calls `putObject`. The 4 MB limit follows directly
     from Vercel's 4.5 MB request body limit for Functions, not from a product choice; a
     larger limit would need presigned uploads with a post-upload verification step.
4. **Key layout.** Every key starts with the workspace, so a key alone shows which
   tenant owns an object and a scope check can compare prefixes. Unlike a general
   attachment store, a document has exactly two possible objects, both at a fixed,
   non-filename-based name:
   - `workspaces/<workspaceId>/documents/<documentId>/original.pdf`: the exact bytes the
     client uploaded;
   - `workspaces/<workspaceId>/documents/<documentId>/searchable.pdf`: the server-built
     PDF with the OCR text layer.
   Keys are built only from server-side UUIDs (`workspaceId`, `documentId`), never from
   client-provided names; the key builders reject any segment that is not a
   syntactically valid UUID. The original file name, if ever surfaced to the user, is
   stored as data on the document row, not in the key.
5. **Configuration.** `src/platform/env` validates `S3_ENDPOINT` (optional URL; unset
   means the AWS-style default endpoint for `S3_REGION`), `S3_REGION`, `S3_BUCKET`,
   `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` (all required), and `S3_FORCE_PATH_STYLE`
   (optional boolean, default `false`; `true` for MinIO). In production: `S3_ENDPOINT =
   https://<account-id>.r2.cloudflarestorage.com`, `S3_REGION = auto`.
6. **Local and test stack.** MinIO runs in `docker/compose.yml` (service `minio`, host
   ports bound to `127.0.0.1`: API `54346`, console `54347`, overridable via
   `DEV_MINIO_API_PORT`/`DEV_MINIO_CONSOLE_PORT`, pinned image tag) and in
   `docker/compose.test.yml` (service `minio`, no host ports, tmpfs data). A one-shot
   service `minio-init` creates the private bucket (`digipost-documents` locally,
   `digipost-test-documents` in the test stack; `mc mb --ignore-existing`, `mc anonymous
   set none`); in the test stack the `tests` and `app` services (and through `app`, `e2e`)
   wait for `minio-init` to complete before starting.
7. **Provider choice is production-only.** MinIO is never used outside local development
   and the hermetic test stack; both environments exercise the same real S3 API
   (`putObject`/`getObject`/`deleteObject`/presigned GET) that Cloudflare R2 serves in
   production, so storage code is tested against the same protocol it runs against live.

## Consequences

- Positive: files never pass through Postgres, and every file access is gated by the
  same workspace-scope rules as database access.
- Positive: local development, the Docker test stack, and CI use a real S3 API (MinIO),
  so storage code is tested against the same protocol it uses in production.
- Positive: switching providers is an environment change, not a code change.
- Negative: uploads go through the application server, so the upload size limit is bound
  by Vercel's request body limit; 4 MB covers a typical scanned letter but not a long
  multi-page contract scanned at high resolution, which is why the product also caps
  page count (20 pages) rather than relying on the byte limit alone.
- Negative: a presigned URL works for anyone who has it until it expires; the short
  lifetime limits, but does not remove, this risk. The MVP's primary download path
  (the authenticated route handler) avoids this risk entirely by never handing out a
  presigned URL to the browser; `presignDownload` exists for a future path that needs
  one.
- Negative: deleting a document row does not by itself delete its objects; document
  deletion (`src/modules/documents`) must call `deleteObject` for both `original.pdf`
  and `searchable.pdf` explicitly as part of the same operation.
- Implementation status: **partially implemented**. P0a (this phase) added the
  dependencies (`@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`), the `S3_*`
  variables in `src/platform/env` and `.env.example`, the `STRUCTURE.md` rows, MinIO with
  bucket creation in `docker/compose.yml` and `docker/compose.test.yml`, and the
  `src/platform/object-storage` owner itself (`putObject`, `getObject`, `deleteObject`,
  `presignDownload`, the `documentOriginalKey`/`documentSearchableKey` builders, README,
  unit tests with a fake, and an integration test against the test stack's MinIO). Later
  phases (P2a documents core) add the upload route handler, the authenticated download
  route, and document-deletion's `deleteObject` calls. No provider account exists yet for
  staging or production; Cloudflare R2 is the chosen provider, not yet provisioned.

## Supersedes / Superseded By
- None
