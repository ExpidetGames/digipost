"use client";

// Browser-only imperative image processing: canvas/`ImageBitmap`/`toBlob`. Deliberately not
// under `core/` (AGENTS.md/architecture note: `core/` is pure, unit-testable logic) - none of
// this can run without a DOM, so it is exercised by the e2e spec
// (`tests/e2e/scanner.spec.ts`) instead of a unit test, the same way `src/modules/documents`
// draws the pure/impure line at `core/pdf-assembly.ts` (pure, `pdf-lib`) vs. its route
// handler (impure I/O). The size-budgeting *policy* this calls between attempts
// (`nextEncodingAttempt`/`hasMoreEncodingAttempts`) does live in `core/encoding-budget.ts`
// and is unit-tested there.
import {
  hasMoreEncodingAttempts,
  INITIAL_ENCODING_ATTEMPT,
  nextEncodingAttempt,
  type EncodingAttempt,
} from "../core/encoding-budget";
import { computeDownscaleSize } from "../core/frame-downscale";
import type { CornerPoints, PageFilter, Rotation, Size } from "../core/types";
import { loadScanic } from "./scanic-loader";

/** Canvas 2D `ctx.filter` accepts CSS `<filter-function-list>` syntax directly, so the same
 * string drives both the review screen's live CSS preview (`ui/review-screen.tsx`) and the
 * final raster bake-in here - what the user sees is exactly what gets uploaded. */
export const FILTER_CSS: Record<PageFilter, string> = {
  document: "grayscale(1) contrast(1.35) brightness(1.08)",
  color: "none",
};

/** The master capture is stored well above the ~2000px upload target (product requirement)
 * so a later re-encode at a lower quality/resolution (`encodePageForUpload`) never has to
 * upscale, but capped so a high-megapixel phone camera does not balloon memory. */
const MASTER_MAX_LONG_EDGE_PX = 2600;
const MASTER_QUALITY = 0.92;

function createCanvas(size: Size): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(size.width));
  canvas.height = Math.max(1, Math.round(size.height));
  return canvas;
}

function get2dContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas context unavailable");
  return ctx;
}

/** Draws the video element's current frame at its full intrinsic resolution - the source
 * for both the live-detection loop (after a further downscale, see `drawDownscaledFrame`)
 * and the actual shutter capture (at full resolution, no downscale). */
export function captureVideoFrame(video: HTMLVideoElement): HTMLCanvasElement {
  const canvas = createCanvas({ width: video.videoWidth, height: video.videoHeight });
  get2dContext(canvas).drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** The live-detection loop's input frame: the video's current frame, downscaled so scanic's
 * edge detection stays cheap and off the critical render path (product requirement:
 * "throttled ... on a downscaled frame"). */
export function drawDownscaledFrame(video: HTMLVideoElement, maxDimension: number): HTMLCanvasElement {
  const target = computeDownscaleSize(video.videoWidth, video.videoHeight, maxDimension);
  const canvas = createCanvas(target);
  get2dContext(canvas).drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function resizeToLongEdge(source: HTMLCanvasElement, maxLongEdgePx: number): HTMLCanvasElement {
  const target = computeDownscaleSize(source.width, source.height, maxLongEdgePx);
  if (target.scale === 1) return source;
  const canvas = createCanvas(target);
  get2dContext(canvas).drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

export interface ExtractResult {
  canvas: HTMLCanvasElement;
  /** The corners scanic used (detected or the ones passed in), for seeding the manual
   * corner editor if the user wants to fine-tune. `null` when extraction failed entirely -
   * the caller falls back to the raw, uncorrected frame and opens the corner editor with a
   * default inset quad (`core/corner-clamp.ts`'s `defaultInsetCorners`). */
  corners: CornerPoints | null;
}

/**
 * Perspective-corrects a full-resolution capture with scanic. With explicit `corners`
 * (confirmed by the user in the corner editor, or a previous auto-detection), calls
 * `extractDocument` directly. Without them, runs `scanDocument(..., { mode: 'extract' })` to
 * both detect and correct in one call. On any failure (no document found, scanic threw),
 * returns the untouched source canvas with `corners: null` so the caller can fall back to
 * manual correction instead of blocking capture entirely.
 */
export async function extractWithScanic(source: HTMLCanvasElement, corners: CornerPoints | null): Promise<ExtractResult> {
  try {
    const scanic = await loadScanic();
    if (corners) {
      const result = await scanic.extractDocument(source, corners, { output: "canvas" });
      if (result.success && result.output instanceof HTMLCanvasElement) {
        return { canvas: result.output, corners };
      }
      return { canvas: source, corners: null };
    }
    const result = await scanic.scanDocument(source, { mode: "extract", output: "canvas" });
    if (result.success && result.output instanceof HTMLCanvasElement) {
      return { canvas: result.output, corners: result.corners };
    }
    return { canvas: source, corners: null };
  } catch {
    return { canvas: source, corners: null };
  }
}

export function canvasToJpegBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error("canvas.toBlob produced no blob"));
      },
      "image/jpeg",
      quality,
    );
  });
}

