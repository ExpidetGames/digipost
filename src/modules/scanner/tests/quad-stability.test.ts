import { describe, expect, it } from "vitest";

import { cornerDrift, isQuadStable, pruneHistory, type DetectionSample } from "../core/quad-stability";
import type { CornerPoints } from "../core/types";

const QUAD_A: CornerPoints = {
  topLeft: { x: 10, y: 10 },
  topRight: { x: 90, y: 10 },
  bottomRight: { x: 90, y: 90 },
  bottomLeft: { x: 10, y: 90 },
};

/** Same as QUAD_A, shifted by 3px on one corner only. */
const QUAD_A_JITTERED: CornerPoints = { ...QUAD_A, topLeft: { x: 13, y: 10 } };

/** Clearly a different position. */
const QUAD_B: CornerPoints = {
  topLeft: { x: 200, y: 200 },
  topRight: { x: 300, y: 200 },
  bottomRight: { x: 300, y: 300 },
  bottomLeft: { x: 200, y: 300 },
};

describe("cornerDrift", () => {
  it("is zero for identical quads", () => {
    expect(cornerDrift(QUAD_A, QUAD_A)).toBe(0);
  });

  it("is the largest single-corner displacement", () => {
    expect(cornerDrift(QUAD_A, QUAD_A_JITTERED)).toBe(3);
  });
});

describe("isQuadStable", () => {
  const options = { requiredDurationMs: 1000, maxDriftPx: 5 };

  it("is false with no history", () => {
    expect(isQuadStable([], options)).toBe(false);
  });

  it("is false when the latest sample has no detection", () => {
    const history: DetectionSample[] = [{ corners: null, atMs: 1000 }];
    expect(isQuadStable(history, options)).toBe(false);
  });

  it("is false when history does not yet span the required duration", () => {
    const history: DetectionSample[] = [
      { corners: QUAD_A, atMs: 800 },
      { corners: QUAD_A, atMs: 1000 },
    ];
    expect(isQuadStable(history, options)).toBe(false);
  });

  it("is true once every sample in the window is within the drift tolerance", () => {
    const history: DetectionSample[] = [
      { corners: QUAD_A, atMs: 0 },
      { corners: QUAD_A_JITTERED, atMs: 400 },
      { corners: QUAD_A, atMs: 800 },
      { corners: QUAD_A_JITTERED, atMs: 1000 },
    ];
    expect(isQuadStable(history, options)).toBe(true);
  });

  it("is false when a sample inside the window missed detection", () => {
    const history: DetectionSample[] = [
      { corners: QUAD_A, atMs: 0 },
      { corners: null, atMs: 400 },
      { corners: QUAD_A, atMs: 800 },
      { corners: QUAD_A, atMs: 1000 },
    ];
    expect(isQuadStable(history, options)).toBe(false);
  });

  it("is false when the quad moved during the window", () => {
    const history: DetectionSample[] = [
      { corners: QUAD_A, atMs: 0 },
      { corners: QUAD_B, atMs: 400 },
      { corners: QUAD_A, atMs: 800 },
      { corners: QUAD_A, atMs: 1000 },
    ];
    expect(isQuadStable(history, options)).toBe(false);
  });

  it("ignores samples older than the required window", () => {
    const history: DetectionSample[] = [
      { corners: QUAD_B, atMs: -5000 }, // ancient, unrelated jump - outside the window
      { corners: QUAD_A, atMs: 0 },
      { corners: QUAD_A, atMs: 1000 },
    ];
    expect(isQuadStable(history, options)).toBe(true);
  });
});

describe("pruneHistory", () => {
  it("drops samples older than the required duration", () => {
    const history: DetectionSample[] = [
      { corners: QUAD_A, atMs: 0 },
      { corners: QUAD_A, atMs: 500 },
      { corners: QUAD_A, atMs: 1000 },
    ];
    expect(pruneHistory(history, 600, 1000)).toEqual([
      { corners: QUAD_A, atMs: 500 },
      { corners: QUAD_A, atMs: 1000 },
    ]);
  });

  it("always keeps at least the latest sample", () => {
    const history: DetectionSample[] = [{ corners: QUAD_A, atMs: 0 }];
    expect(pruneHistory(history, 100, 10_000)).toEqual([{ corners: QUAD_A, atMs: 0 }]);
  });

  it("returns an empty array for an empty history", () => {
    expect(pruneHistory([], 1000, 0)).toEqual([]);
  });
});
