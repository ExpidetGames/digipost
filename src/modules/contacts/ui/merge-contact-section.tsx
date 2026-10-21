"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import { Button, Input } from "@/shared/ui-primitives";

import { mergeContactsAction } from "../actions";
import type { ContactActionErrorCode } from "../core/error-codes";
import type { ContactMergeOption } from "../core/view-types";

/**
 * Scope item 2: "Zusammenführen" (pick another contact via search; confirmation dialog
 * stating what moves). `options` is the whole rest of the workspace's contact book
 * (`src/modules/contacts/server`'s `listMergeOptionsProjection`, already excludes this
 * contact) - filtered client-side as the admin types, no round trip per keystroke, same
 * "acceptable at this product's scale" reasoning `decisions/0019-contacts.md` already
 * applies to the matching candidate pool.
 */
export function MergeContactSection({
  sourceId,
  sourceName,
  options,
}: {
  sourceId: string;
  sourceName: string;
  options: ContactMergeOption[];
}) {
  const t = useTranslations("Contacts.detail");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [target, setTarget] = useState<ContactMergeOption>();
  const [errorCode, setErrorCode] = useState<ContactActionErrorCode>();
  const [pending, startTransition] = useTransition();

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options.slice(0, 20);
    return options.filter((o) => o.name.toLowerCase().includes(q)).slice(0, 20);
  }, [options, query]);

  function reset() {
    setOpen(false);
    setQuery("");
    setTarget(undefined);
    setErrorCode(undefined);
  }

  function handleConfirm() {
    if (!target) return;
    setErrorCode(undefined);
    startTransition(async () => {
      const result = await mergeContactsAction({ sourceId, targetId: target.id });
      if (result.status === "error") {
        setErrorCode(result.errorCode);
        return;
      }
      router.push(`/dashboard/contacts/${result.data.id}`);
    });
  }

  if (!open) {
    return (
      <Button type="button" variant="outline" onClick={() => setOpen(true)}>
        {t("merge")}
      </Button>
    );
  }

  if (target) {
    return (
      <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
        <p className="text-sm text-foreground">{t("mergeConfirm", { source: sourceName, target: target.name })}</p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="destructive" size="sm" disabled={pending} aria-busy={pending} onClick={handleConfirm}>
            {t("mergeConfirmYes")}
          </Button>
          <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => setTarget(undefined)}>
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

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
      <Input
        autoFocus
        placeholder={t("mergeSearchPlaceholder")}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("mergeNoResults")}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {filtered.map((option) => (
            <li key={option.id}>
              <button
                type="button"
                className="w-full rounded-lg px-2 py-1.5 text-left text-sm text-foreground hover:bg-muted"
                onClick={() => setTarget(option)}
              >
                {option.name}
              </button>
            </li>
          ))}
        </ul>
      )}
      <Button type="button" variant="outline" size="sm" onClick={reset}>
        {t("cancel")}
      </Button>
    </div>
  );
}
