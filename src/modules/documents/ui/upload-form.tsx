"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import { Button, Input, Label } from "@/shared/ui-primitives";
import { CameraScanner } from "@/modules/scanner/client";

import { uploadDocument } from "../core/upload-client";
import type { DocumentUploadErrorCode } from "../core/error-codes";
import {
  applyGroupResult,
  buildBulkUploadRows,
  classifyUploadGroups,
  countSettledRows,
  markGroupUploading,
  shouldShowImageSplitSwitch,
  type BulkUploadRow,
} from "../core/bulk-upload";

// F1b (decisions/0020-universal-intake.md), fixed by decisions/0028-mt940-support.md's own
// bug report: the server sniffs the real content by bytes and never trusts a file's extension
// or declared MIME type either way - an `accept` attribute here can therefore only ever get in
// the way, never add safety. It used to list `.csv,.tsv,.xml` explicitly, which meant the OS
// file picker silently HID a real bank export whose extension the list did not happen to
// name (a Musterbank CAMT.053 export named `....camt053v08`, or any `.mt940`/`.sta`/`.txt` MT940
// export) - the file the server would have handled correctly never even reached it. No
// `accept` at all (see the `<input>` below) means the picker always shows every file; the
// visible German hint text (`Scan.dropzone`/`Scan.description`) is what actually tells a user
// what is supported. Drag-and-drop already had no such filter (`addFiles` never inspected
// `dataTransfer.files` by extension), so it needed no change to "follow the same rule".

// F5 (decisions/0027-hardening-and-deletion.md): the 4 MB upload cap applies to a structured
// intake file exactly like a scanned PDF (decisions/0012-object-storage.md's Vercel-body-limit
// reason) - a yearly bank-statement/CSV/MT940 export commonly exceeds it, and unlike a scanned
// letter there is no page-count knob to shrink it by. Not raised in this phase (a presigned
// direct-to-storage upload is the eventual fix, out of scope here); shown as an extra hint only
// for a structured file's own `file_too_large`, never for a PDF/image upload. `file_too_large`
// is decided purely by byte count, BEFORE the server ever sniffs the content
// (`src/app/api/documents/route.ts`'s `readRequestBodyWithByteCap`/`Content-Length` check), so
// there is no server-reported "kind" to key this hint off for that specific error - the file
// name is the only signal available, hence the broadened pattern below rather than a server
// round-trip. Covers every bank-export extension observed so far, including a version-suffixed
// CAMT.053 export (`.camt053v08`) and the common plain-text MT940 extensions.
const STRUCTURED_FILE_PATTERN = /\.(xml|csv|tsv|mt940|sta|txt|camt053(v\d+)?)$/i;

function includesStructuredFile(files: File[]): boolean {
  return files.some((file) => STRUCTURED_FILE_PATTERN.test(file.name));
}

/** Shared by the single-upload quota error and the bulk queue's own quota-stop summary
 * (both mirror decisions/0017-billing-tiers-and-packages.md's tarif link / admin hint). */
function QuotaErrorExtra({ canManageBilling }: { canManageBilling: boolean }) {
  const t = useTranslations("Scan");
  return (
    <>
      {" "}
      <a href="/dashboard/billing" className="underline">
        {t("errors.quotaLink")}
      </a>
      {canManageBilling ? null : <> {t("errors.quotaMemberHint")}</>}
    </>
  );
}

const QUOTA_ERROR_CODES = new Set<DocumentUploadErrorCode>(["quota_total_exceeded", "quota_monthly_exceeded"]);

/**
 * G2 (decisions/0030-bulk-upload.md): the per-file progress list a multi-document selection
 * uploads through - one row per file (even when several images share one request/document),
 * a "wartet"/"lädt hoch"/"fertig"/"Fehler" state per row, and the "X von Y" counter. A quota
 * error's row also gets the same tarif link / admin hint as the single-upload error above.
 */
