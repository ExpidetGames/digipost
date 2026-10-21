"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { TriangleAlert } from "lucide-react";

import { Button } from "@/shared/ui-primitives";

import { acceptProposalAction, rejectProposalAction } from "../actions";
import type { ContactActionErrorCode } from "../core/error-codes";
import type { ContactProposalView } from "../core/view-types";

const EMPTY_VALUE_PLACEHOLDER = "–"; // en dash character (U+2013) - a display glyph,
// not the "no em dash in documentation/product copy" prose character AGENTS.md's "Code"
// section forbids; used only to render an empty/absent field value, same convention as a
// spreadsheet's blank-cell dash.

function displayValue(value: string | null): string {
  return value && value.trim() ? value : EMPTY_VALUE_PLACEHOLDER;
}

/**
 * Scope item 2: pending change proposals with current vs proposed value and
 * Annehmen/Ablehnen, with the IBAN case "visually prominent: a warning callout explaining
 * that bank details changed on a document" - the direct UI counterpart of
 * decisions/0019-contacts.md's no-silent-overwrite, invoice-fraud rationale.
 */
export function ProposalList({ proposals }: { proposals: ContactProposalView[] }) {
  const t = useTranslations("Contacts.detail");
  const tFields = useTranslations("Contacts.fieldLabels");
  const router = useRouter();
  const [pendingId, setPendingId] = useState<string>();
  const [errorByProposal, setErrorByProposal] = useState<Record<string, ContactActionErrorCode>>({});
  const [, startTransition] = useTransition();

  if (proposals.length === 0) return null;

  function handleAccept(id: string) {
    setPendingId(id);
    startTransition(async () => {
      const result = await acceptProposalAction({ proposalId: id });
      if (result.status === "error") {
        setErrorByProposal((current) => ({ ...current, [id]: result.errorCode }));
      }
      setPendingId(undefined);
      router.refresh();
    });
  }

  function handleReject(id: string) {
    setPendingId(id);
    startTransition(async () => {
      const result = await rejectProposalAction({ proposalId: id });
      if (result.status === "error") {
        setErrorByProposal((current) => ({ ...current, [id]: result.errorCode }));
      }
      setPendingId(undefined);
      router.refresh();
    });
  }

  return (
    <ul className="flex flex-col gap-3">
      {proposals.map((proposal) => {
        const isIban = proposal.field === "iban";
        return (
          <li
            key={proposal.id}
            className={
              isIban
                ? "flex flex-col gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3"
                : "flex flex-col gap-2 rounded-lg border border-border p-3"
            }
          >
            {isIban ? (
              <div className="flex items-start gap-2 text-sm text-destructive">
                <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
                <p role="alert">{t("proposalIbanWarning")}</p>
              </div>
            ) : null}
            <p className="text-sm font-medium text-foreground">{tFields.has(proposal.field) ? tFields(proposal.field) : proposal.field}</p>
            <div className="grid gap-2 sm:grid-cols-2">
              <div>
                <p className="text-xs text-muted-foreground">{t("proposalCurrent")}</p>
                <p className="text-sm text-foreground">{displayValue(proposal.currentValue)}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">{t("proposalProposed")}</p>
                <p className="text-sm text-foreground">{displayValue(proposal.proposedValue)}</p>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                disabled={pendingId === proposal.id}
                aria-busy={pendingId === proposal.id}
                onClick={() => handleAccept(proposal.id)}
              >
                {t("proposalAccept")}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={pendingId === proposal.id}
                onClick={() => handleReject(proposal.id)}
              >
                {t("proposalReject")}
              </Button>
            </div>
            {errorByProposal[proposal.id] ? (
              <p role="alert" className="text-sm text-destructive">
                {t(`errors.${errorByProposal[proposal.id]}`)}
              </p>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
