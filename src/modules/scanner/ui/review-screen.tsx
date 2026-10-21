"use client";

// Post-capture review (product requirement 3): attempts perspective correction automatically
// on mount, offers a manual corner editor (auto-opened when detection failed), a
// "Dokument"/"Farbe" filter toggle and a 90°-rotate button (both non-destructive CSS preview,
// baked into the final JPEG only at upload time - see `canvas-pipeline.ts`'s `FILTER_CSS`
// doc comment), and finally turns the reviewed frame into a `ScannerPage` on confirm.
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";

import { Button } from "@/shared/ui-primitives";

import { defaultInsetCorners } from "../core/corner-clamp";
import type { CornerPoints, PageFilter, Rotation, ScannerPage } from "../core/types";
import { encodeMaster, extractWithScanic, FILTER_CSS } from "./canvas-pipeline";
import { CornerEditor } from "./corner-editor";

export interface ReviewScreenProps {
  /** The raw, full-resolution captured frame - never mutated, always the source the corner
   * editor and every re-extraction attempt work from. */
  rawFrame: HTMLCanvasElement;
  /** Corners already known for this frame (from live detection right before the shutter
   * fired), if any. */
  initialCorners: CornerPoints | null;
  onConfirm: (page: ScannerPage) => void;
  onRetake: () => void;
}

export function ReviewScreen({ rawFrame, initialCorners, onConfirm, onRetake }: ReviewScreenProps) {
  const t = useTranslations("Scanner.review");
  const previewRef = useRef<HTMLCanvasElement>(null);
  const [correctedCanvas, setCorrectedCanvas] = useState<HTMLCanvasElement>(rawFrame);
  const [corners, setCorners] = useState<CornerPoints | null>(initialCorners);
  const [editingCorners, setEditingCorners] = useState(false);
  const [filter, setFilter] = useState<PageFilter>("document");
  const [rotation, setRotation] = useState<Rotation>(0);
  const [processing, setProcessing] = useState(true);
  const [confirming, setConfirming] = useState(false);

  // Runs exactly once per mounted ReviewScreen instance: the caller re-mounts this component
  // (a fresh `key`) for every new capture, so "run once" here really does mean "once per
  // captured frame", not "only on the very first capture of the session".
  useEffect(() => {
    let cancelled = false;
    extractWithScanic(rawFrame, initialCorners).then((result) => {
      if (cancelled) return;
      setCorrectedCanvas(result.canvas);
      setCorners(result.corners);
      setProcessing(false);
      if (!result.corners) setEditingCorners(true);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const canvas = previewRef.current;
    if (!canvas) return;
    canvas.width = correctedCanvas.width;
    canvas.height = correctedCanvas.height;
    canvas.getContext("2d")?.drawImage(correctedCanvas, 0, 0);
  }, [correctedCanvas]);

  async function handleCornerConfirm(newCorners: CornerPoints) {
    setEditingCorners(false);
    setProcessing(true);
    const result = await extractWithScanic(rawFrame, newCorners);
    setCorrectedCanvas(result.canvas);
    setCorners(result.corners ?? newCorners);
    setProcessing(false);
  }

  async function handleConfirmPage() {
    setConfirming(true);
    const { blob, width, height } = await encodeMaster(correctedCanvas);
    const page: ScannerPage = {
      id: crypto.randomUUID(),
      masterBlob: blob,
      width,
      height,
      rotation,
      filter,
      previewUrl: URL.createObjectURL(blob),
    };
    onConfirm(page);
  }

  if (editingCorners) {
    return (
      <CornerEditor
        image={rawFrame}
        initialCorners={corners ?? defaultInsetCorners({ width: rawFrame.width, height: rawFrame.height })}
        onConfirm={handleCornerConfirm}
        onCancel={() => setEditingCorners(false)}
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-center overflow-hidden rounded-lg border border-border bg-muted p-2">
        <canvas
          ref={previewRef}
          className="max-h-[60vh] max-w-full"
          style={{ transform: `rotate(${rotation}deg)`, filter: FILTER_CSS[filter] }}
        />
      </div>

      {processing ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t("processing")}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={() => setFilter((current) => (current === "document" ? "color" : "document"))}
        >
          {filter === "document" ? t("filterDocument") : t("filterColor")}
        </Button>
        <Button type="button" variant="outline" onClick={() => setRotation((current) => (((current + 90) % 360) as Rotation))}>
          {t("rotate")}
        </Button>
        <Button type="button" variant="outline" onClick={() => setEditingCorners(true)}>
          {t("adjustCorners")}
        </Button>
      </div>

      <div className="flex items-center justify-between gap-2">
        <Button type="button" variant="ghost" onClick={onRetake}>
          {t("retake")}
        </Button>
        <Button type="button" disabled={processing || confirming} aria-busy={confirming} onClick={handleConfirmPage}>
          {t("confirm")}
        </Button>
      </div>
    </div>
  );
}
