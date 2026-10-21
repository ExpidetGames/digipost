import { describe, expect, it } from "vitest";

import { scaleCorners, scalePoint } from "../core/coordinate-mapping";
import type { CornerPoints } from "../core/types";

describe("scalePoint", () => {
  it("scales a point from one pixel space to another", () => {
    expect(scalePoint({ x: 100, y: 50 }, { width: 200, height: 100 }, { width: 400, height: 200 })).toEqual({
      x: 200,
      y: 100,
    });
  });

  it("scales down as well as up", () => {
    expect(scalePoint({ x: 400, y: 200 }, { width: 400, height: 200 }, { width: 100, height: 50 })).toEqual({
      x: 100,
      y: 50,
    });
  });

  it("treats a zero-size source as an identity mapping (never divides by zero)", () => {
    expect(scalePoint({ x: 10, y: 10 }, { width: 0, height: 0 }, { width: 400, height: 200 })).toEqual({
      x: 10,
      y: 10,
    });
  });
});

describe("scaleCorners", () => {
  it("scales every corner", () => {
    const corners: CornerPoints = {
      topLeft: { x: 0, y: 0 },
      topRight: { x: 100, y: 0 },
      bottomRight: { x: 100, y: 100 },
      bottomLeft: { x: 0, y: 100 },
    };
    expect(scaleCorners(corners, { width: 100, height: 100 }, { width: 200, height: 50 })).toEqual({
      topLeft: { x: 0, y: 0 },
      topRight: { x: 200, y: 0 },
      bottomRight: { x: 200, y: 50 },
      bottomLeft: { x: 0, y: 50 },
    });
  });
});
