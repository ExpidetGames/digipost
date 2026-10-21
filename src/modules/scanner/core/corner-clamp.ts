// Pure bounds-clamping for corner points, used both to sanitize scanic's detection output
// (which can report a point slightly outside the source image on noisy frames) and by the
// manual corner editor fallback to keep dragged handles inside the image.
import type { CornerPoints, Point, Size } from "./types";

export function clampPoint(point: Point, bounds: Size): Point {
  return {
    x: Math.min(Math.max(point.x, 0), bounds.width),
    y: Math.min(Math.max(point.y, 0), bounds.height),
  };
}

export function clampCorners(corners: CornerPoints, bounds: Size): CornerPoints {
  return {
    topLeft: clampPoint(corners.topLeft, bounds),
    topRight: clampPoint(corners.topRight, bounds),
    bottomRight: clampPoint(corners.bottomRight, bounds),
    bottomLeft: clampPoint(corners.bottomLeft, bounds),
  };
}

/** An inset quad (10% margin on each side) used as the manual corner editor's default when
 * no detection is available at all. */
export function defaultInsetCorners(bounds: Size, insetRatio = 0.1): CornerPoints {
  const insetX = bounds.width * insetRatio;
  const insetY = bounds.height * insetRatio;
  return {
    topLeft: { x: insetX, y: insetY },
    topRight: { x: bounds.width - insetX, y: insetY },
    bottomRight: { x: bounds.width - insetX, y: bounds.height - insetY },
    bottomLeft: { x: insetX, y: bounds.height - insetY },
  };
}
