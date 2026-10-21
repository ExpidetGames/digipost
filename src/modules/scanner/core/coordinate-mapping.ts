// Pure geometry for mapping points/quads between two pixel spaces of the same scene at
// different resolutions - e.g. a detection made on a downscaled frame (`frame-downscale.ts`)
// mapped back onto the full-resolution video frame for drawing an overlay, or a video's
// intrinsic resolution mapped onto its displayed (CSS) size.
import type { CornerPoints, Point, Size } from "./types";

export function scalePoint(point: Point, from: Size, to: Size): Point {
  const scaleX = from.width === 0 ? 1 : to.width / from.width;
  const scaleY = from.height === 0 ? 1 : to.height / from.height;
  return { x: point.x * scaleX, y: point.y * scaleY };
}

export function scaleCorners(corners: CornerPoints, from: Size, to: Size): CornerPoints {
  return {
    topLeft: scalePoint(corners.topLeft, from, to),
    topRight: scalePoint(corners.topRight, from, to),
    bottomRight: scalePoint(corners.bottomRight, from, to),
    bottomLeft: scalePoint(corners.bottomLeft, from, to),
  };
}
