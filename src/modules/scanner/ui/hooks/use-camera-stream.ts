"use client";

// Owns the `getUserMedia` lifecycle: requests the rear camera while `active` is true, and
// always stops every track again on cleanup (tab switch away from "Kamera", or unmounting
// `/dashboard/scan` entirely) - camera tracks left running after the user leaves the page is
// the one thing a camera feature must never do (product requirement 7).
import { useCallback, useEffect, useRef, useState } from "react";

export type CameraErrorReason = "insecure-context" | "unsupported" | "denied" | "not-found" | "unknown";

/**
 * No separate "requesting" state: `idle` doubles as "not resolved yet" while `active` -
 * `useCameraStream`'s effect only ever calls `setState` from inside the `getUserMedia`
 * promise's `.then`/`.catch` callbacks or its cleanup, never synchronously in the effect
 * body itself (react-hooks/set-state-in-effect), so there is no separate synchronous
 * "requesting" transition to model. `CameraView` shows its "wird gestartet" indicator
 * whenever `status === "idle"`.
 */
export type CameraState =
  | { status: "idle" }
  | { status: "ready"; stream: MediaStream }
  | { status: "error"; reason: CameraErrorReason };

/** Thrown for capability checks (no secure context, no `getUserMedia` at all) so they flow
 * through the same async error path as a real `getUserMedia` rejection, rather than being a
 * separate synchronous branch in the effect body. */
class CameraCapabilityError extends Error {
  constructor(public readonly reason: CameraErrorReason) {
    super(reason);
  }
}

function mapGetUserMediaError(error: unknown): CameraErrorReason {
  if (error instanceof CameraCapabilityError) return error.reason;
  if (error instanceof DOMException) {
    switch (error.name) {
      case "NotAllowedError":
      case "SecurityError":
        return "denied";
      case "NotFoundError":
      case "OverconstrainedError":
      case "DevicesNotFoundError":
        return "not-found";
      default:
        return "unknown";
    }
  }
  return "unknown";
}

async function requestCameraStream(): Promise<MediaStream> {
  if (typeof window === "undefined" || !window.isSecureContext) {
    throw new CameraCapabilityError("insecure-context");
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new CameraCapabilityError("unsupported");
  }
  return navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: { ideal: "environment" },
      width: { ideal: 1920 },
      height: { ideal: 1080 },
    },
    audio: false,
  });
}

/**
 * `active`: whether the camera should be running right now (the "Kamera" tab is selected
 * and no page review is blocking it). Toggling it off stops every track; toggling it back on
 * requests a fresh stream. `retry()` re-requests without waiting for `active` to flip (the
 * permission-denied fallback's "Erneut versuchen" button).
 */
export function useCameraStream(active: boolean): { state: CameraState; retry: () => void } {
  const [state, setState] = useState<CameraState>({ status: "idle" });
  const [retryToken, setRetryToken] = useState(0);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    // Nothing to start; the previous run's cleanup below (if any) already reset `state` back
    // to idle when `active` flipped to false.
    if (!active) return undefined;

    let cancelled = false;

    requestCameraStream()
      .then((stream) => {
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        setState({ status: "ready", stream });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({ status: "error", reason: mapGetUserMediaError(error) });
      });

    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      // Runs whenever this effect's active run ends: `active` flipped to false, a retry
      // re-requested (`retryToken` changed), or the component unmounted.
      setState({ status: "idle" });
    };
  }, [active, retryToken]);

  const retry = useCallback(() => setRetryToken((token) => token + 1), []);

  return { state, retry };
}
