import { describe, expect, it } from "vitest";
import { testsRule } from "../rules/tests";
import { runFixture } from "./helpers";

describe("tests rule", () => {
  it("passes correctly-suffixed, correctly-placed test files", () => {
    expect(runFixture(testsRule, "tests-rule", "good")).toEqual([]);
  });

  it("flags a .test.ts file that is not under any tests/ segment", () => {
    const violations = runFixture(testsRule, "tests-rule", "bad");
    expect(violations.some((v) => v.file === "src/modules/foo/core/bar.test.ts")).toBe(true);
  });
});
