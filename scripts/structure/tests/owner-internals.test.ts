import { describe, expect, it } from "vitest";
import { ownerInternalsRule } from "../rules/owner-internals";
import { runFixture } from "./helpers";

describe("owner-internals rule", () => {
  it("passes an owner using only allowed/precise directory names", () => {
    expect(runFixture(ownerInternalsRule, "owner-internals", "good")).toEqual([]);
  });

  it("flags a forbidden directory name at any depth", () => {
    const violations = runFixture(ownerInternalsRule, "owner-internals", "bad");
    expect(violations.some((v) => v.file === "src/modules/foo/utils" && v.message.includes("forbidden"))).toBe(true);
  });
});
