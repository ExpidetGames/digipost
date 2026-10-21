/**
 * Guards against the P6 review finding: `invalid_input` is a reachable code in
 * `DocumentActionErrorCode` (returned by `deleteDocumentAction`/`retryProcessingAction` on a
 * Zod parse failure) but had no message under `de.json`'s `DocumentDetail.errors`, so a
 * malformed action call rendered the literal key instead of German copy. Generalized to
 * every code this module's error-code sets can return: `DOCUMENT_UPLOAD_ERROR_CODES`
 * (surfaced by `ui/upload-form.tsx` under `Scan.errors`) and `DOCUMENT_ACTION_ERROR_CODES` /
 * `DOCUMENT_PROCESSING_ERROR_CODES` (both surfaced by `ui/document-detail-client.tsx`
 * under `DocumentDetail.errors`).
 */
import { describe, expect, it } from "vitest";

import de from "@/i18n/messages/de.json";

import { DOCUMENT_ACTION_ERROR_CODES, DOCUMENT_PROCESSING_ERROR_CODES, DOCUMENT_UPLOAD_ERROR_CODES } from "../core/error-codes";

describe("Scan.errors covers DOCUMENT_UPLOAD_ERROR_CODES", () => {
  const errors: Record<string, unknown> = de.Scan.errors;

  it.each(DOCUMENT_UPLOAD_ERROR_CODES)("code %s resolves", (code) => {
    expect(typeof errors[code], `Scan.errors.${code} is missing from de.json`).toBe("string");
  });
});

describe("DocumentDetail.errors covers DOCUMENT_ACTION_ERROR_CODES and DOCUMENT_PROCESSING_ERROR_CODES", () => {
  const errors: Record<string, unknown> = de.DocumentDetail.errors;

  it.each([...DOCUMENT_ACTION_ERROR_CODES, ...DOCUMENT_PROCESSING_ERROR_CODES])("code %s resolves", (code) => {
    expect(typeof errors[code], `DocumentDetail.errors.${code} is missing from de.json`).toBe("string");
  });
});
