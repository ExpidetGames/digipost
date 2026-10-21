import { describe, expect, it } from "vitest";
import { directionRule } from "../rules/direction";
import { runFixture } from "./helpers";

describe("direction rule", () => {
  it("passes an edge the matrix allows", () => {
    expect(runFixture(directionRule, "direction", "good")).toEqual([]);
  });

  it("flags an edge the matrix does not allow", () => {
    const violations = runFixture(directionRule, "direction", "bad");
    expect(violations.some((v) => v.file === "src/modules/foo/index.ts" && v.message.includes("may not import"))).toBe(true);
  });
});
