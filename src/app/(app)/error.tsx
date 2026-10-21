"use client";

import { useEffect } from "react";
import { useTranslations } from "next-intl";

import { Button } from "@/shared/ui-primitives";

// Error boundary for the (app) segment (WEBAPP_TEMPLATE_SPEC.md §8: "Keine leeren
// Fehlerflächen: lokalisierter Fehlerzustand + Retry"). Next requires this file to be a
// client component. `reset()` re-renders the segment, retrying whatever threw.
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const t = useTranslations("Common");

  useEffect(() => {
    console.error("[app] segment error boundary", error);
  }, [error]);

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <p className="text-lg font-semibold text-foreground">{t("errorHeading")}</p>
      <p className="text-sm text-muted-foreground">{t("errorDescription")}</p>
      <Button type="button" onClick={() => reset()}>
        {t("retry")}
      </Button>
    </div>
  );
}
