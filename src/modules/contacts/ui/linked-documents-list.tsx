"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { useTranslations } from "next-intl";

import { Button } from "@/shared/ui-primitives";

import { unlinkDocumentAction } from "../actions";
import type { ContactDocumentLinkView } from "../core/view-types";

/**
 * Scope item 2: "linked documents list with role badge (Absender, Empfänger, Im Auftrag
 * von, Erwähnt) linking to `/dashboard/documents/[id]`" - plus `unlinkDocumentAction` (scope
 * item 4's action list), a plain "Entfernen" button since unlinking is non-destructive (the
 * document itself is untouched, decisions/0019-contacts.md).
 */
export function LinkedDocumentsList({ contactId, documents }: { contactId: string; documents: ContactDocumentLinkView[] }) {
  const t = useTranslations("Contacts.detail");
  const router = useRouter();
  const [pendingKey, startTransition] = useTransition();
  const dateFormatter = new Intl.DateTimeFormat("de", { dateStyle: "medium" });

  function handleUnlink(documentId: string, role: ContactDocumentLinkView["role"]) {
    startTransition(async () => {
      await unlinkDocumentAction({ documentId, contactId, role });
      router.refresh();
    });
  }

  if (documents.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("documentsEmpty")}</p>;
  }

  return (
    <ul className="flex flex-col gap-2">
      {documents.map((doc) => (
        <li
          key={`${doc.documentId}-${doc.role}`}
          className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-2.5"
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-foreground">{t(`documentRoleValues.${doc.role}`)}</span>
            <Link href={`/dashboard/documents/${doc.documentId}`} className="text-sm text-foreground underline">
              {doc.originalFileName}
            </Link>
            <span className="text-xs text-muted-foreground">{dateFormatter.format(new Date(doc.documentCreatedAt))}</span>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={pendingKey}
            onClick={() => handleUnlink(doc.documentId, doc.role)}
          >
            {t("unlinkDocument")}
          </Button>
        </li>
      ))}
    </ul>
  );
}
