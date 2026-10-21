// Orchestrates magic-byte sniffing, PDF validation, and image-to-PDF assembly for one
// upload request (decisions/0015-documents-and-quotas.md's upload path): either ONE PDF, or
// 1..20 images (JPEG/PNG - the P2c camera scanner sends perspective-corrected JPEG pages),
// combined into one PDF. Pure aside from `pdf-assembly.ts`'s `pdf-lib` calls: no I/O, no
// database, no storage - testable directly with small generated buffers.
import { sniffFileType } from "./magic-bytes";
import { assembleImagesIntoPdf, validateUploadedPdf, type UploadImage } from "./pdf-assembly";
import { MAX_UPLOAD_PAGES } from "./upload-limits";
import type { DocumentUploadErrorCode } from "./error-codes";

export type ProcessedUpload = { pdfBytes: Uint8Array; pageCount: number };

export type ProcessUploadResult = { ok: true; data: ProcessedUpload } | { ok: false; errorCode: DocumentUploadErrorCode };

/**
 * `parts` are the raw bytes of every uploaded file part, in the order they were received.
 * `maxPages` is injectable for tests; the route handler always passes `MAX_UPLOAD_PAGES`.
 */
export async function processUploadParts(parts: readonly Uint8Array[], maxPages: number = MAX_UPLOAD_PAGES): Promise<ProcessUploadResult> {
  if (parts.length === 0) return { ok: false, errorCode: "no_file" };
  if (parts.length > maxPages) return { ok: false, errorCode: "too_many_pages" };

  const sniffed = parts.map(sniffFileType);
  if (sniffed.some((type) => type === null)) return { ok: false, errorCode: "unsupported_file_type" };

  if (parts.length === 1 && sniffed[0] === "pdf") {
    const result = await validateUploadedPdf(parts[0]!, maxPages);
    if (!result.valid) return { ok: false, errorCode: result.reason };
    return { ok: true, data: { pdfBytes: parts[0]!, pageCount: result.pageCount } };
  }

  // Either exactly one PDF, or 1..N images - never a PDF mixed with images, and never more
  // than one PDF at a time (architecture brief: "either ONE PDF, or 1..20 images").
  if (sniffed.some((type) => type === "pdf")) {
    return { ok: false, errorCode: "unsupported_file_type" };
  }

  const images: UploadImage[] = parts.map((bytes, index) => ({ bytes, type: sniffed[index] as "jpeg" | "png" }));
  const pdfBytes = await assembleImagesIntoPdf(images);
  return { ok: true, data: { pdfBytes, pageCount: images.length } };
}
