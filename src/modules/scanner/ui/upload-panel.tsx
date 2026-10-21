"use client";

// The final "Hochladen" step (product requirements 5-6): re-encodes every page's master at
// the per-page byte budget (`core/encoding-budget.ts`), refuses to submit if the total would
// still exceed the upload limit (rather than ever sending an over-budget request - see
// `canvas-pipeline.ts`'s `encodePageForUpload` doc comment), then calls the same
// `uploadDocument` helper `src/modules/documents`'s own file-upload tab uses.
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import { uploadDocument, type UploadDocumentResult } from "@/modules/documents/client";
import { Button, Input, Label } from "@/shared/ui-primitives";

import { MAX_UPLOAD_TOTAL_BYTES } from "../core/limits";
import { perPageByteBudget } from "../core/encoding-budget";
import type { ScannerPage } from "../core/types";
import { encodePageForUpload } from "./canvas-pipeline";

export interface UploadPanelProps {
  pages: ScannerPage[];
}

type UploadErrorCode = Extract<UploadDocumentResult, { status: "error" }>["errorCode"];

type UploadState =
  | { status: "idle" }
  | { status: "busy" }
  | { status: "too-large" }
  | { status: "error"; errorCode: UploadErrorCode };

export function UploadPanel({ pages }: UploadPanelProps) {
  // `Scan.errors` (src/i18n/messages/de.json): the exact same message keys
  // `src/modules/documents/ui/upload-form.tsx` uses for `uploadDocument`'s error codes -
  // reused here rather than duplicated, since `uploadDocument` returns the same
  // `DocumentUploadErrorCode` union in both places.
  const tErrors = useTranslations("Scan.errors");
  const t = useTranslations("Scanner.upload");
  const router = useRouter();
  const [fileName, setFileName] = useState("");
  const [state, setState] = useState<UploadState>({ status: "idle" });
  const [pending, startTransition] = useTransition();

  function handleUpload() {
    if (pages.length === 0) return;
    setState({ status: "busy" });
    startTransition(async () => {
      const perPageBudget = perPageByteBudget(MAX_UPLOAD_TOTAL_BYTES, pages.length);
      const encoded = await Promise.all(
        pages.map((page) => encodePageForUpload(page.masterBlob, page.rotation, page.filter, perPageBudget)),
      );
      const totalBytes = encoded.reduce((sum, page) => sum + page.blob.size, 0);
      if (totalBytes > MAX_UPLOAD_TOTAL_BYTES) {
        setState({ status: "too-large" });
        return;
      }

      const files = encoded.map(
        (page, index) => new File([page.blob], `seite-${index + 1}.jpg`, { type: "image/jpeg" }),
      );
      const result = await uploadDocument(files, fileName);
      if (result.status === "error") {
        setState({ status: "error", errorCode: result.errorCode });
        return;
      }
      router.push(`/dashboard/documents/${result.documentId}`);
    });
  }

  const busy = pending || state.status === "busy";

  return (
    <div className="flex flex-col gap-4 border-t border-border pt-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="scanner-file-name">{t("fileNameLabel")}</Label>
        <Input
          id="scanner-file-name"
          value={fileName}
          onChange={(event) => setFileName(event.target.value)}
          placeholder={t("fileNamePlaceholder")}
        />
      </div>

      {state.status === "too-large" ? (
        <p role="alert" className="text-sm text-destructive">
          {t("tooLarge")}
        </p>
      ) : null}

      {state.status === "error" ? (
        <p role="alert" className="text-sm text-destructive">
          {tErrors(state.errorCode)}
          {state.errorCode === "quota_total_exceeded" || state.errorCode === "quota_monthly_exceeded" ? (
            <>
              {" "}
              <a href="/dashboard/billing" className="underline">
                {tErrors("quotaLink")}
              </a>
            </>
          ) : null}
        </p>
      ) : null}

      <Button type="button" disabled={pages.length === 0 || busy} aria-busy={busy} onClick={handleUpload}>
        {busy ? t("uploadPending") : t("upload")}
      </Button>
    </div>
  );
}
