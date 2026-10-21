// Pure math for the live-detection throttling loop: detection runs on a downscaled copy of
// the video frame (cheaper for scanic's edge detection, keeps it off the critical render
// path), never on the full-resolution frame - that is reserved for the actual capture.
import type { Size } from "./types";

export interface DownscaleResult extends Size {
  /** `to.width / from.width` (== `to.height / from.height`): multiply a point detected on
   * the downscaled frame by `1 / scale` to map it back onto the source resolution. */
  scale: number;
}

/**
 * Scales `width`x`height` down so its longer edge is at most `maxDimension`, preserving
 * aspect ratio. Never scales up - a source already at or below `maxDimension` is returned
 * unchanged with `scale: 1`. Dimensions of 0 (no video frame yet) pass through unchanged.
 */
export function computeDownscaleSize(width: number, height: number, maxDimension: number): DownscaleResult {
  const longEdge = Math.max(width, height);
  if (longEdge <= 0 || longEdge <= maxDimension) {
    return { width, height, scale: 1 };
  }
  const scale = maxDimension / longEdge;
  return { width: Math.round(width * scale), height: Math.round(height * scale), scale };
}