function BulkUploadList({ rows, canManageBilling }: { rows: BulkUploadRow[]; canManageBilling: boolean }) {
  const t = useTranslations("Scan");
  const quotaStopRow = rows.find((row) => row.status === "error" && row.errorCode && QUOTA_ERROR_CODES.has(row.errorCode));

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-muted-foreground">{t("bulk.counter", { done: countSettledRows(rows), total: rows.length })}</p>
      <ul className="flex flex-col gap-1 text-sm">
        {rows.map((row) => (
          <li key={row.id} className="flex items-center justify-between gap-2">
            <span className="text-foreground">{row.fileName}</span>
            <span className={row.status === "error" ? "text-destructive" : "text-muted-foreground"}>
              {t(`bulk.status.${row.status}`)}
              {row.status === "error" && row.errorCode ? `: ${t(`errors.${row.errorCode}`)}` : ""}
            </span>
          </li>
        ))}
      </ul>
      {quotaStopRow ? (
        <p role="alert" className="text-sm text-destructive">
          {t("bulk.stoppedByQuota")}
          <QuotaErrorExtra canManageBilling={canManageBilling} />
        </p>
      ) : null}
    </div>
  );
}

/**
 * `/dashboard/scan` ("Post erfassen"): tabs "Kamera" (a placeholder slot P2c's camera
 * scanner fills, `src/modules/scanner`) and "Datei hochladen" (this component's own file
 * input + drag-and-drop, working today). Both tabs end up calling the same
 * `uploadDocument` helper, so P2c only needs to render its own capture UI and call it with
 * the resulting JPEG pages - no change here.
 */
