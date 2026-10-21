import { describe, expect, it } from "vitest";

import { computeBackoffMs } from "@/platform/jobs";

describe("computeBackoffMs", () => {
  it("returns the base delay for the first attempt with no jitter", () => {
    expect(computeBackoffMs(1, { baseMs: 1000, random: () => 1 })).toBe(1000);
  });

  it("doubles for each subsequent attempt", () => {
    const random = () => 1; // no jitter reduction: exact exponential value
    expect(computeBackoffMs(2, { baseMs: 1000, random })).toBe(2000);
    expect(computeBackoffMs(3, { baseMs: 1000, random })).toBe(4000);
    expect(computeBackoffMs(4, { baseMs: 1000, random })).toBe(8000);
  });

  it("never exceeds maxMs even for a large attempt count", () => {
    expect(computeBackoffMs(20, { baseMs: 1000, maxMs: 10_000, random: () => 1 })).toBe(10_000);
  });

  it("applies half-jitter: result is between 50% and 100% of the exponential value", () => {
    const exponential = 1000 * 2 ** (5 - 1); // attempt 5
    expect(computeBackoffMs(5, { baseMs: 1000, random: () => 0 })).toBe(Math.round(exponential * 0.5));
    expect(computeBackoffMs(5, { baseMs: 1000, random: () => 0.999999 })).toBeLessThanOrEqual(exponential);
  });

  it("treats attempt 0 or negative the same as attempt 1", () => {
    const random = () => 1;
    expect(computeBackoffMs(0, { baseMs: 1000, random })).toBe(1000);
    expect(computeBackoffMs(-3, { baseMs: 1000, random })).toBe(1000);
  });

  // decisions/0042: provider limits are per minute, so the first retry waits 15 to 30 seconds and
  // the growth caps at 10 minutes.
  it("uses sensible defaults when no options are given", () => {
    const first = computeBackoffMs(1, { random: () => 0 });
    expect(first).toBe(15_000);
    expect(computeBackoffMs(1, { random: () => 0.999 })).toBeLessThanOrEqual(30_000);
    expect(computeBackoffMs(20, { random: () => 0.999 })).toBeLessThanOrEqual(10 * 60_000);
  });
});
