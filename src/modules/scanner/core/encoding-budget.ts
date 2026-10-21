// Pure JPEG size-budgeting: how much every page is allowed to weigh so the whole multipart
// upload stays under `MAX_UPLOAD_TOTAL_BYTES`, and how to step a page's encoding settings
// down when it comes out heavier than its budget. The actual encode-and-measure loop is
// necessarily impure (canvas/`toBlob`), so it lives in `ui/canvas-pipeline.ts` and calls
// these functions between attempts; keeping the stepping policy itself here makes it
// table-testable without a DOM.

export interface EncodingAttempt {
  /** 0..1, canvas `toBlob` JPEG quality. */
  quality: number;
  /** Longest edge, in pixels, the page is resized to before encoding. */
  maxLongEdgePx: number;
}

/** Starting point for every page: quality ~0.8, long edge capped at ~2000px (product
 * requirement). Good enough for OCR while already far smaller than a raw phone photo. */
export const INITIAL_ENCODING_ATTEMPT: EncodingAttempt = { quality: 0.8, maxLongEdgePx: 2000 };

const MIN_QUALITY = 0.35;
const MIN_LONG_EDGE_PX = 800;
const QUALITY_STEP = 0.1;
const LONG_EDGE_SHRINK_FACTOR = 0.85;

/**
 * The next, strictly smaller attempt to try after `previous` produced a still-too-large
 * file. Lowers quality first, in fixed steps down to `MIN_QUALITY`; only once quality is
 * already at its floor does it start shrinking the long edge (in ~15% steps down to
 * `MIN_LONG_EDGE_PX`). Exactly one of the two changes per call, and always in the direction
 * that reduces file size, so repeatedly calling this on a page that stays over budget
 * converges monotonically instead of oscillating. Calling it once quality and long edge are
 * both already at their floor returns `previous` unchanged - check `hasMoreEncodingAttempts`
 * first to tell the two cases apart.
 */
export function nextEncodingAttempt(previous: EncodingAttempt): EncodingAttempt {
  if (previous.quality > MIN_QUALITY) {
    const quality = Math.max(MIN_QUALITY, Math.round((previous.quality - QUALITY_STEP) * 100) / 100);
    return { quality, maxLongEdgePx: previous.maxLongEdgePx };
  }
  if (previous.maxLongEdgePx > MIN_LONG_EDGE_PX) {
    const maxLongEdgePx = Math.max(MIN_LONG_EDGE_PX, Math.round(previous.maxLongEdgePx * LONG_EDGE_SHRINK_FACTOR));
    return { quality: previous.quality, maxLongEdgePx };
  }
  return previous;
}

/** False once quality and long edge are both already at their floor - the caller should
 * stop stepping down and accept the smallest attempt reached, rather than looping forever. */
export function hasMoreEncodingAttempts(attempt: EncodingAttempt): boolean {
  return attempt.quality > MIN_QUALITY || attempt.maxLongEdgePx > MIN_LONG_EDGE_PX;
}

/**
 * Even split of the total upload budget across every page, minus a fixed allowance for
 * multipart overhead (boundaries, field names/headers, the optional `fileName` field) - a
 * generous constant rather than a computed value, since the exact overhead depends on file
 * names the caller does not know yet at encoding time. Returns `totalMaxBytes` unchanged for
 * a zero/negative page count (nothing to divide by).
 */
export function perPageByteBudget(totalMaxBytes: number, pageCount: number): number {
  if (pageCount <= 0) return totalMaxBytes;
  const multipartOverheadBytes = 4096;
  const usable = Math.max(0, totalMaxBytes - multipartOverheadBytes);
  return Math.floor(usable / pageCount);
}
