"use client";

// The live edge-detection loop: every `DETECTION_INTERVAL_MS`, draws a downscaled copy of
// the current video frame (`drawDownscaledFrame`, off the critical render path) and runs
// scanic's classical detector on it (`mode: 'detect'`, no perspective correction yet - that
// only happens once, on the full-resolution frame, at actual capture time in
// `canvas-pipeline.ts`'s `extractWithScanic`). A `busyRef` guard skips a tick if the previous
// one has not finished yet, so a slow device throttles itself further instead of piling up
// overlapping scanic calls.
import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { Scanner as ScanicScanner } from "scanic";

import { scaleCorners } from "../../core/coordinate-mapping";
import { isQuadStable, pruneHistory, type DetectionSample } from "../../core/quad-stability";
import type { CornerPoints } from "../../core/types";
import { drawDownscaledFrame } from "../canvas-pipeline";
import { loadScanic } from "../scanic-loader";

const DETECTION_INTERVAL_MS = 400;
const DETECTION_MAX_DIMENSION_PX = 500;
const STABILITY_REQUIRED_DURATION_MS = 1000;
const STABILITY_MAX_DRIFT_PX = 18;

export interface LiveDetectionOptions {
  videoRef: RefObject<HTMLVideoElement | null>;
  /** Only runs the loop while true (the camera view is visible and not blocked by a review
   * screen). */
  enabled: boolean;
  autoCaptureEnabled: boolean;
  /** Called at most once per stability episode - it resets once the quad moves again, so
   * capturing the next page re-arms auto-capture. Wrap in `useCallback` in the caller: it is
   * an effect dependency. */
  onAutoCapture: () => void;
}

export interface LiveDetectionState {
  corners: CornerPoints | null;
  stable: boolean;
}

export function useLiveDetection({ videoRef, enabled, autoCaptureEnabled, onAutoCapture }: LiveDetectionOptions): LiveDetectionState {
  const [corners, setCorners] = useState<CornerPoints | null>(null);
  const [stable, setStable] = useState(false);
  const historyRef = useRef<DetectionSample[]>([]);
  const busyRef = useRef(false);
  const armedRef = useRef(true);

  useEffect(() => {
    // Nothing to start; if a previous run was active, its cleanup below already reset
    // `corners`/`stable` back to their idle values (react-hooks/set-state-in-effect: resetting
    // them again here, synchronously and unconditionally, would be a derived-state
    // anti-pattern rather than synchronizing with an external system).
    if (!enabled) return undefined;

    historyRef.current = [];
    armedRef.current = true;
    let cancelled = false;
    let scanner: ScanicScanner | null = null;

    const intervalId = window.setInterval(() => {
      if (busyRef.current || cancelled) return;
      const video = videoRef.current;
      if (!video || video.readyState < 2 || video.videoWidth === 0) return;

      busyRef.current = true;
      void (async () => {
        try {
          if (!scanner) {
            const scanic = await loadScanic();
            scanner = new scanic.Scanner();
            await scanner.initialize();
          }
          if (cancelled) return;

          const frame = drawDownscaledFrame(video, DETECTION_MAX_DIMENSION_PX);
          const result = await scanner.scan(frame, { mode: "detect" });
          if (cancelled) return;

          const detected =
            result.success && result.corners
              ? scaleCorners(result.corners, frame, { width: video.videoWidth, height: video.videoHeight })
              : null;
          setCorners(detected);

          const now = performance.now();
          const history = pruneHistory(
            [...historyRef.current, { corners: detected, atMs: now }],
            STABILITY_REQUIRED_DURATION_MS,
            now,
          );
          historyRef.current = history;

          const isStable = isQuadStable(history, {
            requiredDurationMs: STABILITY_REQUIRED_DURATION_MS,
            maxDriftPx: STABILITY_MAX_DRIFT_PX,
          });
          setStable(isStable);

          if (isStable) {
            if (autoCaptureEnabled && armedRef.current) {
              armedRef.current = false;
              onAutoCapture();
            }
          } else {
            armedRef.current = true;
          }
        } catch {
          // A single failed detection tick is not an error worth surfacing - the next tick
          // tries again. Persistent failure just means no overlay/auto-capture, the manual
          // shutter still works.
        } finally {
          busyRef.current = false;
        }
      })();
    }, DETECTION_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
      setCorners(null);
      setStable(false);
    };
  }, [enabled, autoCaptureEnabled, onAutoCapture, videoRef]);

  return { corners, stable };
}