export function UploadForm({ canManageBilling }: { canManageBilling: boolean }) {
  const t = useTranslations("Scan");
  const router = useRouter();
  const [tab, setTab] = useState<"camera" | "file">("file");
  const [files, setFiles] = useState<File[]>([]);
  const [fileName, setFileName] = useState("");
  const [errorCode, setErrorCode] = useState<DocumentUploadErrorCode>();
  const [duplicateDocumentId, setDuplicateDocumentId] = useState<string>();
  const [dragging, setDragging] = useState(false);
  const [splitImages, setSplitImages] = useState(false);
  const [bulkRows, setBulkRows] = useState<BulkUploadRow[] | null>(null);
  const [pending, startTransition] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  function addFiles(list: FileList | null) {
    if (!list || list.length === 0) return;
    setErrorCode(undefined);
    setBulkRows(null);
    setFiles(Array.from(list));
  }

  // G2 (decisions/0030-bulk-upload.md): several selected PDFs/structured files always become
  // one document each; several images stay pages of one document unless `splitImages` is on;
  // a mixed selection combines both rules. `POST /api/documents` still means exactly one
  // document per request (unchanged) - this only decides how many requests the selection
  // becomes. `groups.length <= 1` is the pre-existing single-document path (unchanged
  // behavior: redirects straight to the new document).
  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (files.length === 0) {
      setErrorCode("no_file");
      return;
    }
    setErrorCode(undefined);
    setDuplicateDocumentId(undefined);
    setBulkRows(null);

    const groups = classifyUploadGroups(files, splitImages);
    if (groups.length <= 1) {
      startTransition(async () => {
        const result = await uploadDocument(files, fileName);
        if (result.status === "error") {
          setErrorCode(result.errorCode);
          setDuplicateDocumentId(result.existingDocumentId);
          return;
        }
        router.push(`/dashboard/documents/${result.documentId}`);
      });
      return;
    }

    startTransition(async () => {
      let rows = buildBulkUploadRows(groups);
      setBulkRows(rows);
      // Sequential, one request at a time (assignment: "sequentially or 2 at a time" - the
      // simpler of the two): a quota error stops the queue outright (further requests would
      // only fail the same way), any other per-file error just marks that row and continues.
      for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
        rows = markGroupUploading(rows, groupIndex);
        setBulkRows(rows);
        const result = await uploadDocument(groups[groupIndex]!);
        const applied = applyGroupResult(
          rows,
          groupIndex,
          result.status === "success" ? { status: "success" } : { status: "error", errorCode: result.errorCode, existingDocumentId: result.existingDocumentId },
        );
        rows = applied.rows;
        setBulkRows(rows);
        if (applied.stopped) break;
      }
      router.refresh();
    });
  }

  // Recomputed on every render (cheap, pure): whether the CURRENT selection would become
  // more than one document, used to hide the single-document "Bezeichnung" field (it cannot
  // meaningfully name several documents at once) before the user even submits.
  const isBulkSelection = classifyUploadGroups(files, splitImages).length > 1;

  let selectionPreview: React.ReactNode = null;
  if (bulkRows) {
    selectionPreview = <BulkUploadList rows={bulkRows} canManageBilling={canManageBilling} />;
  } else if (files.length > 0) {
    selectionPreview = (
      <ul className="flex flex-col gap-1 text-sm text-foreground">
        {files.map((file) => (
          <li key={`${file.name}-${file.size}`}>{file.name}</li>
        ))}
      </ul>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div role="tablist" aria-label={t("tabs.label")} className="flex gap-2 border-b border-border">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "camera"}
          onClick={() => setTab("camera")}
          className={`px-3 py-2 text-sm font-medium ${tab === "camera" ? "border-b-2 border-primary text-foreground" : "text-muted-foreground"}`}
        >
          {t("tabs.camera")}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "file"}
          onClick={() => setTab("file")}
          className={`px-3 py-2 text-sm font-medium ${tab === "file" ? "border-b-2 border-primary text-foreground" : "text-muted-foreground"}`}
        >
          {t("tabs.file")}
        </button>
      </div>

      {tab === "camera" ? (
        <CameraScanner onSwitchToFileTab={() => setTab("file")} />
      ) : (
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div
            role="button"
            tabIndex={0}
            onClick={() => inputRef.current?.click()}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") inputRef.current?.click();
            }}
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              addFiles(event.dataTransfer.files);
            }}
            className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-10 text-center text-sm transition-colors ${
              dragging ? "border-primary bg-muted" : "border-border text-muted-foreground"
            }`}
          >
            <p>{t("dropzone")}</p>
            <input
              ref={inputRef}
              type="file"
              multiple
              // No `accept` attribute - see this file's own header comment: the server sniffs
              // real content by bytes, so filtering the OS picker by extension/MIME type can
              // only ever hide a file the server would have handled correctly.
              className="sr-only"
              onChange={(event) => addFiles(event.target.files)}
            />
          </div>

          {selectionPreview}

          {/* G2 (decisions/0030-bulk-upload.md): only shown with 2+ images in the current
              selection - a single image, or none, has nothing to split from. */}
          {shouldShowImageSplitSwitch(files) ? (
            <label className="flex items-center gap-2 text-sm text-foreground">
              <input type="checkbox" checked={splitImages} onChange={(event) => setSplitImages(event.target.checked)} />
              {t("bulk.splitImagesSwitch")}
            </label>
          ) : null}

          {isBulkSelection ? null : (
            <div className="flex flex-col gap-2">
              <Label htmlFor="scan-file-name">{t("fileNameLabel")}</Label>
              <Input
                id="scan-file-name"
                value={fileName}
                onChange={(event) => setFileName(event.target.value)}
                placeholder={t("fileNamePlaceholder")}
              />
            </div>
          )}

          {errorCode ? (
            <p role="alert" className="text-sm text-destructive">
              {t(`errors.${errorCode}`)}
              {errorCode === "quota_total_exceeded" || errorCode === "quota_monthly_exceeded" ? <QuotaErrorExtra canManageBilling={canManageBilling} /> : null}
              {errorCode === "duplicate_document" && duplicateDocumentId ? (
                <>
                  {" "}
                  <a href={`/dashboard/documents/${duplicateDocumentId}`} className="underline">
                    {t("errors.duplicateLink")}
                  </a>
                </>
              ) : null}
              {errorCode === "file_too_large" && includesStructuredFile(files) ? <> {t("errors.fileTooLargeStructuredHint")}</> : null}
            </p>
          ) : null}

          <Button type="submit" disabled={pending} aria-busy={pending}>
            {pending ? t("submitPending") : t("submit")}
          </Button>
        </form>
      )}
    </div>
  );
}
