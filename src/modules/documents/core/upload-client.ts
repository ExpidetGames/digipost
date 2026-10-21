// Browser-side upload helper (decisions/0015-documents-and-quotas.md): posts multipart form
// data to `POST /api/documents` and normalizes the JSON response. Used by both
// `ui/upload-form.tsx` (the file-input tab) and P2c's camera scanner
// (`src/modules/scanner`, perspective-corrected JPEG pages) - neither needs to know the
// route's exact multipart field names.
import type { DocumentUploadErrorCode } from "./error-codes";

export type UploadDocumentResult =
  | { status: "success"; documentId: string }
  | { status: "error"; errorCode: DocumentUploadErrorCode; existingDocumentId?: string };

/** `files`: either one PDF, 1..20 JPEG/PNG images, or one XML/CSV/TSV file
 * (decisions/0020-universal-intake.md, F1b). `fileName`: optional display name for the
 * document (falls back to the first file's own name server-side when omitted). */
export async function uploadDocument(files: File[] | FileList, fileName?: string): Promise<UploadDocumentResult> {
  const formData = new FormData();
  for (const file of Array.from(files)) {
    formData.append("files", file);
  }
  if (fileName?.trim()) {
    formData.append("fileName", fileName.trim());
  }

  let response: Response;
  try {
    response = await fetch("/api/documents", { method: "POST", body: formData });
  } catch {
    return { status: "error", errorCode: "unknown" };
  }

  const body = (await response.json().catch(() => null)) as
    | { documentId?: string; errorCode?: string; existingDocumentId?: string }
    | null;

  if (response.ok && body?.documentId) {
    return { status: "success", documentId: body.documentId };
  }

  return {
    status: "error",
    errorCode: (body?.errorCode as DocumentUploadErrorCode | undefined) ?? "unknown",
    existingDocumentId: body?.existingDocumentId,
  };
}
