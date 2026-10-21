import { describe, expect, it } from "vitest";
import { e2eRule } from "../rules/e2e";
import { runFixture } from "./helpers";

describe("e2e rule", () => {
  it("passes a spec that only imports its own helpers", () => {
    expect(runFixture(e2eRule, "e2e-rule", "good")).toEqual([]);
  });

  it("flags a spec that resolves into a forbidden root", () => {
    const violations = runFixture(e2eRule, "e2e-rule", "bad");
    expect(violations.some((v) => v.file === "tests/e2e/bad.spec.ts" && v.message.includes("forbidden root"))).toBe(true);
  });
});
