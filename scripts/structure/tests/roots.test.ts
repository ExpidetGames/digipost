import { describe, expect, it } from "vitest";
import { rootsRule } from "../rules/roots";
import { runFixture } from "./helpers";

describe("roots rule", () => {
  it("passes a tree with only declared top-level entries", () => {
    expect(runFixture(rootsRule, "roots", "good")).toEqual([]);
  });

  it("flags an undeclared top-level entry", () => {
    const violations = runFixture(rootsRule, "roots", "bad");
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => v.file === "scratch")).toBe(true);
  });

  it("flags an undeclared entry inside a governed root (src/ declares its children)", () => {
    const violations = runFixture(rootsRule, "roots", "bad");
    expect(violations.some((v) => v.file === "src/lib")).toBe(true);
    expect(violations.some((v) => v.file === "src/app")).toBe(false);
  });
});
