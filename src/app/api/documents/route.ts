/**
 * `POST /api/documents` (decisions/0015-documents-and-quotas.md's upload path): multipart
 * upload, either ONE PDF or 1..20 JPEG/PNG images (combined into one PDF, one page per
 * image). Built on `src/platform/api-pipeline`'s `access -> parse -> execute -> respond`
 * step machine - the first route in this repository to adopt it
 * (`src/platform/api-pipeline/README.md`'s "adoption boundary" is closed by this route for
 * the workspace-access step). `access` resolves the caller's own workspace membership
 * (`workspaceAccess`, never trusting client input for the workspace id); `parse` reads the
 * multipart body, sniffs magic bytes, validates/assembles the final PDF
 * (`@/modules/documents/server`'s `processUploadParts`), and never trusts the client's
 * declared MIME type or the `Content-Length` header alone: `Content-Length` is checked
 * first, before touching the body, as a cheap early rejection, but the authoritative check
 * is `readRequestBodyWithByteCap` reading the request's body stream directly with a hard
 * byte cap (P6 review finding B1) - a chunked request has no `Content-Length` at all, and a
 * client can send a false one either way, so without this the route would buffer the whole
 * body via `formData()` before ever getting a chance to reject an oversized upload;
 * `execute` calls the use case (quota, storage, DB - see
 * `src/persistence/use-cases/documents-use-cases.ts`); `respond` returns `201
 * { documentId }`.
 */
import { revalidatePath } from "next/cache";
import { after } from "next/server";

import {
  createApiHandlerFromContract,
  defineApiEndpointContract,
  mapUseCaseError,
} from "@/platform/api-pipeline";
import { PERMISSIONS } from "@/platform/access";
import { workspaceAccess, WorkspaceAccessError } from "@/platform/access/server";
import { fileHash } from "@/modules/intake";
import { getRequestServices } from "@/persistence/composition/request-services";
import { DOCUMENT_ERROR, DuplicateDocumentError } from "@/persistence/use-cases/documents-use-cases";
import { runDueJobs } from "@/platform/jobs/server";
import {
  MAX_UPLOAD_PAGES,
  MAX_UPLOAD_REQUEST_BYTES,
  processIntakeUpload,
  type DocumentUploadErrorCode,
} from "@/modules/documents/server";

// PDF assembly (pdf-lib) and the upload's own DB/storage work are fast, but generous
// headroom for a slow client connection or a cold Lambda costs nothing on Vercel's Fluid
// Compute pricing model.
export const maxDuration = 30;

class UploadRequestError extends Error {
  override readonly name = "UploadRequestError";
  constructor(readonly code: DocumentUploadErrorCode) {
    super(code);
  }
}

/**
 * Reads `request`'s body off its stream, aborting as soon as the cumulative byte count
 * exceeds `maxBytes` - never waiting for the stream to end first (P6 review finding B1).
 * Before this, the only pre-parse guard was the optional `Content-Length` pre-check above;
 * a chunked request (no `Content-Length` at all) or one with a spoofed, too-small
 * `Content-Length` would reach `request.formData()` unchecked, which buffers the ENTIRE
 * body before this route ever got a chance to reject it - an attacker could make the server
 * buffer an arbitrary amount of memory. Reading the stream directly and cancelling it the
 * moment the cap is crossed bounds memory use to roughly `maxBytes` plus one chunk,
 * regardless of how much more the client tries to send.
 */
