import "server-only";

/**
 * Owner: src/modules/closing (decisions/0066-abschluss-check-and-export.md). The one
 * `archiver` user in this codebase: turns an async sequence of entries into a ZIP that is
 * streamed to the client as it is produced.
 *
 * The point of this file is the backpressure, not the compression. `appendAndDrain` waits for
 * archiver to finish processing each entry before the caller is allowed to produce the next
 * one, so at most ONE document's bytes are ever held in memory - the archive is never
 * assembled as a whole, in this process or on disk. See `src/modules/closing/README.md`'s
 * "Practical size limit" for what that does and does not buy.
 */
import { Archiver, ZipArchive } from "archiver";
import { PassThrough, Readable } from "node:stream";

export type ClosingArchiveEntry = {
  /** The path inside the archive, exactly as it should appear. */
  name: string;
  bytes: Uint8Array;
};

/** Level 1, not the default: almost everything in this archive (PDF, JPEG, the XLSX, which is
 * itself a ZIP) is already compressed, so a higher level costs CPU per megabyte and saves
 * almost nothing. The CSV/XML entries still benefit. */
const COMPRESSION_LEVEL = 1;

function appendAndDrain(archive: Archiver, entry: ClosingArchiveEntry): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      archive.off("entry", onEntry);
      archive.off("error", onError);
    };
    const onEntry = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    // Listeners first, then the append: archiver processes its queue asynchronously, but
    // attaching after the call would still be a race worth not having.
    archive.on("entry", onEntry);
    archive.on("error", onError);
    archive.append(Buffer.from(entry.bytes), { name: entry.name });
  });
}

/**
 * Starts producing immediately and returns the response body. `entries` is consumed lazily,
 * one entry at a time; whatever it throws aborts the archive and destroys the stream (the
 * client then sees a truncated download, which is the only thing HTTP allows once the
 * headers are out).
 */
export function createClosingArchiveStream(entries: () => AsyncIterable<ClosingArchiveEntry>): ReadableStream<Uint8Array> {
  // `archiver` 8 is ESM and exposes the archive classes rather than the old default factory
  // function, so this is `new ZipArchive(...)` and not `archiver("zip", ...)`.
  const archive = new ZipArchive({ zlib: { level: COMPRESSION_LEVEL } });
  const output = new PassThrough();
  archive.pipe(output);

  // A permanently attached handler so an archiver error outside an `appendAndDrain` window
  // (during `finalize`, say) can never become an unhandled `error` event, which in Node
  // takes the whole process down.
  archive.on("error", (error: Error) => {
    output.destroy(error);
  });

  void (async () => {
    try {
      for await (const entry of entries()) {
        await appendAndDrain(archive, entry);
      }
      await archive.finalize();
    } catch (error) {
      archive.abort();
      output.destroy(error instanceof Error ? error : new Error(String(error)));
    }
  })();

  return Readable.toWeb(output) as unknown as ReadableStream<Uint8Array>;
}
