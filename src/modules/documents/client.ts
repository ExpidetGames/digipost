"use client";

/**
 * Public client entrypoint (WEBAPP_TEMPLATE_SPEC.md §4.2). `uploadDocument` is also the
 * helper P2c's camera scanner (`src/modules/scanner`) hands its perspective-corrected JPEG
 * pages to - it never needs to know about `/api/documents`'s multipart shape directly.
 */
export { uploadDocument, type UploadDocumentResult } from "./core/upload-client";
export { UploadForm } from "./ui/upload-form";
export { DocumentDetailClient } from "./ui/document-detail-client";
export { ProcessingPoller } from "./ui/processing-poller";
export { IntakeConfirmationPanel } from "./ui/intake-confirmation-panel";
export { IntakeSettingsClient } from "./ui/intake-settings-client";
