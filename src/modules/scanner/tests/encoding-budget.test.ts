import { describe, expect, it } from "vitest";

import {
  hasMoreEncodingAttempts,
  INITIAL_ENCODING_ATTEMPT,
  nextEncodingAttempt,
  perPageByteBudget,
} from "../core/encoding-budget";

describe("nextEncodingAttempt", () => {
  it("lowers quality in 0.1 steps before touching resolution", () => {
    const step1 = nextEncodingAttempt(INITIAL_ENCODING_ATTEMPT);
    expect(step1).toEqual({ quality: 0.7, maxLongEdgePx: 2000 });

    const step2 = nextEncodingAttempt(step1);
    expect(step2).toEqual({ quality: 0.6, maxLongEdgePx: 2000 });
  });

  it("clamps quality at the 0.35 floor instead of overshooting below it", () => {
    // 0.4 - 0.1 = 0.3, which is below MIN_QUALITY (0.35): clamped to 0.35, not 0.3.
    const nearFloor = nextEncodingAttempt({ quality: 0.4, maxLongEdgePx: 2000 });
    expect(nearFloor).toEqual({ quality: 0.35, maxLongEdgePx: 2000 });
  });

  it("shrinks the long edge only once quality is at its floor", () => {
    const result = nextEncodingAttempt({ quality: 0.35, maxLongEdgePx: 2000 });
    expect(result.quality).toBe(0.35);
    expect(result.maxLongEdgePx).toBe(1700);
  });

  it("floors the long edge at 800px", () => {
    const result = nextEncodingAttempt({ quality: 0.35, maxLongEdgePx: 850 });
    expect(result.maxLongEdgePx).toBe(800);
  });

  it("is a no-op once both quality and long edge are at their floor", () => {
    const floor = { quality: 0.35, maxLongEdgePx: 800 };
    expect(nextEncodingAttempt(floor)).toEqual(floor);
  });

  it("changes exactly one dimension per call", () => {
    let attempt = INITIAL_ENCODING_ATTEMPT;
    for (let i = 0; i < 10; i++) {
      const next = nextEncodingAttempt(attempt);
      const qualityChanged = next.quality !== attempt.quality;
      const edgeChanged = next.maxLongEdgePx !== attempt.maxLongEdgePx;
      expect(qualityChanged !== edgeChanged || (!qualityChanged && !edgeChanged)).toBe(true);
      expect(qualityChanged && edgeChanged).toBe(false);
      attempt = next;
    }
  });

  it("converges monotonically to the floor without oscillating", () => {
    let attempt: { quality: number; maxLongEdgePx: number } = INITIAL_ENCODING_ATTEMPT;
    let previousQuality = attempt.quality;
    let previousEdge = attempt.maxLongEdgePx;
    for (let i = 0; i < 30; i++) {
      attempt = nextEncodingAttempt(attempt);
      expect(attempt.quality).toBeLessThanOrEqual(previousQuality);
      expect(attempt.maxLongEdgePx).toBeLessThanOrEqual(previousEdge);
      previousQuality = attempt.quality;
      previousEdge = attempt.maxLongEdgePx;
    }
    expect(attempt).toEqual({ quality: 0.35, maxLongEdgePx: 800 });
  });
});

describe("hasMoreEncodingAttempts", () => {
  it("is true above the floor", () => {
    expect(hasMoreEncodingAttempts(INITIAL_ENCODING_ATTEMPT)).toBe(true);
  });

  it("is false exactly at the floor", () => {
    expect(hasMoreEncodingAttempts({ quality: 0.35, maxLongEdgePx: 800 })).toBe(false);
  });
});

describe("perPageByteBudget", () => {
  it("splits the total evenly across pages, minus a fixed overhead allowance", () => {
    const total = 4 * 1024 * 1024;
    expect(perPageByteBudget(total, 1)).toBe(total - 4096);
    expect(perPageByteBudget(total, 4)).toBe(Math.floor((total - 4096) / 4));
  });

  it("returns the total unchanged for zero or negative page counts", () => {
    const total = 4 * 1024 * 1024;
    expect(perPageByteBudget(total, 0)).toBe(total);
    expect(perPageByteBudget(total, -1)).toBe(total);
  });

  it("never goes negative even for a tiny budget with many pages", () => {
    expect(perPageByteBudget(1000, 20)).toBe(0);
  });
});
