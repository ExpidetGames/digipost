"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import { SEMANTIC_FIELDS, SETTLEMENT_PLATFORMS, type ColumnMapping, type DocumentKind, type SettlementPlatform } from "@/modules/intake";
import { Button, Label } from "@/shared/ui-primitives";

import { confirmIntakeAction, rejectIntakeAction } from "../actions";
import type { TabularProposalIntakeResult } from "../core/intake-result";

const SELECT_CLASSES =
  "h-8 rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30";

/** The tabular source kinds a CSV/TSV file could realistically be classified as - the
 * confirmation UI's editable kind select is scoped to these rather than every
 * `@/modules/intake` `DOCUMENT_KINDS` value (a letter/invoice kind never applies to a tabular
 * upload). */
const TABULAR_KINDS: readonly DocumentKind[] = ["bank_statement", "payout_report", "platform_settlement", "other"];

const NO_COLUMN = "";

/**
 * `/dashboard/documents/[id]`'s intake confirmation panel (F1b, decisions/0020-universal-intake.md's
 * confirmation step): shown for a `pending_confirmation` tabular proposal - the recognized
 * kind and platform (editable), the column mapping as a table of our fields against the
 * file's real header (editable selects), the first rows as the system understood them, and
 * validation problems if any. Confirming re-validates server-side against the FULL file
 * before importing anything (`confirmIntakeAction`); the amount-sign decision itself is not
 * editable here (a documented scope cut, see `decisions/0022-intake-wiring.md`) - only the
 * kind/platform/column mapping.
 *
 * F4 (decisions/0026-platform-settlements.md): confirming can enqueue a real background job
 * (`import-account-transactions`, for `bank_statement`/`payout_report`/`platform_settlement`)
 * whose effect (an account, a settlement report's clearing account and lines) a human expects
 * to see promptly - `kickAction` (the same workspace-scoped "kick" `ProcessingPoller` already
 * uses, passed down from the page seam rather than imported here directly) runs it right after
 * a successful confirm, mirroring the upload route's own `after(() => runDueJobs(...))` so
 * confirming is not silently slower than uploading.
 */
