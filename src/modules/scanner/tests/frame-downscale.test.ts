import { describe, expect, it } from "vitest";

import { computeDownscaleSize } from "../core/frame-downscale";

describe("computeDownscaleSize", () => {
  const cases: Array<{ name: string; width: number; height: number; max: number; expected: { width: number; height: number; scale: number } }> = [
    { name: "already below max (landscape)", width: 640, height: 480, max: 800, expected: { width: 640, height: 480, scale: 1 } },
    { name: "exactly at max", width: 800, height: 600, max: 800, expected: { width: 800, height: 600, scale: 1 } },
    { name: "downscales landscape", width: 1920, height: 1080, max: 640, expected: { width: 640, height: 360, scale: 640 / 1920 } },
    { name: "downscales portrait (long edge is height)", width: 1080, height: 1920, max: 640, expected: { width: 360, height: 640, scale: 640 / 1920 } },
    { name: "zero dimensions pass through", width: 0, height: 0, max: 640, expected: { width: 0, height: 0, scale: 1 } },
  ];

  it.each(cases)("$name", ({ width, height, max, expected }) => {
    const result = computeDownscaleSize(width, height, max);
    expect(result.width).toBe(expected.width);
    expect(result.height).toBe(expected.height);
    expect(result.scale).toBeCloseTo(expected.scale, 5);
  });

  it("never scales up", () => {
    const result = computeDownscaleSize(200, 100, 2000);
    expect(result).toEqual({ width: 200, height: 100, scale: 1 });
  });
});
