// Bulk upload: client-side only (G2, decisions/0030-bulk-upload.md). `POST /api/documents`
// still means exactly one document per request (unchanged, `src/app/api/documents/route.ts`);
// this module only decides how a browser file selection splits into that many separate
// requests, and tracks each request's per-file row state for `ui/upload-form.tsx`'s list.
// Pure, no I/O: `isImageFile` is a best-effort extension/MIME sniff for GROUPING purposes
// only. The server's own magic-byte sniff (`core/magic-bytes.ts`, `@/modules/intake`'s
// `sniffFileKind`) remains the sole authority on what a file actually is - a file
// misclassified here only ever lands in the "wrong" group and gets rejected by the server
// with its usual error code (e.g. `unsupported_file_type`), never a security issue.
import type { DocumentUploadErrorCode } from "./error-codes";

const IMAGE_EXTENSION_PATTERN = /\.(jpe?g|png)$/i;

/** Best-effort "is this an image" check for grouping only (see this file's header comment).
 * A declared `image/jpeg`/`image/png` MIME type is trusted first (the common case: browsers
 * set this from the OS's file association); otherwise falls back to the extension so a file
 * with no/unknown MIME type (common for a `.jpg` picked via drag-and-drop on some platforms)
 * still classifies correctly. */
export function isImageFile(file: File): boolean {
  if (file.type === "image/jpeg" || file.type === "image/png") return true;
  if (file.type.startsWith("image/")) return false;
  return IMAGE_EXTENSION_PATTERN.test(file.name);
}

/**
 * Splits a file selection into upload groups; each group becomes exactly one
 * `POST /api/documents` request, i.e. one document (decisions/0030-bulk-upload.md's rules):
 * 1. Several PDFs or structured files (XML/CSV/TSV/MT940): always one document each.
 * 2. Several images: pages of one document by default, unless `eachImageOwnDocument`.
 * 3. Mixed selection: every PDF/structured file its own document, images grouped per (2).
 * Non-image files keep their original relative order; the (possibly empty) combined image
 * group, when not split, is appended last.
 */
export function classifyUploadGroups(files: readonly File[], eachImageOwnDocument: boolean): File[][] {
  const groups: File[][] = [];
  const combinedImages: File[] = [];
  for (const file of files) {
    if (isImageFile(file)) {
      if (eachImageOwnDocument) {
        groups.push([file]);
      } else {
        combinedImages.push(file);
      }
      continue;
    }
    groups.push([file]);
  }
  if (combinedImages.length > 0) groups.push(combinedImages);
  return groups;
}

/** The "Jede Datei ist ein eigenes Dokument" switch only makes sense with 2+ images in the
 * selection - a single image, or none, has nothing to split from. */
export function shouldShowImageSplitSwitch(files: readonly File[]): boolean {
  return files.filter(isImageFile).length >= 2;
}

export const BULK_UPLOAD_ROW_STATUSES = ["waiting", "uploading", "done", "error", "skipped"] as const;
export type BulkUploadRowStatus = (typeof BULK_UPLOAD_ROW_STATUSES)[number];

export type BulkUploadRow = {
  id: string;
  fileName: string;
  groupIndex: number;
  status: BulkUploadRowStatus;
  errorCode?: DocumentUploadErrorCode;
  existingDocumentId?: string;
};

/** One row per file (not per group): several images sharing one document each still get
 * their own row, since the list shows per-FILE state (assignment: "a simple list with
 * per-file state"), even though they resolve together once their shared request settles. */
export function buildBulkUploadRows(groups: readonly (readonly File[])[]): BulkUploadRow[] {
  const rows: BulkUploadRow[] = [];
  groups.forEach((group, groupIndex) => {
    group.forEach((file, fileIndex) => {
      rows.push({
        id: `${groupIndex}-${fileIndex}-${file.name}-${file.size}`,
        fileName: file.name,
        groupIndex,
        status: "waiting",
      });
    });
  });
  return rows;
}

export function markGroupUploading(rows: readonly BulkUploadRow[], groupIndex: number): BulkUploadRow[] {
  return rows.map((row) => (row.groupIndex === groupIndex ? { ...row, status: "uploading" } : row));
}

const QUOTA_ERROR_CODES = new Set<DocumentUploadErrorCode>(["quota_total_exceeded", "quota_monthly_exceeded"]);

export type BulkUploadGroupResult = { status: "success" } | { status: "error"; errorCode: DocumentUploadErrorCode; existingDocumentId?: string };

export type ApplyGroupResult = { rows: BulkUploadRow[]; stopped: boolean };

/**
 * The queue "reducer": applies one group's upload result to `rows`.
 * - Success marks that group's rows `"done"`.
 * - A quota error (`quota_total_exceeded`/`quota_monthly_exceeded`) marks that group's rows
 *   `"error"` and every still-`"waiting"` row `"skipped"`, and reports `stopped: true` - the
 *   assignment's "a quota error stops the queue with a short summary".
 * - Any other error (duplicate/too-large/unsupported/...) marks only that group's rows
 *   `"error"` and reports `stopped: false` - "a single file's ... error marks that row and
 *   the queue continues".
 */
export function applyGroupResult(rows: readonly BulkUploadRow[], groupIndex: number, result: BulkUploadGroupResult): ApplyGroupResult {
  if (result.status === "success") {
    return { rows: rows.map((row) => (row.groupIndex === groupIndex ? { ...row, status: "done" } : row)), stopped: false };
  }

  const rowsAfterError = rows.map((row): BulkUploadRow =>
    row.groupIndex === groupIndex ? { ...row, status: "error", errorCode: result.errorCode, existingDocumentId: result.existingDocumentId } : row,
  );

  if (!QUOTA_ERROR_CODES.has(result.errorCode)) {
    return { rows: rowsAfterError, stopped: false };
  }

  const stoppedRows = rowsAfterError.map((row): BulkUploadRow => (row.status === "waiting" ? { ...row, status: "skipped" } : row));
  return { rows: stoppedRows, stopped: true };
}

/** Counts rows that have reached a terminal state (done/error/skipped), for the "7 von 34"
 * counter - `"uploading"` is deliberately not counted yet, it is still in flight. */
export function countSettledRows(rows: readonly BulkUploadRow[]): number {
  return rows.filter((row) => row.status === "done" || row.status === "error" || row.status === "skipped").length;
}
