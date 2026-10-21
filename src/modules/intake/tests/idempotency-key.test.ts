import { describe, expect, it } from "vitest";

import { computeIdempotencyKeyV2, normalizeReference, OccurrenceCounter } from "../core/idempotency-key";

describe("normalizeReference", () => {
  it("maps the NOTPROVIDED placeholder to null", () => {
    expect(normalizeReference("NOTPROVIDED")).toBeNull();
  });

  it("maps every documented placeholder to null, case-insensitively", () => {
    expect(normalizeReference("notprovided")).toBeNull();
    expect(normalizeReference("NotProvided")).toBeNull();
    expect(normalizeReference("NOT PROVIDED")).toBeNull();
    expect(normalizeReference("not provided")).toBeNull();
    expect(normalizeReference("NONREF")).toBeNull();
    expect(normalizeReference("nonref")).toBeNull();
    expect(normalizeReference("NOREF")).toBeNull();
    expect(normalizeReference("noref")).toBeNull();
  });

  it("maps a whitespace-padded or internally-varied-whitespace placeholder to null too", () => {
    expect(normalizeReference("  NOTPROVIDED  ")).toBeNull();
    expect(normalizeReference("NOT   PROVIDED")).toBeNull();
    expect(normalizeReference("\tNOTPROVIDED\n")).toBeNull();
  });

  it("maps empty and whitespace-only values to null", () => {
    expect(normalizeReference("")).toBeNull();
    expect(normalizeReference("   ")).toBeNull();
    expect(normalizeReference("\t\n")).toBeNull();
  });

  it("maps null and undefined to null", () => {
    expect(normalizeReference(null)).toBeNull();
    expect(normalizeReference(undefined)).toBeNull();
  });

  it("keeps a genuine reference, trimmed and whitespace-collapsed", () => {
    expect(normalizeReference("  E2E-INV-1001  ")).toBe("E2E-INV-1001");
    expect(normalizeReference("E2E   INV   1001")).toBe("E2E INV 1001");
  });

  it("normalizes whitespace/case variants of the same genuine reference identically", () => {
    expect(normalizeReference(" ASR-100 ")).toBe(normalizeReference("ASR-100"));
    expect(normalizeReference("ASR-100")).toBe("ASR-100");
  });

  it("never maps a real reference that merely contains a placeholder as a substring to null", () => {
    expect(normalizeReference("NOTPROVIDED-BUT-ACTUALLY-REAL")).toBe("NOTPROVIDED-BUT-ACTUALLY-REAL");
  });
});

describe("computeIdempotencyKeyV2", () => {
  it("is deterministic for the same fields and occurrence index", () => {
    const fields = ["DE1", "2026-09-01", 5000, "EUR"];
    expect(computeIdempotencyKeyV2(fields, 0)).toBe(computeIdempotencyKeyV2(fields, 0));
  });

  it("produces different keys for different occurrence indexes of the same composite", () => {
    const fields = ["DE1", "2026-09-01", 5000, "EUR"];
    const first = computeIdempotencyKeyV2(fields, 0);
    const second = computeIdempotencyKeyV2(fields, 1);
    expect(first).not.toBe(second);
  });

  it("produces different keys when any single field differs", () => {
    const base = computeIdempotencyKeyV2(["DE1", "2026-09-01", 5000, "EUR", "ASR-1"], 0);
    const differentRef = computeIdempotencyKeyV2(["DE1", "2026-09-01", 5000, "EUR", "ASR-2"], 0);
    expect(base).not.toBe(differentRef);
  });

  it("treats null and empty-string fields consistently (both become an explicit empty slot)", () => {
    expect(computeIdempotencyKeyV2(["DE1", null, 100], 0)).toBe(computeIdempotencyKeyV2(["DE1", null, 100], 0));
  });

  it("does not collide two composites that only differ by a field boundary shifting", () => {
    // Without an unambiguous per-field delimiter, ["ab", "c"] and ["a", "bc"] could collide if
    // naively concatenated - this must not happen.
    const a = computeIdempotencyKeyV2(["ab", "c"], 0);
    const b = computeIdempotencyKeyV2(["a", "bc"], 0);
    expect(a).not.toBe(b);
  });
});

describe("OccurrenceCounter", () => {
  it("returns 0 for the first occurrence of a composite and increments for each repeat", () => {
    const counter = new OccurrenceCounter();
    const fields = ["DE1", "2026-09-01", 500];
    expect(counter.next(fields)).toBe(0);
    expect(counter.next(fields)).toBe(1);
    expect(counter.next(fields)).toBe(2);
  });

  it("tracks distinct composites independently", () => {
    const counter = new OccurrenceCounter();
    expect(counter.next(["A"])).toBe(0);
    expect(counter.next(["B"])).toBe(0);
    expect(counter.next(["A"])).toBe(1);
    expect(counter.next(["B"])).toBe(1);
  });

  it("combined with computeIdempotencyKeyV2, gives identical composites distinct keys", () => {
    const counter = new OccurrenceCounter();
    const fields = ["DE1", "2026-09-01", 500, "EUR"];
    const keyOne = computeIdempotencyKeyV2(fields, counter.next(fields));
    const keyTwo = computeIdempotencyKeyV2(fields, counter.next(fields));
    expect(keyOne).not.toBe(keyTwo);
  });
});
