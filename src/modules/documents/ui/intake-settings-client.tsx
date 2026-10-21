"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

import { Button } from "@/shared/ui-primitives";

import { resetIntakeFingerprintAction } from "../actions";
import type { IntakeFingerprintOption } from "../core/types";

/**
 * `/dashboard/settings/intake` ("Erkannte Quellen", F1b, decisions/0020-universal-intake.md's
 * "confirm once" flow, admin-only): every confirmed tabular source layout for this workspace -
 * kind, platform, use count, last used, and "Zuordnung zurücksetzen".
 */
export function IntakeSettingsClient({ fingerprints }: { fingerprints: IntakeFingerprintOption[] }) {
  const t = useTranslations("IntakeSettings");
  const tKinds = useTranslations("DocumentKinds");
  const tPlatforms = useTranslations("SettlementPlatforms");
  const router = useRouter();
  const [confirmingId, setConfirmingId] = useState<string>();
  const [pendingId, setPendingId] = useState<string>();
  const [, startTransition] = useTransition();

  // A fixed time zone: the server (UTC) and the browser must render the same time, or React
  // reports a hydration mismatch. The product is DACH-only (decisions/0013).
  const dateFormatter = new Intl.DateTimeFormat("de", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Berlin" });

  function handleReset(id: string) {
    setPendingId(id);
    startTransition(async () => {
      await resetIntakeFingerprintAction({ fingerprintId: id });
      setPendingId(undefined);
      setConfirmingId(undefined);
      router.refresh();
    });
  }

  if (fingerprints.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("empty")}</p>;
  }

  return (
    <table className="w-full text-left text-sm">
      <thead>
        <tr className="border-b border-border text-xs text-muted-foreground">
          <th className="py-2 pr-3 font-normal">{t("columnKind")}</th>
          <th className="py-2 pr-3 font-normal">{t("columnPlatform")}</th>
          <th className="py-2 pr-3 font-normal">{t("columnUseCount")}</th>
          <th className="py-2 pr-3 font-normal">{t("columnLastUsedAt")}</th>
          <th className="py-2 font-normal" />
        </tr>
      </thead>
      <tbody>
        {fingerprints.map((fingerprint) => (
          <tr key={fingerprint.id} className="border-b border-border/50">
            <td className="py-2 pr-3 text-foreground">{tKinds(fingerprint.documentKind)}</td>
            <td className="py-2 pr-3 text-foreground">{fingerprint.platform ? tPlatforms(fingerprint.platform) : "–"}</td>
            <td className="py-2 pr-3 text-foreground">{fingerprint.useCount}</td>
            <td className="py-2 pr-3 text-foreground">{dateFormatter.format(new Date(fingerprint.lastUsedAt))}</td>
            <td className="py-2 text-right">
              {confirmingId === fingerprint.id ? (
                <div className="flex items-center justify-end gap-2">
                  <span className="text-xs text-muted-foreground">{t("resetConfirm")}</span>
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    disabled={pendingId === fingerprint.id}
                    aria-busy={pendingId === fingerprint.id}
                    onClick={() => handleReset(fingerprint.id)}
                  >
                    {pendingId === fingerprint.id ? t("resetPending") : t("resetConfirmYes")}
                  </Button>
                  <Button type="button" variant="outline" size="sm" onClick={() => setConfirmingId(undefined)}>
                    {t("cancel")}
                  </Button>
                </div>
              ) : (
                <Button type="button" variant="outline" size="sm" onClick={() => setConfirmingId(fingerprint.id)}>
                  {t("reset")}
                </Button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
