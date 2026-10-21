// F1b (decisions/0020-universal-intake.md, decisions/0022-intake-wiring.md): the upload
// route's own entry point for deciding whether an upload is the existing PDF/image path or a
// structured intake file (XML/CSV/TSV/MT940), sniffed by content, never the client's declared
// MIME type or extension (the same rule `magic-bytes.ts`/`upload-processing.ts` already follow
// for PDF/JPEG/PNG). Pure aside from `upload-processing.ts`'s own `pdf-lib` calls: no I/O.
import { decodeTextBytes, detectCamt053, MT940_ERROR, MT940_MIME_TYPE, Mt940ParseError, parseMt940, sampleTabular, sniffFileKind, UnsafeXmlError } from "@/modules/intake";

import type { DocumentUploadErrorCode } from "./error-codes";
import { processUploadParts } from "./upload-processing";

export type StructuredUploadExtension = "xml" | "csv" | "tsv" | "mt940";

export type StructuredUpload = {
  bytes: Uint8Array;
  mimeType: string;
  extension: StructuredUploadExtension;
  /** Whether this XML upload's namespace was already recognized as camt.053
   * (`@/modules/intake`'s `detectCamt053`) - `processDocument` uses this to skip straight to
   * the deterministic parse instead of re-detecting later. Always `false` for CSV/TSV/MT940. */
  isCamt053: boolean;
};

export type ProcessedIntakeUpload =
  | { kind: "pdf_or_image"; pdfBytes: Uint8Array; pageCount: number }
  | { kind: "structured"; data: StructuredUpload };

export type ProcessIntakeUploadResult = { ok: true; data: ProcessedIntakeUpload } | { ok: false; errorCode: DocumentUploadErrorCode };

const MIME_TYPE_BY_EXTENSION: Record<StructuredUploadExtension, string> = {
  xml: "application/xml",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  mt940: MT940_MIME_TYPE,
};

/** Maps `parseMt940`'s own stable error codes to this route's upload error codes - decided at
 * upload time (decisions/0028-mt940-support.md), mirroring camt.053's own
 * `unrecognized_xml_format`/CSV's `empty_tabular_file`/`unreadable_tabular_file` split: a
 * structural problem the file itself has is rejected here with a clear German message, rather
 * than deferred to a `failed` processing job. */
function mapMt940ErrorToUploadCode(code: string): DocumentUploadErrorCode {
  if (code === MT940_ERROR.tooManyLines || code === MT940_ERROR.tooManyStatements || code === MT940_ERROR.tooManyTransactions) {
    return "mt940_too_large";
  }
  return "unreadable_mt940_file";
}

/**
 * A structured file (XML/CSV/TSV/MT940) is always a single-part upload - the client never
 * combines one with another file the way it can combine several images into one PDF. Only an
 * XML that declares the camt.053 namespace is accepted today: decisions/0020-universal-intake.md's
 * self-identifying-format exception is the only defined path for a standalone XML upload (an
 * arbitrary non-camt.053 XML has no AI-assisted path in this application - see
 * `decisions/0022-intake-wiring.md`'s "Upload route" for why this is a deliberate scope cut,
 * not an oversight). A CSV/TSV only needs to be READABLE and non-empty here; its actual
 * classification/mapping happens later, in the processing job. An MT940 file is, like
 * camt.053, self-identifying and deterministic (decisions/0028-mt940-support.md): a full parse
 * (bounded by `parseMt940`'s own hard limits) runs already at upload time so a genuinely
 * malformed or absurdly oversized file is rejected here, with a clear German message, rather
 * than deferred to a `failed` processing job.
 */
function processStructuredPart(bytes: Uint8Array, sniffed: "xml" | "csv" | "tsv" | "mt940"): ProcessIntakeUploadResult {
  const text = decodeTextBytes(bytes);

  if (sniffed === "xml") {
    let detection: { version: string } | null;
    try {
      detection = detectCamt053(text);
    } catch (err) {
      if (err instanceof UnsafeXmlError) return { ok: false, errorCode: "unsafe_xml" };
      throw err;
    }
    if (!detection) return { ok: false, errorCode: "unrecognized_xml_format" };
    return {
      ok: true,
      data: { kind: "structured", data: { bytes, mimeType: MIME_TYPE_BY_EXTENSION.xml, extension: "xml", isCamt053: true } },
    };
  }

  if (sniffed === "mt940") {
    try {
      const result = parseMt940(text);
      const transactionCount = result.statements.reduce((sum, statement) => sum + statement.transactions.length, 0);
      if (result.statements.length === 0 || transactionCount === 0) return { ok: false, errorCode: "empty_mt940_file" };
    } catch (err) {
      if (err instanceof Mt940ParseError) return { ok: false, errorCode: mapMt940ErrorToUploadCode(err.code) };
      return { ok: false, errorCode: "unreadable_mt940_file" };
    }
    return {
      ok: true,
      data: { kind: "structured", data: { bytes, mimeType: MIME_TYPE_BY_EXTENSION.mt940, extension: "mt940", isCamt053: false } },
    };
  }

  try {
    const sample = sampleTabular(text, { delimiter: sniffed === "tsv" ? "\t" : undefined });
    if (sample.header.length === 0 || sample.rowCount === 0) return { ok: false, errorCode: "empty_tabular_file" };
  } catch {
    return { ok: false, errorCode: "unreadable_tabular_file" };
  }

  return {
    ok: true,
    data: { kind: "structured", data: { bytes, mimeType: MIME_TYPE_BY_EXTENSION[sniffed], extension: sniffed, isCamt053: false } },
  };
}

/**
 * `parts` are the raw bytes of every uploaded file part, in the order they were received
 * (mirrors `processUploadParts`'s own contract). A single part sniffed as XML/CSV/TSV takes
 * the structured-file path; everything else (a single PDF, or 1..N images) falls through to
 * the existing `processUploadParts` (decisions/0015-documents-and-quotas.md).
 */
export async function processIntakeUpload(parts: readonly Uint8Array[], maxPages: number): Promise<ProcessIntakeUploadResult> {
  if (parts.length === 0) return { ok: false, errorCode: "no_file" };

  if (parts.length === 1) {
    const sniffed = sniffFileKind(parts[0]!);
    if (sniffed === "xml" || sniffed === "csv" || sniffed === "tsv" || sniffed === "mt940") {
      return processStructuredPart(parts[0]!, sniffed);
    }
  }

  const result = await processUploadParts(parts, maxPages);
  if (!result.ok) return result;
  return { ok: true, data: { kind: "pdf_or_image", pdfBytes: result.data.pdfBytes, pageCount: result.data.pageCount } };
}
