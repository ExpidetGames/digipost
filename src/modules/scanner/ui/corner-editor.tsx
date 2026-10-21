"use client";

// Thin wrapper around scanic's own `createCornerEditor` (imperative DOM API, drag-to-adjust
// corner handles with touch/keyboard support built in - see node_modules/scanic/README.md's
// "Manual corner adjustment UI"). Mounted whenever automatic detection failed, or the user
// explicitly asks to fine-tune the detected quad (product requirement 3).
import { useEffect, useRef } from "react";

import type { CornerEditor as ScanicCornerEditor } from "scanic";

import type { CornerPoints } from "../core/types";
import { loadScanic } from "./scanic-loader";

export interface CornerEditorProps {
  image: HTMLCanvasElement;
  initialCorners: CornerPoints;
  onConfirm: (corners: CornerPoints) => void;
  onCancel: () => void;
}

export function CornerEditor({ image, initialCorners, onConfirm, onCancel }: CornerEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const onConfirmRef = useRef(onConfirm);
  const onCancelRef = useRef(onCancel);

  // Keeps the refs current on every render (declared before the mount effect below, so it
  // always runs first) without making them effect dependencies - refs are read only inside
  // scanic's own callbacks, never during render itself (react-hooks/refs).
  useEffect(() => {
    onConfirmRef.current = onConfirm;
    onCancelRef.current = onCancel;
  });

  useEffect(() => {
    let editor: ScanicCornerEditor | null = null;
    let cancelled = false;

    void loadScanic().then((scanic) => {
      if (cancelled || !containerRef.current) return;
      editor = scanic.createCornerEditor({
        container: containerRef.current,
        image,
        corners: initialCorners,
        onConfirm: (corners) => onConfirmRef.current(corners),
        onCancel: () => onCancelRef.current(),
      });
    });

    return () => {
      cancelled = true;
      editor?.destroy();
    };
    // `initialCorners`/`image` intentionally define the editor's lifetime: a new capture or a
    // freshly re-extracted image should tear down and re-create the editor from scratch
    // rather than trying to update an in-place scanic instance (it has no such API).
  }, [image, initialCorners]);

  return <div ref={containerRef} className="relative w-full overflow-hidden rounded-lg" />;
}