export function IntakeConfirmationPanel({
  documentId,
  proposal,
  kickAction,
}: {
  documentId: string;
  proposal: TabularProposalIntakeResult;
  kickAction: () => Promise<void>;
}) {
  const t = useTranslations("DocumentDetail");
  const tKinds = useTranslations("DocumentKinds");
  const tPlatforms = useTranslations("SettlementPlatforms");
  const tFields = useTranslations("SemanticFields");
  const router = useRouter();

  const [documentKind, setDocumentKind] = useState<DocumentKind>(proposal.documentKind);
  const [platform, setPlatform] = useState<SettlementPlatform | "">(proposal.platform ?? "");
  const [mapping, setMapping] = useState<ColumnMapping>(proposal.columnMapping);
  type Problem = { rowNumber: number; field: string; code: string; message: string };
  const [problems, setProblems] = useState<Problem[]>(proposal.validation.ok ? [] : [...proposal.validation.problems]);
  const [errorCode, setErrorCode] = useState<string>();
  const [confirmPending, startConfirmTransition] = useTransition();
  const [rejectPending, startRejectTransition] = useTransition();

  function handleMappingChange(field: string, column: string) {
    setMapping((current) => {
      const next = { ...current };
      if (column === NO_COLUMN) delete next[field as keyof ColumnMapping];
      else next[field as keyof ColumnMapping] = column;
      return next;
    });
  }

  function handleConfirm() {
    setErrorCode(undefined);
    startConfirmTransition(async () => {
      const result = await confirmIntakeAction({
        documentId,
        documentKind,
        platform: platform || null,
        mapping,
        amountSign: proposal.amountSign,
      });
      if (result.status === "error") {
        setErrorCode(result.errorCode);
        setProblems(result.problems ? [...result.problems] : []);
        return;
      }
      await kickAction();
      router.refresh();
    });
  }

  function handleReject() {
    setErrorCode(undefined);
    startRejectTransition(async () => {
      const result = await rejectIntakeAction({ documentId });
      if (result.status === "error") setErrorCode(result.errorCode);
      router.refresh();
    });
  }

  const showPlatform = documentKind === "payout_report" || documentKind === "platform_settlement";

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-border p-3">
      <h2 className="text-sm font-semibold text-foreground">{t("intakeHeading")}</h2>
      <p className="text-sm text-muted-foreground">{proposal.reason}</p>

      <div className="flex flex-wrap gap-4">
        <div className="flex flex-col gap-1">
          <Label htmlFor="intake-kind">{t("intakeKindLabel")}</Label>
          <select
            id="intake-kind"
            className={SELECT_CLASSES}
            value={documentKind}
            onChange={(event) => setDocumentKind(event.target.value as DocumentKind)}
          >
            {TABULAR_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {tKinds(kind)}
              </option>
            ))}
          </select>
        </div>
        {showPlatform ? (
          <div className="flex flex-col gap-1">
            <Label htmlFor="intake-platform">{t("intakePlatformLabel")}</Label>
            <select
              id="intake-platform"
              className={SELECT_CLASSES}
              value={platform}
              onChange={(event) => setPlatform(event.target.value as SettlementPlatform | "")}
            >
              <option value="">{t("intakePlatformNone")}</option>
              {SETTLEMENT_PLATFORMS.map((p) => (
                <option key={p} value={p}>
                  {tPlatforms(p)}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium text-foreground">{t("intakeMappingHeading")}</h3>
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-border text-xs text-muted-foreground">
              <th className="py-1 pr-2 font-normal">{t("intakeMappingFieldColumn")}</th>
              <th className="py-1 font-normal">{t("intakeMappingSourceColumn")}</th>
            </tr>
          </thead>
          <tbody>
            {SEMANTIC_FIELDS.map((field) => (
              <tr key={field} className="border-b border-border/50">
                <td className="py-1 pr-2 text-foreground">{tFields(field)}</td>
                <td className="py-1">
                  <select
                    aria-label={tFields(field)}
                    className={SELECT_CLASSES}
                    value={mapping[field] ?? NO_COLUMN}
                    onChange={(event) => handleMappingChange(field, event.target.value)}
                  >
                    <option value={NO_COLUMN}>{t("intakeMappingSourceNone")}</option>
                    {proposal.sampleHeader.map((column) => (
                      <option key={column} value={column}>
                        {column}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-col gap-2 overflow-x-auto">
        <h3 className="text-sm font-medium text-foreground">{t("intakeSampleHeading")}</h3>
        <table className="w-full min-w-max text-left text-xs">
          <thead>
            <tr className="border-b border-border text-muted-foreground">
              {proposal.sampleHeader.map((column) => (
                <th key={column} className="py-1 pr-3 font-normal">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {proposal.sampleRows.map((row, rowIndex) => (
              <tr key={rowIndex} className="border-b border-border/50">
                {row.map((cell, cellIndex) => (
                  <td key={cellIndex} className="py-1 pr-3 text-foreground">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {problems.length > 0 ? (
        <div className="flex flex-col gap-1 rounded-lg border border-destructive/40 bg-destructive/5 p-2">
          <h3 className="text-sm font-medium text-destructive">{t("intakeValidationHeading")}</h3>
          <ul className="flex flex-col gap-0.5 text-xs text-destructive">
            {problems.map((problem, index) => (
              <li key={index}>{problem.message}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {errorCode ? (
        <p role="alert" className="text-sm text-destructive">
          {t(`errors.${errorCode}`)}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" disabled={confirmPending || rejectPending} aria-busy={confirmPending} onClick={handleConfirm}>
          {confirmPending ? t("intakeConfirmPending") : t("intakeConfirm")}
        </Button>
        <Button type="button" variant="outline" size="sm" disabled={confirmPending || rejectPending} aria-busy={rejectPending} onClick={handleReject}>
          {rejectPending ? t("intakeRejectPending") : t("intakeReject")}
        </Button>
      </div>
    </div>
  );
}