/** Produces the page's stored master: perspective-corrected (or raw) capture, encoded once
 * at high quality/resolution. Rotation and the document/color filter are NOT baked in here -
 * they are non-destructive metadata on `ScannerPage` (`core/page-list.ts`), applied live via
 * `FILTER_CSS`/CSS `transform` for preview and baked in only once, at upload time
 * (`encodePageForUpload`), so switching the filter or rotating repeatedly never re-compresses
 * the image. */
export async function encodeMaster(source: HTMLCanvasElement): Promise<{ blob: Blob; width: number; height: number }> {
  const resized = resizeToLongEdge(source, MASTER_MAX_LONG_EDGE_PX);
  const blob = await canvasToJpegBlob(resized, MASTER_QUALITY);
  return { blob, width: resized.width, height: resized.height };
}

async function decodeToCanvas(blob: Blob): Promise<HTMLCanvasElement> {
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = createCanvas({ width: bitmap.width, height: bitmap.height });
    get2dContext(canvas).drawImage(bitmap, 0, 0);
    return canvas;
  } finally {
    bitmap.close();
  }
}

/** Rotation + filter baked in, resized to `attempt.maxLongEdgePx`. Canvas dimensions swap
 * for a 90/270 rotation. */
function renderFinal(source: HTMLCanvasElement, rotation: Rotation, filter: PageFilter, maxLongEdgePx: number): HTMLCanvasElement {
  const resizedSource = resizeToLongEdge(source, maxLongEdgePx);
  const rotated = rotation === 90 || rotation === 270;
  const outputSize: Size = rotated
    ? { width: resizedSource.height, height: resizedSource.width }
    : { width: resizedSource.width, height: resizedSource.height };
  const canvas = createCanvas(outputSize);
  const ctx = get2dContext(canvas);
  ctx.filter = FILTER_CSS[filter];
  ctx.save();
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((rotation * Math.PI) / 180);
  ctx.drawImage(resizedSource, -resizedSource.width / 2, -resizedSource.height / 2);
  ctx.restore();
  return canvas;
}

export interface EncodedPage {
  blob: Blob;
  attempt: EncodingAttempt;
}

/**
 * Re-decodes the page's master, bakes in rotation/filter, and encodes to JPEG, stepping
 * quality/resolution down (`core/encoding-budget.ts`) until the result fits `maxBytes` or the
 * stepping ladder is exhausted. Always returns the smallest attempt reached even if it is
 * still over `maxBytes` - the caller (`ui/upload-panel.tsx`) checks the total across every
 * page before uploading and refuses to submit rather than ever sending an over-budget
 * request.
 */
export async function encodePageForUpload(
  masterBlob: Blob,
  rotation: Rotation,
  filter: PageFilter,
  maxBytes: number,
): Promise<EncodedPage> {
  const source = await decodeToCanvas(masterBlob);
  let attempt = INITIAL_ENCODING_ATTEMPT;
  for (;;) {
    const rendered = renderFinal(source, rotation, filter, attempt.maxLongEdgePx);
    const blob = await canvasToJpegBlob(rendered, attempt.quality);
    if (blob.size <= maxBytes || !hasMoreEncodingAttempts(attempt)) {
      return { blob, attempt };
    }
    attempt = nextEncodingAttempt(attempt);
  }
}
