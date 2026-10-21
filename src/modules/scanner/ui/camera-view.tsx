"use client";

// Live camera preview: starts the rear camera, overlays the detected quad
// (`useLiveDetection`), offers a manual shutter and an "automatisch aufnehmen" toggle, and
// falls back to `PermissionFallback` whenever the camera could not start at all (product
// requirements 1-2).
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";

import { Button } from "@/shared/ui-primitives";

import { scaleCorners } from "../core/coordinate-mapping";
import { captureVideoFrame } from "./canvas-pipeline";
import { useCameraStream } from "./hooks/use-camera-stream";
import { useLiveDetection } from "./hooks/use-live-detection";
import { PermissionFallback } from "./permission-fallback";

export interface CameraViewProps {
  /** Whether this view should be running the camera at all - false while a review screen is
   * blocking it or the "Kamera" tab is not selected. */
  active: boolean;
  onCapture: (frame: HTMLCanvasElement) => void;
  onSwitchToFileTab: () => void;
  onFilesSelected: (files: FileList) => void;
}

const STABLE_OVERLAY_COLOR = "#22c55e";
const DETECTING_OVERLAY_COLOR = "#facc15";

export function CameraView({ active, onCapture, onSwitchToFileTab, onFilesSelected }: CameraViewProps) {
  const t = useTranslations("Scanner.camera");
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const [autoCaptureEnabled, setAutoCaptureEnabled] = useState(false);
  const { state, retry } = useCameraStream(active);

  useEffect(() => {
    if (state.status === "ready" && videoRef.current) {
      videoRef.current.srcObject = state.stream;
    }
  }, [state]);

  const handleShutter = useCallback(() => {
    const video = videoRef.current;
    if (!video || video.readyState < 2) return;
    onCapture(captureVideoFrame(video));
  }, [onCapture]);

  const { corners, stable } = useLiveDetection({
    videoRef,
    enabled: active && state.status === "ready",
    autoCaptureEnabled,
    onAutoCapture: handleShutter,
  });

  // Redraws the quad overlay whenever the detection updates or the video's displayed (CSS)
  // size changes - the overlay canvas is sized to match the video's rendered box, but corner
  // coordinates come back in the video's intrinsic resolution (`useLiveDetection` already
  // scales up from the downscaled detection frame to that intrinsic size).
  useEffect(() => {
    const overlay = overlayRef.current;
    const video = videoRef.current;
    if (!overlay || !video) return;

    overlay.width = video.clientWidth;
    overlay.height = video.clientHeight;
    const ctx = overlay.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, overlay.width, overlay.height);

    if (!corners || video.videoWidth === 0 || video.videoHeight === 0) return;
    const displayed = scaleCorners(
      corners,
      { width: video.videoWidth, height: video.videoHeight },
      { width: overlay.width, height: overlay.height },
    );

    ctx.strokeStyle = stable ? STABLE_OVERLAY_COLOR : DETECTING_OVERLAY_COLOR;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(displayed.topLeft.x, displayed.topLeft.y);
    ctx.lineTo(displayed.topRight.x, displayed.topRight.y);
    ctx.lineTo(displayed.bottomRight.x, displayed.bottomRight.y);
    ctx.lineTo(displayed.bottomLeft.x, displayed.bottomLeft.y);
    ctx.closePath();
    ctx.stroke();
  }, [corners, stable]);

  if (state.status === "error") {
    return (
      <PermissionFallback
        reason={state.reason}
        onRetry={retry}
        onSwitchToFileTab={onSwitchToFileTab}
        onCaptureFallbackFiles={onFilesSelected}
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="relative overflow-hidden rounded-lg bg-black">
        <video ref={videoRef} autoPlay playsInline muted className="block w-full" />
        <canvas ref={overlayRef} className="pointer-events-none absolute inset-0" />
        {state.status === "idle" ? (
          <div className="absolute inset-0 flex items-center justify-center bg-black/40 text-sm text-white">
            {t("starting")}
          </div>
        ) : null}
      </div>

      <div className="flex items-center justify-between gap-2">
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            checked={autoCaptureEnabled}
            onChange={(event) => setAutoCaptureEnabled(event.target.checked)}
          />
          {t("autoCapture")}
        </label>
        <Button type="button" disabled={state.status !== "ready"} onClick={handleShutter}>
          {t("shutter")}
        </Button>
      </div>
    </div>
  );
}
