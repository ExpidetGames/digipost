"use client";

// Top-level orchestrator mounted by `src/modules/documents/ui/upload-form.tsx`'s "Kamera" tab
// (via `client.ts`'s `CameraScanner`). Owns the page list (`core/page-list.ts`'s reducer) and
// switches between the live camera and the post-capture review screen; `UploadPanel` and
// `PageStrip` render once at least one page exists.
import { useCallback, useReducer, useRef, useState } from "react";

import { pageListReducer } from "../core/page-list";
import type { CornerPoints, ScannerPage } from "../core/types";
import { CameraView } from "./camera-view";
import { PageStrip } from "./page-strip";
import { ReviewScreen } from "./review-screen";
import { UploadPanel } from "./upload-panel";

type Mode =
  | { kind: "camera" }
  | { kind: "review"; frame: HTMLCanvasElement; corners: CornerPoints | null; key: string };

export interface CameraScannerProps {
  /** Switches the parent `UploadForm` back to its "Datei hochladen" tab - offered by the
   * permission-denied/no-camera fallback (product requirement 1). */
  onSwitchToFileTab: () => void;
}

async function fileToCanvas(file: File): Promise<HTMLCanvasElement> {
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
    return canvas;
  } finally {
    bitmap.close();
  }
}

export function CameraScanner({ onSwitchToFileTab }: CameraScannerProps) {
  const [pages, dispatch] = useReducer(pageListReducer, []);
  const [mode, setMode] = useState<Mode>({ kind: "camera" });
  // Which page id (if any) the *next* successful capture should replace, for "Erneut
  // aufnehmen" on an existing page in the strip (kept in a ref, not state: it must survive
  // the camera -> review mode transition without becoming a `CameraView`/`useLiveDetection`
  // effect dependency, which would otherwise restart the detection loop on every retake).
  const replacingIdRef = useRef<string | undefined>(undefined);

  // Stable identity on purpose: passed through `CameraView` into `useLiveDetection`'s
  // `onAutoCapture`, which is an effect dependency - an unstable callback here would restart
  // the detection loop's interval on every unrelated re-render (e.g. a page being reordered).
  const handleCapture = useCallback((frame: HTMLCanvasElement) => {
    setMode({ kind: "review", frame, corners: null, key: crypto.randomUUID() });
  }, []);

  const handleFallbackFiles = useCallback((files: FileList) => {
    const file = files[0];
    if (!file) return;
    void fileToCanvas(file).then((frame) => {
      setMode({ kind: "review", frame, corners: null, key: crypto.randomUUID() });
    });
  }, []);

  function handleReviewConfirm(page: ScannerPage) {
    const replacingId = replacingIdRef.current;
    replacingIdRef.current = undefined;
    if (replacingId) {
      const previous = pages.find((existing) => existing.id === replacingId);
      if (previous) URL.revokeObjectURL(previous.previewUrl);
      dispatch({ type: "replace", id: replacingId, page: { ...page, id: replacingId } });
    } else {
      dispatch({ type: "add", page });
    }
    setMode({ kind: "camera" });
  }

  function handleRetakePage(id: string) {
    replacingIdRef.current = id;
    setMode({ kind: "camera" });
  }

  function handleRemovePage(id: string) {
    const page = pages.find((existing) => existing.id === id);
    if (page) URL.revokeObjectURL(page.previewUrl);
    dispatch({ type: "remove", id });
  }

  return (
    <div className="flex flex-col gap-6">
      {mode.kind === "camera" ? (
        <CameraView
          active
          onCapture={handleCapture}
          onSwitchToFileTab={onSwitchToFileTab}
          onFilesSelected={handleFallbackFiles}
        />
      ) : (
        <ReviewScreen
          key={mode.key}
          rawFrame={mode.frame}
          initialCorners={mode.corners}
          onConfirm={handleReviewConfirm}
          onRetake={() => {
            replacingIdRef.current = undefined;
            setMode({ kind: "camera" });
          }}
        />
      )}

      {pages.length > 0 ? (
        <PageStrip
          pages={pages}
          onMoveLeft={(id) => dispatch({ type: "moveLeft", id })}
          onMoveRight={(id) => dispatch({ type: "moveRight", id })}
          onRemove={handleRemovePage}
          onRetake={handleRetakePage}
          onAddPage={() => setMode({ kind: "camera" })}
        />
      ) : null}

      {pages.length > 0 ? <UploadPanel pages={pages} /> : null}
    </div>
  );
}
