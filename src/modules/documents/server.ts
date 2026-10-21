import "server-only";

/**
 * Public server entrypoint (WEBAPP_TEMPLATE_SPEC.md §4.2). The route handlers under
 * `src/app/api/documents/**` and the `(app)` pages import from here, never from
 * `src/modules/documents/core/**`/`server/**` directly.
 */
export {
  countFailedProjection,
  countOverduePaymentsProjection,
  countPendingIntakeConfirmationProjection,
  getDocumentDetailProjection,
  listDocumentsProjection,
  type ListDocumentsParams,
} from "./server/read-models";
export { contentDispositionHeader } from "./core/content-disposition";
export { DOCUMENT_UPLOAD_ERROR_CODES, type DocumentUploadErrorCode } from "./core/error-codes";
export { MAX_UPLOAD_PAGES, MAX_UPLOAD_REQUEST_BYTES } from "./core/upload-limits";
export { processUploadParts, type ProcessedUpload, type ProcessUploadResult } from "./core/upload-processing";
export { DOCUMENT_SORTS, type DocumentSort, documentListQuerySchema, DOCUMENTS_PAGE_SIZE } from "./core/schemas";
export { DOCUMENT_STATUSES, type DocumentStatus } from "@/persistence/repositories/contracts";
// F1b (decisions/0020-universal-intake.md, decisions/0022-intake-wiring.md): the upload
// route's structured-file (XML/CSV/TSV) sniffing/validation entry point, and the
// `/dashboard/settings/intake` and confirmation-UI read models.
export { processIntakeUpload, type ProcessedIntakeUpload, type ProcessIntakeUploadResult, type StructuredUpload } from "./core/intake-upload-processing";
export { getDocumentIntakeConfirmationProjection, listIntakeFingerprintsProjection } from "./server/read-models";