async function readRequestBodyWithByteCap(request: Request, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const reader = request.body?.getReader();
  if (!reader) throw new UploadRequestError("no_file");

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("file_too_large").catch(() => {});
        throw new UploadRequestError("file_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  // `new ArrayBuffer(total)`, not `new Uint8Array(total)`: TS's lib types a plain
  // `new Uint8Array(n)` as `Uint8Array<ArrayBufferLike>` (which admits a `SharedArrayBuffer`
  // and so is not assignable to `BlobPart`/`BodyInit`) - backing it with a concrete
  // `ArrayBuffer` keeps the type as `Uint8Array<ArrayBuffer>`, accepted below.
  const combined = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

const STATUS_BY_CODE: Record<DocumentUploadErrorCode, number> = {
  no_file: 400,
  file_too_large: 413,
  too_many_pages: 400,
  invalid_pdf: 400,
  unsupported_file_type: 415,
  duplicate_document: 409,
  unsafe_xml: 400,
  unrecognized_xml_format: 400,
  empty_tabular_file: 400,
  unreadable_tabular_file: 400,
  empty_mt940_file: 400,
  unreadable_mt940_file: 400,
  mt940_too_large: 413,
  quota_total_exceeded: 402,
  quota_monthly_exceeded: 402,
  not_found: 404,
  unauthenticated: 401,
  no_workspace: 403,
  forbidden: 403,
  unknown: 500,
};

const contract = defineApiEndpointContract<DocumentUploadErrorCode>({
  invalidRequestError: { errorCode: "no_file", status: 400 },
  unknownError: { errorCode: "unknown", status: 500 },
});

/** F1b (decisions/0020-universal-intake.md): the exact bytes that will be written to storage
 * (the assembled PDF for a PDF/image upload, or the structured file as-is for XML/CSV/TSV) -
 * `fileHash` is computed over these, not the original multipart parts, so it always matches
 * what a later re-upload of the "same document" would also produce. */
type ParsedUpload = {
  bytes: Uint8Array;
  mimeType: string;
  extension: string;
  pageCount: number;
  originalFileName: string;
};

export const POST = createApiHandlerFromContract(contract, {
  access: {
    run: () => workspaceAccess(PERMISSIONS.documentsWrite),
    mapError: (err) => {
      if (!(err instanceof WorkspaceAccessError)) return null;
      return { errorCode: err.code, status: STATUS_BY_CODE[err.code] };
    },
  },

  parse: {
    run: async ({ request }): Promise<ParsedUpload> => {
      // Cheap rejection before touching the body at all, when the client sent a
      // Content-Length (chunked transfer encoding has none, and a client can lie about
      // this header either way - the streaming byte cap below is the authoritative check).
      const contentLength = request.headers.get("content-length");
      if (contentLength && Number(contentLength) > MAX_UPLOAD_REQUEST_BYTES) {
        throw new UploadRequestError("file_too_large");
      }

      // The authoritative check (P6 review finding B1): read the body directly off its
      // stream with a hard byte cap, never trusting Content-Length alone, before handing
      // anything to `formData()` (which would otherwise buffer the whole body first).
      const bodyBytes = await readRequestBodyWithByteCap(request, MAX_UPLOAD_REQUEST_BYTES);

      let formData: FormData;
      try {
        formData = await new Request(request.url, { method: "POST", headers: request.headers, body: new Blob([bodyBytes]) }).formData();
      } catch {
        throw new UploadRequestError("no_file");
      }

      const fileEntries = formData.getAll("files").filter((entry): entry is File => entry instanceof File);
      if (fileEntries.length === 0) throw new UploadRequestError("no_file");

      const totalSize = fileEntries.reduce((sum, file) => sum + file.size, 0);
      if (totalSize > MAX_UPLOAD_REQUEST_BYTES) throw new UploadRequestError("file_too_large");

      const parts = await Promise.all(fileEntries.map(async (file) => new Uint8Array(await file.arrayBuffer())));
      // F1b (decisions/0020-universal-intake.md): sniffs content by bytes, never the client's
      // declared MIME type - either the existing PDF/image path (assembled into one PDF) or a
      // single structured file (XML/CSV/TSV), stored as-is.
      const processed = await processIntakeUpload(parts, MAX_UPLOAD_PAGES);
      if (!processed.ok) throw new UploadRequestError(processed.errorCode);

      const fileNameField = formData.get("fileName");
      const originalFileName =
        typeof fileNameField === "string" && fileNameField.trim().length > 0
          ? fileNameField.trim()
          : (fileEntries[0]?.name?.trim() ?? "Dokument");

      if (processed.data.kind === "pdf_or_image") {
        return {
          bytes: processed.data.pdfBytes,
          mimeType: "application/pdf",
          extension: "pdf",
          pageCount: processed.data.pageCount,
          originalFileName,
        };
      }
      return {
        bytes: processed.data.data.bytes,
        mimeType: processed.data.data.mimeType,
        extension: processed.data.data.extension,
        pageCount: 0,
        originalFileName,
      };
    },
    mapError: (err) => {
      if (!(err instanceof UploadRequestError)) return null;
      return { errorCode: err.code, status: STATUS_BY_CODE[err.code] };
    },
  },

  execute: {
    run: ({ parsedInput, access }) =>
      getRequestServices().documents.createFromUpload({
        workspaceId: access.workspace.id,
        uploadedByUserId: access.user.id,
        originalFileName: parsedInput.originalFileName,
        bytes: parsedInput.bytes,
        mimeType: parsedInput.mimeType,
        extension: parsedInput.extension,
        pageCount: parsedInput.pageCount,
        fileHash: fileHash(parsedInput.bytes),
      }),
    mapError: (err) => {
      // F1b's exact-duplicate check: carries the existing document's id in the error
      // envelope's body (never just the standard `{ errorCode }` shape) so the client can
      // link straight to it ("Dieses Dokument ist bereits vorhanden").
      if (err instanceof DuplicateDocumentError) {
        return {
          errorCode: "duplicate_document",
          status: 409,
          body: { errorCode: "duplicate_document", existingDocumentId: err.existingDocumentId },
        };
      }
      return mapUseCaseError<string, DocumentUploadErrorCode>(err, {
        [DOCUMENT_ERROR.quotaTotalExceeded]: { errorCode: "quota_total_exceeded", status: 402 },
        [DOCUMENT_ERROR.quotaMonthlyExceeded]: { errorCode: "quota_monthly_exceeded", status: 402 },
        [DOCUMENT_ERROR.notFound]: { errorCode: "not_found", status: 404 },
      });
    },
  },

  respond: {
    // `after()` schedules the job runner to start once the response has been sent - it
    // never awaits `runDueJobs` itself and so cannot delay the 201, mirroring
    // `src/modules/documents/actions.ts`'s `retryProcessingAction`/`kickProcessingAction`
    // (decisions/0016-processing-pipeline-and-ai.md's `after()` trigger). Without this call,
    // a freshly uploaded document only started processing once a client happened to mount
    // the polling component - this closes that gap. `after()` itself throws when called
    // outside an active request scope (Next's `workUnitAsyncStorage`); a Route Handler
    // invoked by Next always has one, so this can only fire in a test harness that calls
    // this exported `POST` directly without going through Next's own request dispatch - the
    // try/catch keeps that a no-op rather than a 500, so scheduling the trigger can truly
    // never fail the 201 response.
    run: ({ result, access }) => {
      try {
        after(() => runDueJobs({ workspaceId: access.workspace.id, limit: 5 }));
      } catch (err) {
        console.error("[api/documents] after() scheduling failed", err instanceof Error ? err.message : err);
      }
      revalidatePath("/dashboard");
      return Response.json({ documentId: result.id }, { status: 201 });
    },
  },
});
