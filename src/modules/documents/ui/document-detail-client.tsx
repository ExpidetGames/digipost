"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import { Button } from "@/shared/ui-primitives";

import { deleteDocumentAction, retryProcessingAction } from "../actions";
import { isDerivedCounterpartyKind } from "../core/party-roles";
import type { DocumentDetailView } from "../core/types";
import type { DocumentActionErrorCode } from "../core/error-codes";
import { IntakeConfirmationPanel } from "./intake-confirmation-panel";
import { KindCorrectionControl } from "./kind-correction-control";
import { ProcessingPoller } from "./processing-poller";

/** `/dashboard/documents/[id]`'s metadata panel: the processing state (poller while
 * `uploaded`/`processing`, summary, a per-error-code message with "Erneut verarbeiten" once
 * `failed` - decisions/0016-processing-pipeline-and-ai.md), "Dokumentart ändern" for a
 * processed PDF (decisions/0072-correcting-a-document-s-kind.md), the OCR text section, and
 * delete with confirmation. */
export function DocumentDetailClient({
  document,
  isFakeAiProvider,
  kickAction,
  emailSender,
}: {
  document: DocumentDetailView;
  /** decisions/0075-email-intake.md: the sender of the mail this document arrived with, for a
   * document created by the E-Mail-Eingang (it has no uploader). */
  emailSender?: string | null;
  /** Whether the fake AI provider is bound (requirement 9): shows a "Testmodus"-hint. */
  isFakeAiProvider: boolean;
  /** Schedules `runDueJobs` for the caller's own workspace (the "kick" trigger); passed down
   * from the page seam rather than imported here directly, so this component stays a plain
   * presentation client island. */
  kickAction: () => Promise<void>;
}) {
  const t = useTranslations("DocumentDetail");
  const tKinds = useTranslations("DocumentKinds");
  const tPlatforms = useTranslations("SettlementPlatforms");
  const router = useRouter();
  const [deleteError, setDeleteError] = useState<DocumentActionErrorCode>();
  const [retryError, setRetryError] = useState<DocumentActionErrorCode>();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deletePending, startDeleteTransition] = useTransition();
  const [retryPending, startRetryTransition] = useTransition();

  const isProcessing = document.status === "uploaded" || document.status === "processing";

  // A fixed time zone: the server (UTC) and the browser must render the same time, or React
  // reports a hydration mismatch. The product is DACH-only (decisions/0013).
  const formattedCreatedAt = new Intl.DateTimeFormat("de", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Berlin" }).format(
    new Date(document.createdAt),
  );
  const formattedDocumentDate = document.documentDate
    ? new Intl.DateTimeFormat("de", { dateStyle: "medium" }).format(new Date(document.documentDate))
    : null;
  // C2 (decisions/0021-extraction-direction-and-invoice-fields.md): direction, invoice
  // fields, and linked contacts. `null`/`unknown` direction and a `null` invoice (a
  // non-invoice document, or one not processed yet) simply render nothing for that section.
  const formattedDueDate = document.dueDate ? new Intl.DateTimeFormat("de", { dateStyle: "medium" }).format(new Date(document.dueDate)) : null;
  const formattedAmount =
    document.totalAmountCents !== null
      ? new Intl.NumberFormat("de-DE", { style: "currency", currency: document.currency ?? "EUR" }).format(document.totalAmountCents / 100)
      : null;
  const hasInvoiceFields = Boolean(
    document.invoiceNumber || formattedAmount || formattedDueDate || document.paymentIban || document.paymentReference || document.paidNote,
  );
  // The self-counterparty guard (H2-wave2.md, decisions/0036-guided-extraction.md's wave 2):
  // a "derived"-mode kind can only ever resolve to `"outgoing"`/`"incoming"` (from the kind
  // itself) or `"unknown"` (the guard fired because the extracted counterparty resolved to the
  // workspace's own company - `src/persistence/use-cases/documents-use-cases.ts`'s
  // `processOcrDocument`) - there is no third path, so this exact combination means the
  // classified `kind` was probably wrong, worth a human's attention.
  const showUnclearDirectionHint = isDerivedCounterpartyKind(document.kind) && document.direction === "unknown";
  // decisions/0072-correcting-a-document-s-kind.md: only a processed PDF has a classifier-chosen
  // kind to correct; a structured upload's kind comes from its own intake flow.
  const canCorrectKind = document.status === "done" && document.mimeType === "application/pdf";

  function handleDelete() {
    setDeleteError(undefined);
    startDeleteTransition(async () => {
      const result = await deleteDocumentAction({ documentId: document.id });
      if (result.status === "error") {
        setDeleteError(result.errorCode);
        setConfirmingDelete(false);
        return;
      }
      router.push("/dashboard");
    });
  }

  function handleRetry() {
    setRetryError(undefined);
    startRetryTransition(async () => {
      const result = await retryProcessingAction({ documentId: document.id });
      if (result.status === "error") setRetryError(result.errorCode);
      router.refresh();
    });
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <ProcessingPoller active={isProcessing} kickAction={kickAction} />

      <div className="h-[70vh] overflow-hidden rounded-lg border border-border lg:h-[80vh]">
        <iframe title={document.title ?? document.originalFileName} src={`/api/documents/${document.id}/file`} className="h-full w-full" />
      </div>

      <div className="flex flex-col gap-5">
        {isFakeAiProvider ? (
          <p className="rounded-lg border border-dashed border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
            {t("testModeHint")}
          </p>
        ) : null}

        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-semibold text-foreground">{document.title ?? document.originalFileName}</h1>
            {document.direction === "incoming" || document.direction === "outgoing" ? (
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-foreground">{t(`directionValues.${document.direction}`)}</span>
            ) : null}
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-foreground">{tKinds(document.kind)}</span>
            {document.platform ? <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-foreground">{tPlatforms(document.platform)}</span> : null}
            {document.intakeStatus === "pending_confirmation" ? (
              <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">{t("intakeHeading")}</span>
            ) : null}
          </div>
          {document.sender ? <p className="text-sm text-muted-foreground">{document.sender}</p> : null}
        </div>

        {canCorrectKind ? <KindCorrectionControl key={document.kind} documentId={document.id} currentKind={document.kind} /> : null}

        {document.possibleDuplicateOf ? (
          <p role="alert" className="rounded-lg border border-dashed border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {t("possibleDuplicateHint")}{" "}
            <Link href={`/dashboard/documents/${document.possibleDuplicateOf.id}`} className="underline">
              {document.possibleDuplicateOf.originalFileName}
            </Link>
          </p>
        ) : null}

        {showUnclearDirectionHint ? (
          <p role="alert" className="rounded-lg border border-dashed border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {t("unclearDirectionHint")}
          </p>
        ) : null}

        {document.summary ? <p className="text-sm text-foreground">{document.summary}</p> : null}

        <dl className="flex flex-col gap-1 text-sm">
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground">{t("uploadDate")}</dt>
            <dd className="text-foreground">{formattedCreatedAt}</dd>
          </div>
          {formattedDocumentDate ? (
            <div className="flex justify-between gap-2">
              <dt className="text-muted-foreground">{t("documentDate")}</dt>
              <dd className="text-foreground">{formattedDocumentDate}</dd>
            </div>
          ) : null}
          {document.uploadedByEmail ? (
            <div className="flex justify-between gap-2">
              <dt className="text-muted-foreground">{t("uploadedBy")}</dt>
              <dd className="text-foreground">{document.uploadedByEmail}</dd>
            </div>
          ) : null}
          {!document.uploadedByEmail && emailSender ? (
            <div className="flex justify-between gap-2">
              <dt className="text-muted-foreground">{t("receivedByEmailFrom")}</dt>
              <dd className="break-all text-foreground">{emailSender}</dd>
            </div>
          ) : null}
          <div className="flex justify-between gap-2">
            <dt className="text-muted-foreground">{t("status")}</dt>
            <dd className="text-foreground">
              {t(`statusValues.${document.status}`)}
              {isProcessing ? <span className="ml-1 inline-block animate-pulse text-muted-foreground">…</span> : null}
            </dd>
          </div>
        </dl>

        {hasInvoiceFields ? (
          <dl className="flex flex-col gap-1 rounded-lg border border-border p-3 text-sm">
            <h2 className="mb-1 text-sm font-semibold text-foreground">{t("invoiceHeading")}</h2>
            {document.invoiceNumber ? (
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">{t("invoiceNumber")}</dt>
                <dd className="text-foreground">{document.invoiceNumber}</dd>
              </div>
            ) : null}
            {formattedAmount ? (
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">{t("invoiceAmount")}</dt>
                <dd className="text-foreground">{formattedAmount}</dd>
              </div>
            ) : null}
            {formattedDueDate ? (
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">{t("invoiceDueDate")}</dt>
                <dd className="text-foreground">{formattedDueDate}</dd>
              </div>
            ) : null}
            {document.paymentIban ? (
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">{t("invoicePaymentIban")}</dt>
                <dd className="text-foreground">{document.paymentIban}</dd>
              </div>
            ) : null}
            {document.paymentReference ? (
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">{t("invoicePaymentReference")}</dt>
                <dd className="text-foreground">{document.paymentReference}</dd>
              </div>
            ) : null}
            {document.paidNote ? (
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">{t("invoicePaidNote")}</dt>
                <dd className="text-foreground">{document.paidNote}</dd>
              </div>
            ) : null}
          </dl>
        ) : null}

        {document.intakeStatus === "pending_confirmation" && document.intakeResult?.type === "tabular_proposal" ? (
          <IntakeConfirmationPanel documentId={document.id} proposal={document.intakeResult} kickAction={kickAction} />
        ) : null}

        {document.intakeStatus === "rejected" ? <p className="text-sm text-muted-foreground">{t("intakeRejectedNote")}</p> : null}

        {document.intakeResult?.type === "bank_statement" ? (
          <dl className="flex flex-col gap-1 rounded-lg border border-border p-3 text-sm">
            <h2 className="mb-1 text-sm font-semibold text-foreground">{t("intakeImportedHeading")}</h2>
            <div className="flex justify-between gap-2">
              <dt className="text-muted-foreground">{t("intakeTransactionCount", { count: document.intakeResult.transactionCount })}</dt>
            </div>
            <p className={document.intakeResult.allStatementsReconcile ? "text-muted-foreground" : "text-destructive"}>
              {document.intakeResult.allStatementsReconcile ? t("intakeReconciles") : t("intakeDoesNotReconcile")}
            </p>
          </dl>
        ) : null}

        {document.intakeResult?.type === "tabular_confirmed" ? (
          <dl className="flex flex-col gap-1 rounded-lg border border-border p-3 text-sm">
            <h2 className="mb-1 text-sm font-semibold text-foreground">{t("intakeImportedHeading")}</h2>
            <p className="text-muted-foreground">{t("intakeRowCount", { count: document.intakeResult.rowCount })}</p>
          </dl>
        ) : null}

        {document.contacts.length > 0 ? (
          <div className="flex flex-col gap-2">
            <h2 className="text-sm font-semibold text-foreground">{t("contactsHeading")}</h2>
            <ul className="flex flex-col gap-1">
              {document.contacts.map((contact) => (
                <li key={`${contact.contactId}-${contact.role}`} className="flex items-center justify-between gap-2 text-sm">
                  <Link href={`/dashboard/contacts/${contact.contactId}`} className="text-foreground underline">
                    {contact.name}
                  </Link>
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    {t(`contactRoles.${contact.role}`)}
                    {!contact.verified ? (
                      <span className="rounded-full bg-muted px-2 py-0.5 text-foreground">{t("contactUnverified")}</span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {document.status === "failed" ? (
          <div className="flex flex-col gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3">
            <p role="alert" className="text-sm text-destructive">
              {document.errorCode ? t(`errors.${document.errorCode}`) : t("errors.processing_failed")}
            </p>
            <Button type="button" variant="outline" size="sm" disabled={retryPending} aria-busy={retryPending} onClick={handleRetry}>
              {t("retryProcessing")}
            </Button>
            {retryError ? (
              <p role="alert" className="text-sm text-destructive">
                {t(`errors.${retryError}`)}
              </p>
            ) : null}
          </div>
        ) : null}

        <div className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold text-foreground">{t("ocrHeading")}</h2>
          {document.status === "done" && document.ocrText ? (
            <p className="max-h-64 overflow-y-auto whitespace-pre-wrap text-sm text-foreground">{document.ocrText}</p>
          ) : (
            <p className="text-sm text-muted-foreground">{t(isProcessing ? "ocrProcessing" : "ocrPending")}</p>
          )}
        </div>

        <div className="flex flex-col gap-2">
          {confirmingDelete ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-muted-foreground">{t("deleteConfirm")}</span>
              <Button type="button" variant="destructive" size="sm" disabled={deletePending} aria-busy={deletePending} onClick={handleDelete}>
                {t("deleteConfirmYes")}
              </Button>
              <Button type="button" variant="outline" size="sm" disabled={deletePending} onClick={() => setConfirmingDelete(false)}>
                {t("cancel")}
              </Button>
            </div>
          ) : (
            <Button type="button" variant="destructive" size="sm" onClick={() => setConfirmingDelete(true)}>
              {t("delete")}
            </Button>
          )}
          {deleteError ? (
            <p role="alert" className="text-sm text-destructive">
              {t(`errors.${deleteError}`)}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
