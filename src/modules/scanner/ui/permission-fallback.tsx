"use client";

// Shown instead of the live camera preview whenever `useCameraStream` could not start the
// camera (product requirement 1: "clear permission-denied / no-camera / insecure-context
// messages with a fallback to the 'Datei hochladen' tab and a native file input fallback").
// The native `capture="environment"` file input works even when `getUserMedia` itself is
// unsupported or blocked (it opens the device's own camera app instead), so it is offered
// unconditionally alongside the "switch tabs" fallback, not only for specific reasons.
import { useRef } from "react";
import { useTranslations } from "next-intl";

import { Button } from "@/shared/ui-primitives";

import type { CameraErrorReason } from "./hooks/use-camera-stream";

const RETRYABLE_REASONS: ReadonlySet<CameraErrorReason> = new Set(["denied", "not-found", "unknown"]);

const REASON_MESSAGE_KEY: Record<CameraErrorReason, string> = {
  "insecure-context": "insecureContext",
  unsupported: "unsupported",
  denied: "denied",
  "not-found": "notFound",
  unknown: "unknown",
};

export interface PermissionFallbackProps {
  reason: CameraErrorReason;
  onRetry: () => void;
  onSwitchToFileTab: () => void;
  onCaptureFallbackFiles: (files: FileList) => void;
}

export function PermissionFallback({ reason, onRetry, onSwitchToFileTab, onCaptureFallbackFiles }: PermissionFallbackProps) {
  const t = useTranslations("Scanner.permission");
  const captureInputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="flex flex-col items-center gap-4 rounded-lg border border-dashed border-border p-8 text-center">
      <p role="alert" className="text-sm text-foreground">
        {t(REASON_MESSAGE_KEY[reason])}
      </p>

      <div className="flex flex-wrap items-center justify-center gap-2">
        {RETRYABLE_REASONS.has(reason) ? (
          <Button type="button" variant="outline" onClick={onRetry}>
            {t("retry")}
          </Button>
        ) : null}
        <Button type="button" variant="outline" onClick={onSwitchToFileTab}>
          {t("switchToFile")}
        </Button>
        <Button type="button" onClick={() => captureInputRef.current?.click()}>
          {t("captureFallback")}
        </Button>
        <input
          ref={captureInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="sr-only"
          onChange={(event) => {
            if (event.target.files && event.target.files.length > 0) {
              onCaptureFallbackFiles(event.target.files);
              event.target.value = "";
            }
          }}
        />
      </div>
    </div>
  );
}
