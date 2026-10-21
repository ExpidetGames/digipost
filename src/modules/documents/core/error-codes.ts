// Stable error codes (AGENTS.md "Code": `as const` sets, never raw text). `ui/*.tsx` maps
// these to next-intl message keys under `Scan.errors`/`DocumentDetail.errors`.

/** `POST /api/documents` (decisions/0015-documents-and-quotas.md's upload path). Mirrors
 * `src/persistence/use-cases/documents-use-cases.ts`'s `DOCUMENT_ERROR` (`quota_*`,
 * `not_found`) plus the request-shape codes the route itself detects before any use case
 * runs, and `src/platform/access`'s `WorkspaceAccessErrorCode`. */
export const DOCUMENT_UPLOAD_ERROR_CODES = [
  "no_file",
  "file_too_large",
  "too_many_pages",
  "invalid_pdf",
  "unsupported_file_type",
  // F1b (decisions/0020-universal-intake.md, decisions/0022-intake-wiring.md): the new
  // structured-file (XML/CSV/TSV) codes, plus the exact-duplicate check.
  "duplicate_document",
  "unsafe_xml",
  "unrecognized_xml_format",
  "empty_tabular_file",
  "unreadable_tabular_file",
  // MT940 support (decisions/0028-mt940-support.md): a self-identifying, deterministic
  // format checked (fully parsed, within bounded limits) already at upload time, mirroring
  // camt.053's/CSV's own upload-time checks.
  "empty_mt940_file",
  "unreadable_mt940_file",
  "mt940_too_large",
  "quota_total_exceeded",
  "quota_monthly_exceeded",
  "not_found",
  "unauthenticated",
  "no_workspace",
  "forbidden",
  "unknown",
] as const;
export type DocumentUploadErrorCode = (typeof DOCUMENT_UPLOAD_ERROR_CODES)[number];

/** `deleteDocumentAction`/`retryProcessingAction`/`reclassifyDocumentAction` and the intake
 * actions (`src/modules/documents/actions.ts`).
 * Mirrors `src/persistence/use-cases/documents-use-cases.ts`'s `DOCUMENT_ERROR` plus
 * `invalid_input` (Zod parse failures) and `src/platform/access`'s `WorkspaceAccessErrorCode`. */
export const DOCUMENT_ACTION_ERROR_CODES = [
  "invalid_input",
  "not_found",
  "retry_not_allowed",
  // F1b (decisions/0022-intake-wiring.md): `confirmIntakeAction`/`rejectIntakeAction`.
  "intake_not_pending",
  "mapping_validation_failed",
  // decisions/0072-correcting-a-document-s-kind.md: `reclassifyDocumentAction`.
  "reclassify_not_allowed",
  "kind_not_selectable",
  "kind_unchanged",
  "payment_linked",
  "payment_settled",
  "unauthenticated",
  "no_workspace",
  "forbidden",
  "unknown",
] as const;
export type DocumentActionErrorCode = (typeof DOCUMENT_ACTION_ERROR_CODES)[number];

/** The stable codes a failed document's own `errorCode` column can hold
 * (decisions/0016-processing-pipeline-and-ai.md): `src/platform/mistral`'s `MISTRAL_ERROR_CODES`
 * plus `processing_failed` (any non-Mistral failure, e.g. a storage error) and
 * `unknown_job_kind` (should never happen in practice - a defensive fallback in
 * `src/persistence/use-cases/jobs-use-cases.ts`). The UI translates these via
 * `DocumentDetail.errors.*`, same as every other stable error code in this application. */
export const DOCUMENT_PROCESSING_ERROR_CODES = [
  "ai_auth_failed",
  "ai_rate_limited",
  "ai_timeout",
  "ai_unavailable",
  "ai_invalid_response",
  "ai_not_configured",
  "processing_failed",
  "unknown_job_kind",
  // MT940 support (decisions/0028-mt940-support.md): the processing job re-parses the stored
  // original (mirrors camt.053's own `unrecognized_xml_format` re-parse check) - reaching
  // either of these means the stored bytes no longer match what the upload route already
  // validated, a data-integrity problem worth surfacing loudly rather than guessing.
  "unrecognized_mt940_format",
  "mt940_too_large",
  // App-store reports (decisions/0048-app-store-reports.md): both readers are re-detected and
  // re-parsed from the stored original at processing time, the same "stored bytes no longer
  // match what was already recognized" reasoning as MT940's own codes above.
  "unrecognized_apple_payment_summary",
  "apple_payment_summary_no_rows",
  "unrecognized_google_play_earnings",
  "google_play_earnings_no_rows",
  "google_play_earnings_unparseable_row",
] as const;
export type DocumentProcessingErrorCode = (typeof DOCUMENT_PROCESSING_ERROR_CODES)[number];
