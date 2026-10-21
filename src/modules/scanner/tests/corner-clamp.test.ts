import { describe, expect, it } from "vitest";

import { clampCorners, clampPoint, defaultInsetCorners } from "../core/corner-clamp";
import type { CornerPoints } from "../core/types";

describe("clampPoint", () => {
  it.each([
    { point: { x: -10, y: 5 }, bounds: { width: 100, height: 100 }, expected: { x: 0, y: 5 } },
    { point: { x: 5, y: -10 }, bounds: { width: 100, height: 100 }, expected: { x: 5, y: 0 } },
    { point: { x: 150, y: 50 }, bounds: { width: 100, height: 100 }, expected: { x: 100, y: 50 } },
    { point: { x: 50, y: 150 }, bounds: { width: 100, height: 100 }, expected: { x: 50, y: 100 } },
    { point: { x: 50, y: 50 }, bounds: { width: 100, height: 100 }, expected: { x: 50, y: 50 } },
  ])("clamps $point within $bounds", ({ point, bounds, expected }) => {
    expect(clampPoint(point, bounds)).toEqual(expected);
  });
});

describe("clampCorners", () => {
  it("clamps every corner independently", () => {
    const corners: CornerPoints = {
      topLeft: { x: -5, y: -5 },
      topRight: { x: 105, y: -5 },
      bottomRight: { x: 105, y: 105 },
      bottomLeft: { x: -5, y: 105 },
    };
    expect(clampCorners(corners, { width: 100, height: 100 })).toEqual({
      topLeft: { x: 0, y: 0 },
      topRight: { x: 100, y: 0 },
      bottomRight: { x: 100, y: 100 },
      bottomLeft: { x: 0, y: 100 },
    });
  });

  it("leaves corners already inside the bounds untouched", () => {
    const corners: CornerPoints = {
      topLeft: { x: 10, y: 10 },
      topRight: { x: 90, y: 10 },
      bottomRight: { x: 90, y: 90 },
      bottomLeft: { x: 10, y: 90 },
    };
    expect(clampCorners(corners, { width: 100, height: 100 })).toEqual(corners);
  });
});

describe("defaultInsetCorners", () => {
  it("insets by 10% on each side by default", () => {
    expect(defaultInsetCorners({ width: 200, height: 100 })).toEqual({
      topLeft: { x: 20, y: 10 },
      topRight: { x: 180, y: 10 },
      bottomRight: { x: 180, y: 90 },
      bottomLeft: { x: 20, y: 90 },
    });
  });

  it("accepts a custom inset ratio", () => {
    expect(defaultInsetCorners({ width: 200, height: 200 }, 0.25)).toEqual({
      topLeft: { x: 50, y: 50 },
      topRight: { x: 150, y: 50 },
      bottomRight: { x: 150, y: 150 },
      bottomLeft: { x: 50, y: 150 },
    });
  });
});
