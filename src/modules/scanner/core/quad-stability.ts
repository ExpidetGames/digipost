// Pure "has the detected quad stopped moving" logic, driving the optional auto-capture
// toggle: the live-detection loop (`ui/hooks/use-live-detection.ts`) appends one sample per
// tick to a rolling history and asks `isQuadStable` whether the samples covering the last
// `requiredDurationMs` all detected a quad within `maxDriftPx` of the latest one.
import type { CornerPoints, Point } from "./types";

export interface DetectionSample {
  corners: CornerPoints | null;
  atMs: number;
}

export interface StabilityOptions {
  /** How long the quad must have stayed put before auto-capture fires, e.g. 1000. */
  requiredDurationMs: number;
  /** Maximum corner drift (px, in the same pixel space as the samples) still considered
   * "the same position". */
  maxDriftPx: number;
}

function pointDistance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Largest single-corner displacement between two quads (the four corners are compared
 * pairwise by role, not by nearest-neighbour matching - both `a` and `b` come from the same
 * detector on the same frame geometry, so corners are already correctly paired). */
export function cornerDrift(a: CornerPoints, b: CornerPoints): number {
  return Math.max(
    pointDistance(a.topLeft, b.topLeft),
    pointDistance(a.topRight, b.topRight),
    pointDistance(a.bottomRight, b.bottomRight),
    pointDistance(a.bottomLeft, b.bottomLeft),
  );
}

/**
 * True once: (1) the latest sample detected a quad, (2) history reaches back at least
 * `requiredDurationMs` before it (not just a couple of early samples right after starting
 * the camera), and (3) every sample in that window detected a quad within `maxDriftPx` of
 * the latest one. A single missed detection (`corners: null`) or a large jump anywhere in
 * the window resets stability - the caller keeps appending samples and calling this again
 * on the next tick rather than this function tracking any state itself.
 */
export function isQuadStable(history: DetectionSample[], options: StabilityOptions): boolean {
  if (history.length === 0) return false;
  const latest = history[history.length - 1];
  if (!latest.corners) return false;

  const windowStartMs = latest.atMs - options.requiredDurationMs;
  if (history[0].atMs > windowStartMs) return false;

  const windowSamples = history.filter((sample) => sample.atMs >= windowStartMs);
  return windowSamples.every(
    (sample) => sample.corners !== null && cornerDrift(sample.corners, latest.corners!) <= options.maxDriftPx,
  );
}

/** Bounds a detection history buffer to the samples that could still matter, so it does not
 * grow forever over a long-running camera session. Keeps everything from `requiredDurationMs`
 * before `nowMs` onward, plus at least the single latest sample. */
export function pruneHistory(history: DetectionSample[], requiredDurationMs: number, nowMs: number): DetectionSample[] {
  const cutoff = nowMs - requiredDurationMs;
  const pruned = history.filter((sample) => sample.atMs >= cutoff);
  if (pruned.length === 0 && history.length > 0) return [history[history.length - 1]];
  return pruned;
}
