"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import type { DocumentKind } from "@/modules/intake";
import { Button, Label } from "@/shared/ui-primitives";

import { reclassifyDocumentAction } from "../actions";
import type { DocumentActionErrorCode } from "../core/error-codes";
import { isReclassifiableKind, RECLASSIFIABLE_KINDS, type ReclassifiableKind } from "../core/reclassification";

const SELECT_CLASSES =
  "h-8 rounded-lg border border-input bg-transparent px-2.5 py-1 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30";

const NO_KIND = "";

/**
 * "Dokumentart ändern" (decisions/0072-correcting-a-document-s-kind.md): a collapsed link that
 * opens a kind select plus a confirm button. Confirming calls `reclassifyDocumentAction`, which
 * marks the document `processing` and re-extracts it as the chosen kind; `router.refresh()`
 * then hands the new status to `DocumentDetailClient`, whose `ProcessingPoller` takes over.
 * Rendered by the detail page only for a processed (`done`) PDF. The server re-checks every
 * guard (payment links, a clearing-account settlement) and this control just translates the
 * returned code.
 */
export function KindCorrectionControl({ documentId, currentKind }: { documentId: string; currentKind: DocumentKind }) {
  const t = useTranslations("DocumentDetail");
  const tKinds = useTranslations("DocumentKinds");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<ReclassifiableKind | typeof NO_KIND>(isReclassifiableKind(currentKind) ? currentKind : NO_KIND);
  const [errorCode, setErrorCode] = useState<DocumentActionErrorCode>();
  const [pending, startTransition] = useTransition();

  const canConfirm = kind !== NO_KIND && kind !== currentKind && !pending;

  function handleConfirm() {
    if (kind === NO_KIND) return;
    setErrorCode(undefined);
    startTransition(async () => {
      const result = await reclassifyDocumentAction({ documentId, kind });
      if (result.status === "error") {
        setErrorCode(result.errorCode);
        return;
      }
      setOpen(false);
      router.refresh();
    });
  }

  function handleCancel() {
    setOpen(false);
    setErrorCode(undefined);
    setKind(isReclassifiableKind(currentKind) ? currentKind : NO_KIND);
  }

  if (!open) {
    return (
      <Button type="button" variant="link" size="xs" className="self-start px-0" onClick={() => setOpen(true)}>
        {t("reclassifyOpen")}
      </Button>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
      <div className="flex flex-col gap-1">
        <Label htmlFor="reclassify-kind">{t("reclassifyKindLabel")}</Label>
        <select
          id="reclassify-kind"
          className={SELECT_CLASSES}
          value={kind}
          disabled={pending}
          onChange={(event) => setKind(event.target.value as ReclassifiableKind | typeof NO_KIND)}
        >
          {kind === NO_KIND ? (
            <option value={NO_KIND} disabled>
              {t("reclassifyKindPlaceholder")}
            </option>
          ) : null}
          {RECLASSIFIABLE_KINDS.map((option) => (
            <option key={option} value={option}>
              {tKinds(option)}
            </option>
          ))}
        </select>
      </div>
      <p className="text-sm text-muted-foreground">{t("reclassifyHint")}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" disabled={!canConfirm} aria-busy={pending} onClick={handleConfirm}>
          {pending ? t("reclassifyPending") : t("reclassifyConfirm")}
        </Button>
        <Button type="button" variant="outline" size="sm" disabled={pending} onClick={handleCancel}>
          {t("cancel")}
        </Button>
      </div>
      {errorCode ? (
        <p role="alert" className="text-sm text-destructive">
          {t(`errors.${errorCode}`)}
        </p>
      ) : null}
    </div>
  );
}
