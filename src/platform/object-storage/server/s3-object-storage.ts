// The one `@aws-sdk/client-s3` / `@aws-sdk/s3-request-presigner` client in the codebase
// (STRUCTURE.md `vendor-sdk`, decisions/0012-object-storage.md). `createS3ObjectStorage`
// takes an explicit config rather than reading `serverEnv()` itself, so it stays testable
// against a fake config without touching src/platform/env (the lazy-singleton wiring lives
// in `get-object-storage.ts`).
import "server-only";

import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import { ObjectNotFoundError } from "../core/errors";
import type { ObjectStorage } from "../core/object-storage";

export type S3ObjectStorageConfig = {
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Unset means the AWS default endpoint for `region`; set for MinIO, R2, etc. */
  endpoint?: string;
  /** `true` puts the bucket in the URL path instead of the host name (required by MinIO). */
  forcePathStyle?: boolean;
};

const DEFAULT_PRESIGN_EXPIRES_SECONDS = 300;

/** Strips the double quote and backslash (would break out of the fallback's quoted
 * string) and control characters; non-ASCII is only ever carried by `filename*`. */
const UNSAFE_FOR_QUOTED_ASCII = /["\\\x00-\x1f\x7f-￿]/g;

/** `Content-Disposition: attachment; filename="..."; filename*=UTF-8''...` for
 * `fileName`, an untrusted, caller-supplied display name (never the object storage key
 * itself). */
function attachmentContentDisposition(fileName: string): string {
  const asciiFallback = fileName.replace(UNSAFE_FOR_QUOTED_ASCII, "_") || "download";
  const encoded = encodeURIComponent(fileName).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

export function createS3ObjectStorage(config: S3ObjectStorageConfig): ObjectStorage {
  const client = new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });

  return {
    async putObject({ key, body, contentType }) {
      await client.send(
        new PutObjectCommand({
          Bucket: config.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
        }),
      );
    },

    async getObject(key) {
      try {
        const response = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));
        const body = response.Body;
        if (!body) throw new ObjectNotFoundError(key);
        return await body.transformToByteArray();
      } catch (error) {
        if (isNoSuchKeyError(error)) throw new ObjectNotFoundError(key);
        throw error;
      }
    },

    async deleteObject(key) {
      await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
    },

    async presignDownload({ key, fileName, contentType, expiresInSeconds }) {
      const command = new GetObjectCommand({
        Bucket: config.bucket,
        Key: key,
        ResponseContentDisposition: attachmentContentDisposition(fileName),
        ResponseContentType: contentType,
      });
      return getSignedUrl(client, command, {
        expiresIn: expiresInSeconds ?? DEFAULT_PRESIGN_EXPIRES_SECONDS,
      });
    },

    async listObjects(prefix) {
      const keys: string[] = [];
      let continuationToken: string | undefined;
      do {
        const response = await client.send(
          new ListObjectsV2Command({ Bucket: config.bucket, Prefix: prefix, ContinuationToken: continuationToken }),
        );
        for (const object of response.Contents ?? []) {
          if (object.Key) keys.push(object.Key);
        }
        continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
      } while (continuationToken);
      return keys;
    },

    async deleteObjects(keys) {
      const failedKeys: string[] = [];
      for (const batch of chunk(keys, S3_DELETE_OBJECTS_BATCH_LIMIT)) {
        try {
          const response = await client.send(
            new DeleteObjectsCommand({
              Bucket: config.bucket,
              Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: false },
            }),
          );
          for (const error of response.Errors ?? []) {
            if (error.Key) failedKeys.push(error.Key);
          }
        } catch (err) {
          // The whole batch call itself failed (network error, throttling, ...) - every key
          // in it is unconfirmed, so all are reported as failed rather than assumed deleted.
          console.error(`[object-storage] deleteObjects batch of ${batch.length} failed`, err instanceof Error ? err.message : err);
          failedKeys.push(...batch);
        }
      }
      return { failedKeys };
    },
  };
}

/** S3's `DeleteObjects` accepts at most 1000 keys per call. */
const S3_DELETE_OBJECTS_BATCH_LIMIT = 1000;

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

/** S3 (and MinIO) reject a missing key with an error named `NoSuchKey`. */
function isNoSuchKeyError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "NoSuchKey";
}
